import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Electron binary is replaced by a scripted child that reads its stdin
// like a real process, so these tests pin down exactly what yt-dlp's `node`
// (the desktop app running as Node) is asked to do.
type Reply = { code?: number | null; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException; hang?: boolean };
type Spawned = { command: string; args: string[]; env?: NodeJS.ProcessEnv; stdin: string };
const fake = vi.hoisted(() => ({
  spawns: [] as Spawned[],
  reply: (_args: string[]): Reply => ({ code: 0 }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const record: Spawned = { command, args, env: options?.env, stdin: "" };
      fake.spawns.push(record);
      const stdin = new PassThrough();
      stdin.on("data", (d: Buffer) => (record.stdin += d.toString()));
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      const r = fake.reply(args);
      // Answer once the whole input has been read, like `node -` does.
      stdin.on("finish", () =>
        setImmediate(() => {
          if (r.error) return void child.emit("error", r.error);
          if (r.hang) return;
          if (r.stdout) child.stdout.write(r.stdout);
          if (r.stderr) child.stderr.write(r.stderr);
          setImmediate(() => child.emit("close", r.code ?? 0));
        }),
      );
      return child;
    }),
  };
});

const { probeElectronRunAsNode, ytDlpJsRuntime, jsRuntimeArgs, _resetJsRuntimeForTests } = await import("../src/lib/jsRuntime.js");

const APP_EXE = "C:\\Users\\me\\AppData\\Local\\Programs\\Soundwave AI\\Soundwave AI.exe";
const OK_SCRIPT = { code: 0, stdout: '{"sum":12}' };

/** Replies for `--version` and for the script run. */
function electron(version: string, script: Reply = OK_SCRIPT) {
  return (args: string[]): Reply => (args.includes("--version") ? { code: 0, stdout: `${version}\n` } : script);
}

beforeEach(() => {
  fake.spawns.length = 0;
  _resetJsRuntimeForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probeElectronRunAsNode", () => {
  it("accepts an Electron build that runs as Node 22+, replaying exactly what yt-dlp does", async () => {
    fake.reply = electron("v24.9.0");
    await expect(probeElectronRunAsNode(APP_EXE)).resolves.toEqual({ ok: true, version: "v24.9.0" });

    expect(fake.spawns.map((s) => [s.command, s.args])).toEqual([
      [APP_EXE, ["--version"]],
      [APP_EXE, ["--permission", "-"]], // yt-dlp's NodeJCP for Node >= 23.5
    ]);
    for (const s of fake.spawns) expect(s.env?.ELECTRON_RUN_AS_NODE).toBe("1");
    // The solver script arrives on stdin and is large (~2 MB in real use).
    expect(fake.spawns[1]!.stdin.length).toBeGreaterThan(512 * 1024);
    expect(fake.spawns[1]!.stdin).toContain("process.stdout.write");
  });

  it("uses the experimental permission flags before Node 23.5, like yt-dlp", async () => {
    for (const [version, flags] of [
      ["v22.20.0", ["--experimental-permission", "--no-warnings=ExperimentalWarning"]],
      ["v23.4.0", ["--experimental-permission", "--no-warnings=ExperimentalWarning"]],
      ["v23.5.0", ["--permission"]],
    ] as const) {
      fake.spawns.length = 0;
      fake.reply = electron(version);
      await expect(probeElectronRunAsNode(APP_EXE)).resolves.toMatchObject({ ok: true, version });
      expect(fake.spawns[1]!.args).toEqual([...flags, "-"]);
    }
  });

  it("rejects a build that starts the app instead of acting as Node (RunAsNode fuse off)", async () => {
    // The second instance hits the single-instance lock and quits silently.
    fake.reply = () => ({ code: 0 });
    const probe = await probeElectronRunAsNode(APP_EXE);
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("did not print a Node version");
    expect(fake.spawns).toHaveLength(1);
  });

  it("rejects Node older than 22, which yt-dlp would refuse", async () => {
    fake.reply = electron("v20.18.3");
    const probe = await probeElectronRunAsNode(APP_EXE);
    expect(probe).toMatchObject({ ok: false, version: "v20.18.3" });
    expect(probe.reason).toContain("older than the 22.0");
  });

  it("rejects a build whose Node lacks the permission flag", async () => {
    fake.reply = electron("v24.9.0", { code: 9, stderr: "Soundwave AI.exe: bad option: --permission\n" });
    const probe = await probeElectronRunAsNode(APP_EXE);
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("bad option: --permission");
  });

  it("treats stderr output as a failed solve (as yt-dlp does), except the lines yt-dlp ignores", async () => {
    fake.reply = electron("v24.9.0", { code: 0, stdout: '{"sum":12}', stderr: "(node:4242) Warning: something odd\n" });
    expect((await probeElectronRunAsNode(APP_EXE)).ok).toBe(false);

    fake.reply = electron("v24.9.0", { code: 0, stdout: '{"sum":12}', stderr: "Node.js v24.9.0\n" });
    expect((await probeElectronRunAsNode(APP_EXE)).ok).toBe(true);
  });

  it("rejects wrong script output", async () => {
    fake.reply = electron("v24.9.0", { code: 0, stdout: "" });
    const probe = await probeElectronRunAsNode(APP_EXE);
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain('instead of {"sum":12}');
  });

  it("survives a missing binary and a hung process", async () => {
    fake.reply = () => ({ error: Object.assign(new Error("spawn Soundwave AI.exe ENOENT"), { code: "ENOENT" }) });
    const missing = await probeElectronRunAsNode(APP_EXE);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("ENOENT");

    fake.reply = () => ({ hang: true });
    const hung = await probeElectronRunAsNode(APP_EXE, { timeoutMs: 30 });
    expect(hung.ok).toBe(false);
    expect(hung.reason).toContain("timed out");
  });
});

describe("ytDlpJsRuntime", () => {
  it("plain Node: this Node binary, no probe, no extra environment", async () => {
    const runtime = await ytDlpJsRuntime({ execPath: "/usr/local/bin/node" });
    expect(runtime.args).toEqual(["--js-runtimes", "node:/usr/local/bin/node", "--js-runtimes", "deno"]);
    expect(runtime.env).toEqual({});
    expect(fake.spawns).toHaveLength(0);
  });

  it("desktop app: the app itself as Node once the probe passes — probed only once", async () => {
    fake.reply = electron("v24.9.0");
    const runtime = await ytDlpJsRuntime({ execPath: APP_EXE, electron: "44.4.5" });
    expect(runtime.args).toEqual(["--js-runtimes", `node:${APP_EXE}`, "--js-runtimes", "deno"]);
    expect(runtime.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(runtime.label).toContain("Node v24.9.0");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("this app running as Node v24.9.0 (Electron 44.4.5)"));

    await ytDlpJsRuntime({ execPath: APP_EXE, electron: "44.4.5" });
    expect(fake.spawns).toHaveLength(2);
  });

  it("desktop app: falls back to a node/deno on PATH when the app can't run as Node", async () => {
    fake.reply = () => ({ code: 0 });
    const runtime = await ytDlpJsRuntime({ execPath: APP_EXE, electron: "44.4.5" });
    expect(runtime.args).toEqual(["--js-runtimes", "node", "--js-runtimes", "deno"]);
    expect(runtime.env).toEqual({});
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("can't run as Node here"));
  });
});

describe("jsRuntimeArgs", () => {
  it("passes the exact Node binary, Windows drive letter included", () => {
    expect(jsRuntimeArgs({ execPath: "C:\\Program Files\\nodejs\\node.exe" })).toEqual([
      "--js-runtimes",
      "node:C:\\Program Files\\nodejs\\node.exe",
      "--js-runtimes",
      "deno",
    ]);
  });

  it("inside Electron, uses the app binary only once it is known to run as Node", () => {
    const exe = "C:\\Program Files\\Soundwave AI\\Soundwave AI.exe";
    expect(jsRuntimeArgs({ execPath: exe, electron: "44.4.5" })).toEqual(["--js-runtimes", "node", "--js-runtimes", "deno"]);
    expect(jsRuntimeArgs({ execPath: exe, electron: "44.4.5", electronRunsAsNode: true })).toEqual([
      "--js-runtimes",
      `node:${exe}`,
      "--js-runtimes",
      "deno",
    ]);
  });
});
