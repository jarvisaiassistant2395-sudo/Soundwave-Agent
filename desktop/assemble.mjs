// Assemble the production app tree at desktop/app/ from the built server and
// frontend, then protect it (see protect.mjs / code-protection.json): a
// customer can read every file in resources/app, so the staged server and
// frontend are rewritten before they are ever packed — and the build fails if
// any of the phrases that matter still read. Runs on the build machine (CI
// Windows runner, or dev):
//
//   app/
//     server/         package.json + package-lock.json + dist/ + prod node_modules/
//     frontend/dist/  built SPA
//     config/         youtube-client.json, when the build ships one (one-click
//                     "Connect YouTube"; gitignored, CI writes it from a secret)
//
// Binaries (ffmpeg.exe, yt-dlp.exe) are NOT staged here — they live in
// desktop/bin/ and are attached as electron-builder extraResources.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBinaryLicenses } from "../scripts/write-binary-licenses.mjs";
import { execFileSync } from "node:child_process";
import { obfuscateTree, verifyShipped, verifySources } from "./protect.mjs";
import JavaScriptObfuscator from "javascript-obfuscator";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopDir, "..");
const stage = path.join(desktopDir, "app");

function need(p, hint) {
  if (!fs.existsSync(p)) {
    console.error(`[assemble] MISSING: ${p}\n  → ${hint}`);
    process.exit(1);
  }
}

need(path.join(repoRoot, "server", "dist", "index.js"), "run: cd server && npm ci && npm run build");
need(path.join(repoRoot, "server", "package-lock.json"), "server lockfile required for npm ci");
need(path.join(repoRoot, "frontend", "dist", "index.html"), "run: cd frontend && npm ci && npm run build");

console.log("[assemble] cleaning stage …");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, "server"), { recursive: true });

console.log("[assemble] server sources …");
fs.copyFileSync(
  path.join(repoRoot, "server", "package.json"),
  path.join(stage, "server", "package.json"),
);
fs.copyFileSync(
  path.join(repoRoot, "server", "package-lock.json"),
  path.join(stage, "server", "package-lock.json"),
);
fs.cpSync(path.join(repoRoot, "server", "dist"), path.join(stage, "server", "dist"), { recursive: true });
// NOTE: never copy server/.env — packaged mode is configured purely via env.

console.log("[assemble] production node_modules (npm ci --omit=dev --ignore-scripts) …");
execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  // On Windows npm is a .cmd shim — Node refuses to exec those without a
  // shell (EINVAL since the 2024 CVE fix), so enable shell on win32 only.
  { cwd: path.join(stage, "server"), stdio: "inherit", shell: process.platform === "win32" },
);

// A build can ship Soundwave's own Google OAuth client so customers connect
// YouTube with one press. Optional: without it the app asks for the person's
// own free client instead, and says so honestly.
const youtubeClient = path.join(desktopDir, "config", "youtube-client.json");
if (fs.existsSync(youtubeClient)) {
  console.log("[assemble] one-click YouTube client (config/youtube-client.json) …");
  fs.mkdirSync(path.join(stage, "config"), { recursive: true });
  fs.copyFileSync(youtubeClient, path.join(stage, "config", "youtube-client.json"));
} else {
  console.log("[assemble] no config/youtube-client.json — Connect YouTube will ask for the person's own Google client");
}

console.log("[assemble] frontend dist …");
fs.mkdirSync(path.join(stage, "frontend"), { recursive: true });
fs.cpSync(path.join(repoRoot, "frontend", "dist"), path.join(stage, "frontend", "dist"), {
  recursive: true,
});

// ── Bundled programs: their licences ship next to them ─────────────────────
// ffmpeg is a separate program (mere aggregation — it does not touch our
// licence), but GPLv3 still requires its licence text and a written offer of
// source to travel with it. Writing them here means every build carries them,
// however the binary got into bin/.
// The generated third-party notices travel with the app, next to the frontend.
const notices = path.join(repoRoot, "THIRD-PARTY-NOTICES.txt");
if (fs.existsSync(notices)) {
  console.log("[assemble] THIRD-PARTY-NOTICES.txt …");
  fs.copyFileSync(notices, path.join(stage, "THIRD-PARTY-NOTICES.txt"));
} else {
  console.warn("[assemble] ⚠ THIRD-PARTY-NOTICES.txt is missing — run: node scripts/license-audit.mjs --write");
  process.exitCode = 1;
}

console.log("[assemble] bundled-program licences …");
try {
  const written = writeBinaryLicenses(path.join(desktopDir, "bin"));
  for (const file of written) console.log(`[assemble]   ${path.basename(file)}`);
} catch (err) {
  console.error(`[assemble] ⚠ ${err.message}`);
  process.exitCode = 1;
}

// ── Protection: the last writer of these trees before they are packed ──────
// Everything above copied readable code into desktop/app; from here on the
// staged trees are rewritten and then checked against code-protection.json.
// The Electron shell's own sources (desktop/src/**) are copied by
// electron-builder itself, so they're protected later — scripts/afterPack.cjs.
console.log("[assemble] protecting the staged server (the tree that holds the brain) …");
const drift = verifySources();
if (drift.length) {
  console.error("[assemble] code-protection.json no longer matches the source:");
  for (const problem of drift) console.error(`  - ${problem}`);
  process.exit(1);
}
// Only the server: it is the tree that holds the agent's instruction, the
// short-script shape and the guide. The UI bundle and the Electron shell are
// minified/glue code with none of that (checked: not one marker is in them) and
// the packaged-app E2E drives the UI — rewriting it bought nothing and cost a
// run, so it ships byte-for-byte as built. code-protection.json says the same.
obfuscateTree(JavaScriptObfuscator, path.join(stage, "server", "dist"), { preset: "code" });
const readable = verifyShipped(stage);
if (readable.length) {
  console.error("[assemble] the staged app still reads — refusing to pack it:");
  for (const problem of readable) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("[assemble] ✓ nothing of the brain is readable in the staged app");

// Sanity: the exact entry points the runtime resolves.
need(path.join(stage, "server", "dist", "index.js"), "stage incomplete");
need(path.join(stage, "frontend", "dist", "index.html"), "stage incomplete");

const binDir = path.join(desktopDir, "bin");
const hasFfmpeg = fs.existsSync(path.join(binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
const hasYtdlp = fs.existsSync(path.join(binDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"));
if (!hasFfmpeg || !hasYtdlp) {
  console.warn(
    `[assemble] ⚠ runtime binaries missing (ffmpeg=${hasFfmpeg}, yt-dlp=${hasYtdlp}) — ` +
      "video export / YouTube import will fall back to system PATH. CI provides desktop/bin/.",
  );
}

console.log(`[assemble] done → ${stage}`);
