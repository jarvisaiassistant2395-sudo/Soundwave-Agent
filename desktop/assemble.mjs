// Assemble the production app tree at desktop/app/ from the built server and
// frontend. Runs on the build machine (CI Windows runner, or dev):
//
//   app/
//     server/         package.json + package-lock.json + dist/ + prod node_modules/
//     frontend/dist/  built SPA
//     scripts/assets/ bundled static assets (music)
//     config/         youtube-client.json, when the build ships one (one-click
//                     "Connect YouTube"; gitignored, CI writes it from a secret)
//
// Binaries (ffmpeg.exe, yt-dlp.exe) are NOT staged here — they live in
// desktop/bin/ and are attached as electron-builder extraResources.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
need(path.join(repoRoot, "scripts", "assets"), "bundled assets folder missing");

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

console.log("[assemble] scripts/assets …");
fs.cpSync(path.join(repoRoot, "scripts", "assets"), path.join(stage, "scripts", "assets"), {
  recursive: true,
});

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
