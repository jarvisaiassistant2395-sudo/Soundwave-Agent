import { spawn, type ChildProcess } from "node:child_process";

/**
 * JavaScript runtime for yt-dlp's YouTube challenge solver (yt-dlp-ejs).
 *
 * yt-dlp only enables Deno by default, so Soundwave also offers Node:
 *
 *  - Server on plain Node → this very Node binary, by absolute path, so PATH
 *    order can't substitute an older node (yt-dlp accepts Node 22+).
 *  - Desktop app (Electron) → process.execPath is the app itself, which runs
 *    as plain Node when ELECTRON_RUN_AS_NODE=1 is in its environment. yt-dlp
 *    gets the app binary as `node` plus that variable (inherited by the node
 *    processes yt-dlp spawns), so customers need no Node install. The build is
 *    probed once with the exact commands yt-dlp will run; if it can't act as
 *    Node (e.g. the RunAsNode fuse was disabled), fall back to a node on PATH.
 *
 * Deliberately dependency-free: desktop/verify-runtime.mjs imports the built
 * copy to run this same probe against the packaged Windows exe in CI.
 */

export interface YtDlpJsRuntime {
  /** `--js-runtimes …` arguments for yt-dlp. */
  args: string[];
  /** Extra environment for the yt-dlp process (inherited by its JS runtime). */
  env: Record<string, string>;
  /** Human-readable summary for logs. */
  label: string;
}

export interface RunAsNodeProbe {
  ok: boolean;
  /** What `--version` printed, e.g. "v24.9.0". */
  version?: string;
  reason?: string;
}

interface RuntimeInfo {
  execPath?: string;
  /** process.versions.electron — set only inside Electron. */
  electron?: string;
}

/** Electron's switch to behave as plain Node (checked at process start). */
export const RUN_AS_NODE_ENV: Readonly<Record<string, string>> = Object.freeze({ ELECTRON_RUN_AS_NODE: "1" });

/** yt-dlp's NodeJsRuntime.MIN_SUPPORTED_VERSION is (22, 0, 0). */
const MIN_NODE_MAJOR = 22;

/**
 * `--js-runtimes` arguments. The own binary is used when it is plain Node, or
 * an Electron build verified to run as Node; otherwise a `node` on PATH.
 * yt-dlp splits `node:PATH` at the first colon only, so Windows drive letters
 * are safe, and it uses a file path as-is (the exe need not be node.exe).
 */
export function jsRuntimeArgs(runtime: RuntimeInfo & { electronRunsAsNode?: boolean }): string[] {
  const ownBinary = Boolean(runtime.execPath) && (!runtime.electron || runtime.electronRunsAsNode === true);
  const node = ownBinary ? `node:${runtime.execPath}` : "node";
  // Comma-joined values are rejected; yt-dlp wants one flag per runtime.
  return ["--js-runtimes", node, "--js-runtimes", "deno"];
}

interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function capture(
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; input: string; timeoutMs: number },
): Promise<Captured> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", error: (e as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: Captured) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, error: `timed out after ${Math.round(opts.timeoutMs / 1000)}s` });
    }, opts.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => finish({ code: null, stdout, stderr, error: e.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin?.on("error", () => {
      /* EPIPE when the process exits before reading its input */
    });
    child.stdin?.end(opts.input);
  });
}

/** yt-dlp ignores these stderr lines from node (NodeJCP._clean_stderr); anything else fails the solve. */
function cleanNodeStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\[stdin\]:/.test(line) &&
        !/^var jsc/.test(line) &&
        line !== "(Use `node --trace-uncaught ...` to show where the exception was thrown)" &&
        !/^Node\.js v\d+\.\d+\.\d+$/.test(line),
    )
    .join("\n")
    .trim();
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";
}

// The solver arrives on stdin as one large script (~2 MB of player JS), so the
// probe pushes a sizeable payload through the pipe as well.
const PROBE_SCRIPT = `/*${"x".repeat(512 * 1024)}*/\nprocess.stdout.write(JSON.stringify({ sum: [3, 4, 5].reduce((a, b) => a + b, 0) }));\n`;
const PROBE_EXPECTED = '{"sum":12}';

/**
 * Check that `execPath` works as yt-dlp's `node` with ELECTRON_RUN_AS_NODE=1,
 * replaying what yt-dlp does: `<node> --version` must print v22+, then the
 * challenge script runs as `<node> --permission -` (or the experimental flags
 * before Node 23.5) and must answer on stdout with nothing on stderr.
 */
export async function probeElectronRunAsNode(
  execPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<RunAsNodeProbe> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const env = { ...process.env, ...RUN_AS_NODE_ENV };

  const ver = await capture(execPath, ["--version"], { env, input: "", timeoutMs });
  if (ver.error) return { ok: false, reason: `\`--version\` ${ver.error}` };
  const version = ver.stdout.trim();
  const m = /^v(\d+)\.(\d+)/.exec(version);
  if (ver.code !== 0 || !m || ver.stderr.trim()) {
    const got = firstLine(ver.stdout + ver.stderr) || "no output";
    return { ok: false, version: version || undefined, reason: `\`--version\` did not print a Node version (exit ${ver.code}: ${got})` };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < MIN_NODE_MAJOR) {
    return { ok: false, version, reason: `Node ${version} is older than the ${MIN_NODE_MAJOR}.0 yt-dlp requires` };
  }

  // Node's permission flag became stable in 23.5.0 — yt-dlp picks flags the same way.
  const permission =
    major > 23 || (major === 23 && minor >= 5) ? ["--permission"] : ["--experimental-permission", "--no-warnings=ExperimentalWarning"];
  const run = await capture(execPath, [...permission, "-"], { env, input: PROBE_SCRIPT, timeoutMs });
  if (run.error) return { ok: false, version, reason: `running a script ${run.error}` };
  const stderr = cleanNodeStderr(run.stderr);
  if (run.code !== 0 || stderr) {
    return { ok: false, version, reason: `running a script failed (exit ${run.code}${stderr ? `: ${firstLine(stderr)}` : ""})` };
  }
  if (run.stdout.trim() !== PROBE_EXPECTED) {
    return { ok: false, version, reason: `running a script printed ${JSON.stringify(firstLine(run.stdout))} instead of ${PROBE_EXPECTED}` };
  }
  return { ok: true, version };
}

let cached: { key: string; promise: Promise<YtDlpJsRuntime> } | null = null;

/** The JS runtime every yt-dlp call gets (memoized — the Electron probe runs once). */
export function ytDlpJsRuntime(
  runtime: RuntimeInfo = { execPath: process.execPath, electron: process.versions.electron },
): Promise<YtDlpJsRuntime> {
  const key = `${runtime.execPath ?? ""}|${runtime.electron ?? ""}`;
  if (cached?.key === key) return cached.promise;

  const promise = (async (): Promise<YtDlpJsRuntime> => {
    if (!runtime.electron || !runtime.execPath) {
      return { args: jsRuntimeArgs(runtime), env: {}, label: `Node ${process.versions.node}` };
    }
    const probe = await probeElectronRunAsNode(runtime.execPath).catch(
      (e: unknown): RunAsNodeProbe => ({ ok: false, reason: (e as Error)?.message ?? String(e) }),
    );
    if (probe.ok) {
      const label = `this app running as Node ${probe.version} (Electron ${runtime.electron})`;
      console.log(`[yt-dlp] JavaScript runtime: ${label}`);
      return { args: jsRuntimeArgs({ ...runtime, electronRunsAsNode: true }), env: { ...RUN_AS_NODE_ENV }, label };
    }
    const label = `node/deno from PATH, if installed — this app can't run as Node here: ${probe.reason}`;
    console.warn(`[yt-dlp] JavaScript runtime: ${label}`);
    return { args: jsRuntimeArgs(runtime), env: {}, label };
  })();

  cached = { key, promise };
  return promise;
}

export function _resetJsRuntimeForTests(): void {
  cached = null;
}
