// Shared bootstrap for the bundled Soundwave server.
// Used by BOTH the Electron main process (src/main.js) and the standalone
// smoke test (smoke.mjs) — one source of truth for how a packaged install
// configures the API: loopback-only bind, user-data folders, generated JWT
// secrets, bundled ffmpeg/yt-dlp/whisper, SPA served from WEB_DIST.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const crypto = require("node:crypto");

/** Ask the OS for a free loopback port. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

function loadSecrets(secretsFile) {
  let secrets = {};
  try {
    secrets = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
  } catch {
    /* first run */
  }
  if (!secrets.jwtAccess || !secrets.jwtRefresh) {
    secrets = {
      jwtAccess: crypto.randomBytes(32).toString("hex"),
      jwtRefresh: crypto.randomBytes(32).toString("hex"),
    };
    try {
      fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
      fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    } catch (err) {
      console.warn("[soundwave-desktop] could not persist secrets:", err.message);
    }
  }
  return secrets;
}

/**
 * yt-dlp breaks whenever YouTube changes something, and the copy inside the
 * installer is frozen at build time. So it runs from a writable copy in the
 * user-data folder, which the server keeps current (YTDLP_AUTO_UPDATE): the
 * install folder may be read-only, and the portable build's is a temporary
 * extraction that is gone after exit.
 *
 * The bundled exe is (re)copied when there is no copy yet, when the copy is
 * damaged (empty), or when an app update ships a build newer than the copy.
 * Returns { path, writable }, or null when no yt-dlp is bundled at all.
 */
function prepareYtDlp({ binDir, userDataDir }) {
  const name = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const bundled = path.join(binDir, name);
  if (!fs.existsSync(bundled)) return null;
  const local = path.join(userDataDir, "bin", name);
  try {
    const source = fs.statSync(bundled);
    let copy = null;
    try {
      copy = fs.statSync(local);
    } catch {
      /* first run */
    }
    if (!copy || copy.size === 0 || source.mtimeMs > copy.mtimeMs) {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      const tmp = `${local}.${process.pid}.tmp`;
      fs.copyFileSync(bundled, tmp);
      if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, local);
    }
    return { path: local, writable: true };
  } catch (err) {
    console.warn(`[soundwave-desktop] running the bundled yt-dlp (could not copy it to ${local}: ${err.message})`);
    return { path: bundled, writable: false };
  }
}

/**
 * Soundwave's own Google OAuth client, when this machine/build has one. It makes
 * "Connect YouTube" a single button: the person signs in and is done, no Google
 * Cloud project, no client ID to paste.
 *
 * Two places, first one wins:
 *   <userDataDir>/youtube-client.json   the person's own copy — the same folder
 *                                       as their settings and data, no admin
 *                                       rights, and it survives app updates
 *   <appRoot>/config/youtube-client.json what the build shipped (CI writes it
 *                                       from a repository secret; gitignored)
 * A file that exists but doesn't parse falls through to the next place, so a
 * bad local copy can never break a working shipped one.
 */
function loadYouTubeClient(appRoot, userDataDir = null) {
  const places = [userDataDir && path.join(userDataDir, "youtube-client.json"), path.join(appRoot, "config", "youtube-client.json")].filter(Boolean);
  for (const file of places) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const node = raw.installed ?? raw.web ?? raw.desktop ?? raw;
      const clientId = String(node.client_id ?? node.clientId ?? "").trim();
      const clientSecret = String(node.client_secret ?? node.clientSecret ?? "").trim();
      if (clientId && clientSecret) return { clientId, clientSecret };
    } catch {
      /* not here (or not usable) — try the next place */
    }
  }
  return null; // nowhere: the app shows the honest own-client path
}

/**
 * Apply the packaged-mode environment and chdir into the bundled server.
 * The API itself stays loopback-only; the phone companion (COMPANION=1) opens
 * its separate LAN listener only while Settings → Phone has it turned on.
 * Returns { serverRoot, appUrl, port } once configured (server not started yet).
 * `autoUpdateYtDlp` (the desktop shell sets it) lets the server update the
 * user-data yt-dlp copy to the nightly build in the background at startup.
 *
 * Layout (both installed and unpackaged):
 *   appRoot/
 *     server/        package.json, dist/, node_modules/   (assembled)
 *     frontend/dist/ built SPA served at WEB_DIST
 *     scripts/assets bundled static assets (music, …)
 *   binDir/
 *     ffmpeg.exe, yt-dlp.exe                              (runtime binaries)
 *     whisper/whisper-cli.exe + DLLs + ggml-*.bin         (voice input)
 *   userDataDir/bin/
 *     yt-dlp.exe                  writable copy that runs (see prepareYtDlp)
 */
async function applyServerEnv({ appRoot, binDir, userDataDir, autoUpdateYtDlp = false }) {
  const serverRoot = path.join(appRoot, "server");
  const webDist = path.join(appRoot, "frontend", "dist");

  if (!fs.existsSync(path.join(serverRoot, "dist", "index.js"))) {
    throw new Error(`Bundled server build not found at ${path.join(serverRoot, "dist", "index.js")}`);
  }
  if (!fs.existsSync(path.join(webDist, "index.html"))) {
    throw new Error(`Bundled frontend build not found at ${path.join(webDist, "index.html")}`);
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  const secrets = loadSecrets(path.join(userDataDir, "secrets.json"));
  const port = await getFreePort();
  const appUrl = `http://127.0.0.1:${port}`;

  const dataDir = path.join(userDataDir, "data");
  const env = {
    NODE_ENV: "production",
    PORT: String(port),
    // Loopback only — the local API is never exposed to the LAN.
    BIND_HOST: "127.0.0.1",
    APP_URL: appUrl,
    CORS_ORIGINS: appUrl,
    DATA_DIR: dataDir,
    // Uploads (incl. YouTube link imports) and the agent's Orbital NCG history
    // live in the user-data folder, never the install directory.
    UPLOADS_DIR: path.join(userDataDir, "uploads"),
    WEB_DIST: webDist,
    JWT_ACCESS_SECRET: secrets.jwtAccess,
    JWT_REFRESH_SECRET: secrets.jwtRefresh,
    // Settings → Phone: the phone companion's own listener (off until the
    // person turns it on; it only answers paired, encrypted requests).
    COMPANION: "1",
    // The server runs on the person's own PC: Settings → Brain can save their
    // Gemini API key (data\brain.json) and the agent may open websites/apps.
    DESKTOP_APP: "1",
  };

  // Only point at bundled binaries that actually exist; otherwise let the
  // server's own resolver fall back to vendor/PATH with a clear boot warning.
  const isWin = process.platform === "win32";
  const ffmpegBin = path.join(binDir, isWin ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(ffmpegBin)) env.FFMPEG_PATH = ffmpegBin;
  const ytdlp = prepareYtDlp({ binDir, userDataDir });
  if (ytdlp) {
    env.YTDLP_PATH = ytdlp.path;
    // yt-dlp's nightly channel gets YouTube fixes first (yt-dlp recommends it
    // for regular users). A YTDLP_AUTO_UPDATE already in the environment
    // ("off", "stable", …) wins.
    if (autoUpdateYtDlp && ytdlp.writable) env.YTDLP_AUTO_UPDATE = process.env.YTDLP_AUTO_UPDATE || "nightly";
  }

  // One-click "Connect YouTube": the shipped Google client, if any. Anything
  // already in the environment (a developer, CI, a power user) wins over it.
  const youtubeClient = loadYouTubeClient(appRoot, userDataDir);
  if (youtubeClient) {
    if (!process.env.SOUNDWAVE_YOUTUBE_CLIENT_ID) env.SOUNDWAVE_YOUTUBE_CLIENT_ID = youtubeClient.clientId;
    if (!process.env.SOUNDWAVE_YOUTUBE_CLIENT_SECRET) env.SOUNDWAVE_YOUTUBE_CLIENT_SECRET = youtubeClient.clientSecret;
  }

  // Voice input: the bundled whisper.cpp CLI + model (bin/whisper/). The
  // server finds the model next to the CLI.
  const whisperCli = path.join(binDir, "whisper", isWin ? "whisper-cli.exe" : "whisper-cli");
  if (fs.existsSync(whisperCli)) env.WHISPER_CLI_PATH = whisperCli;

  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  process.chdir(serverRoot);

  return { serverRoot, webDist, appUrl, port, dataDir };
}

module.exports = { applyServerEnv, getFreePort, loadSecrets, loadYouTubeClient, prepareYtDlp };
