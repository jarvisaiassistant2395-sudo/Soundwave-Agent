// Verify the PACKAGED app can serve as yt-dlp's JavaScript runtime — the very
// probe the app runs at startup (server/src/lib/jsRuntime.ts, imported from
// the assembled build) — and that the packaged yt-dlp picks it up for a real
// YouTube extraction. Run after electron-builder (CI does, on Windows):
//
//   node verify-runtime.mjs ["release/win-unpacked/Soundwave AI.exe"]
//
// Fails when the exe can't act as Node (e.g. the RunAsNode fuse got disabled)
// or when yt-dlp can't use it. YouTube itself refusing the CI machine (bot
// checks are common on datacenter IPs) is reported but not treated as fatal.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const TEST_VIDEO = "https://www.youtube.com/watch?v=Ey5YXBINl2Q"; // an Orbital NCG upload

// On GitHub Actions, key results also become annotations on the run page.
function annotate(level, title, message) {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const data = (v) => String(v).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (v) => data(v).replace(/:/g, "%3A").replace(/,/g, "%2C");
  console.log(`::${level} title=${prop(title)}::${data(message)}`);
}

function fail(message) {
  console.error(`[verify-runtime] ✗ FAIL: ${message}`);
  annotate("error", "Desktop app as yt-dlp's JavaScript runtime", message);
  process.exit(1);
}

function defaultExe() {
  const yml = fs.readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8");
  const productName = /^productName:\s*(.+?)\s*$/m.exec(yml)?.[1] ?? "Soundwave AI";
  return path.join(desktopDir, "release", "win-unpacked", `${productName}.exe`);
}

const exe = path.resolve(process.argv[2] ?? defaultExe());
if (!fs.existsSync(exe)) fail(`packaged app not found at ${exe} — run electron-builder first`);

const runtimeModule = path.join(desktopDir, "app", "server", "dist", "lib", "jsRuntime.js");
if (!fs.existsSync(runtimeModule)) fail(`assembled server not found (${runtimeModule}) — run node assemble.mjs first`);
const { probeElectronRunAsNode, RUN_AS_NODE_ENV } = await import(pathToFileURL(runtimeModule).href);

// 1) The app's own startup probe, against the packaged exe.
console.log(`[verify-runtime] probing ${exe} as Node …`);
const probe = await probeElectronRunAsNode(exe, { timeoutMs: 120_000 });
if (!probe.ok) {
  fail(
    `the packaged app can't act as Node (${probe.reason}). yt-dlp would have no JavaScript runtime on ` +
      "customer machines without Node/Deno. Keep Electron's RunAsNode fuse enabled (electron-builder.yml).",
  );
}
console.log(`[verify-runtime] ✓ the packaged app runs as Node ${probe.version}`);

// 2) The packaged yt-dlp, handed the app as `node` exactly like the server does.
const ytdlpName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const ytdlp = [path.join(path.dirname(exe), "resources", "bin", ytdlpName), path.join(desktopDir, "bin", ytdlpName)].find((p) =>
  fs.existsSync(p),
);
if (!ytdlp) fail(`no ${ytdlpName} in the package or in desktop/bin`);

const args = [
  "--js-runtimes",
  `node:${exe}`,
  "-v",
  "--ignore-config",
  "--no-playlist",
  "--encoding",
  "utf-8",
  "--skip-download",
  "--print",
  "%(id)s | %(title)s",
  TEST_VIDEO,
];
console.log(`[verify-runtime] ${ytdlp} ${args.join(" ")}`);
const result = await new Promise((resolve) => {
  const child = spawn(ytdlp, args, { env: { ...process.env, ...RUN_AS_NODE_ENV }, windowsHide: true });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.on("error", (e) => {
    clearTimeout(timer);
    resolve({ code: null, stdout, stderr: `${stderr}\n${e.message}` });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
});

const log = `${result.stdout}\n${result.stderr}`;
for (const line of log.split(/\r?\n/)) {
  if (/yt-dlp version|JS runtimes|JS Challenge|\[jsc|challenge/i.test(line) || /^(WARNING|ERROR):/.test(line)) console.log(`    ${line}`);
}

const ytdlpVersion = /yt-dlp version (\S+)/.exec(log)?.[1] ?? "yt-dlp";
const runtimes = /JS runtimes: (.*)/.exec(log)?.[1]?.trim() ?? "";
if (!/\bnode-\d/.test(runtimes)) fail(`${ytdlpVersion} did not accept the packaged app as its node runtime (JS runtimes: ${runtimes || "?"})`);
console.log(`[verify-runtime] ✓ ${ytdlpVersion} detected the app as its JS runtime (${runtimes})`);
// The runtime itself failing is fatal; other solver errors can be YouTube-side.
const crash = /Error running node process[^\n]*/i.exec(log)?.[0];
if (crash) fail(`yt-dlp's challenge solver crashed under the packaged app: ${crash}`);
annotate("notice", "yt-dlp JavaScript runtime", `The packaged app runs as Node ${probe.version}; yt-dlp ${ytdlpVersion} uses it (JS runtimes: ${runtimes}).`);

const solved = /Solving JS challenges using node/.test(log);
const solveError = /Error solving [^\n]*"node" provider[^\n]*/.exec(log)?.[0];
const lastError =
  log
    .split(/\r?\n/)
    .filter((l) => l.startsWith("ERROR:"))
    .pop()
    ?.replace(/^ERROR:\s*/, "")
    .replace(/;\s*please report this issue.*$/i, "") ?? "";
let summary;
if (result.code === 0 && result.stdout.trim()) {
  summary = `Extracted "${result.stdout.trim()}"${solved ? ", solving YouTube's JS challenges with the packaged app" : ""}.`;
  console.log(`[verify-runtime] ✓ ${summary}`);
} else {
  summary = `The test extraction failed (exit ${result.code})${lastError ? `: ${lastError}` : ""} — YouTube often blocks CI machines, so this is informational only.`;
  console.log(`[verify-runtime] – ${summary}`);
}
if (solveError) summary += ` Solver warning: ${solveError}`;
else if (solved && result.code !== 0) summary += " (JS challenges were solved with the packaged app before that.)";
annotate("notice", "YouTube test extraction", summary);
console.log("[verify-runtime] PASS");
