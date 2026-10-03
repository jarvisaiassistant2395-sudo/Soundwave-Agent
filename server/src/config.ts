import "dotenv/config";
import fs, { existsSync } from "node:fs";
import path from "node:path";

const env = process.env;

function str(key: string, fallback: string): string {
  return env[key] && env[key]!.length > 0 ? env[key]! : fallback;
}

function int(key: string, fallback: number): number {
  const v = parseInt(env[key] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  env: env.NODE_ENV ?? "development",
  isProd: (env.NODE_ENV ?? "development") === "production",
  port: int("PORT", 4000),
  // Interface to bind. Desktop/packaged builds set 127.0.0.1 so the local API
  // is never reachable from the LAN.
  bindHost: str("BIND_HOST", "0.0.0.0"),
  appUrl: str("APP_URL", "http://localhost:5173"),
  databaseUrl: str("DATABASE_URL", ""),
  // In production these MUST be present (validated at startup).
  jwtAccessSecret: str("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
  jwtRefreshSecret: str("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
  jwtAccessTtl: str("JWT_ACCESS_TTL", "15m"),
  jwtRefreshTtl: str("JWT_REFRESH_TTL", "7d"),
  corsOrigins: (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  emailFrom: str("EMAIL_FROM", "Soundwave AI <no-reply@soundwave.ai>"),
  resendApiKey: str("RESEND_API_KEY", ""),
  googleClientId: str("GOOGLE_CLIENT_ID", ""),
  googleClientSecret: str("GOOGLE_CLIENT_SECRET", ""),
  stripeSecretKey: str("STRIPE_SECRET_KEY", ""),
  stripeWebhookSecret: str("STRIPE_WEBHOOK_SECRET", ""),
  ffmpegPath: str("FFMPEG_PATH", ""),
  // YouTube import (yt-dlp). The vendored zipapp is auto-detected (needs python3);
  // set YTDLP_PATH to override with a system binary.
  ytDlpPath: str("YTDLP_PATH", ""),
  ytDlpCookies: str("YTDLP_COOKIES", ""), // optional cookies.txt for age/bot-gated videos
  // Live browser profile for --cookies-from-browser (firefox|chrome|...).
  // Preferred over YTDLP_COOKIES on desktop: no export step, no rotation.
  ytDlpBrowser: str("YTDLP_BROWSER", ""),
  ytDlpMaxDuration: int("YTDLP_MAX_DURATION", 1200), // seconds — refuses longer videos
  ytDlpTimeoutMs: int("YTDLP_TIMEOUT_MS", 240_000),
  // Run `yt-dlp --update-to <channel>` in the background at startup
  // ("nightly", "stable", or channel@tag). The desktop app sets it for its
  // writable user-data copy; the Windows launcher updates the vendored exe
  // itself. Empty/"off" = never self-update.
  ytDlpAutoUpdate: str("YTDLP_AUTO_UPDATE", ""),
  // Voice cloning (OmniVoice sidecar — see voiceclone/). Empty = feature off.
  voiceCloneUrl: str("VOICECLONE_URL", ""),
  elevenLabsApiKey: str("ELEVENLABS_API_KEY", ""),
  // Shared secret for the sidecar — REQUIRED when VOICECLONE_URL is a public
  // URL (Hugging Face Space, tunnel, remote GPU host). Must match the
  // sidecar's own VOICECLONE_TOKEN.
  voiceCloneToken: str("VOICECLONE_TOKEN", ""),
  // Minimum plan allowed to clone/generate with cloned voices.
  voiceCloneMinPlan: str("VOICECLONE_MIN_PLAN", "FREE"),
  voiceCloneTimeoutMs: int("VOICECLONE_TIMEOUT_MS", 600_000), // CPU cloning is slow
  // Plan assigned to NEW accounts. Keep FREE for any production deployment;
  // bump to ENTERPRISE locally to test everything (4K export, full quota).
  defaultSignupPlan: ((): "FREE" | "PRO" | "ENTERPRISE" => {
    const v = str("DEFAULT_SIGNUP_PLAN", "FREE").toUpperCase();
    return v === "PRO" || v === "ENTERPRISE" ? v : "FREE";
  })(),
  dataDir: str("DATA_DIR", path.join(process.cwd(), "data")),
  uploadsDir: str("UPLOADS_DIR", path.join(process.cwd(), "uploads")),
  // Absolute path to a built frontend (frontend/dist). Packaged/desktop builds
  // set this so Express serves the SPA from one origin — no Vite, no second port.
  webDist: str("WEB_DIST", ""),
  // Phone companion (lib/companion): the desktop app sets COMPANION=1. Only
  // then can Settings → Phone open the LAN listener the paired phone app
  // talks to (and only while the person has it turned on). Hosted/web
  // deployments never expose it.
  companionAvailable: env.COMPANION === "1",
  companionPort: int("COMPANION_PORT", 47800),
  // Extra addresses to put in the pairing code, comma-separated: a DNS/VPN
  // name for this PC, or a full https:// origin that forwards to the phone
  // listener. Detected network addresses are always included.
  companionHosts: (env.COMPANION_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // The desktop app (DESKTOP_APP=1, set by desktop/src/server-env.cjs): the
  // server runs on the person's own PC, so the agent may open websites and
  // apps here, and Settings → Brain can save a Gemini API key.
  desktopApp: env.DESKTOP_APP === "1",
  // Settings → Brain outside the desktop app (local development only).
  brainSettingsAvailable: env.DESKTOP_APP === "1" || env.BRAIN_SETTINGS === "1",
  // The agent's brain: Google Gemini (lib/brain). A key saved in Settings →
  // Brain (DATA_DIR/brain.json) wins; these are for hosted/dev setups.
  geminiApiKey: str("GEMINI_API_KEY", ""),
  geminiModel: str("GEMINI_MODEL", ""),
  geminiApiBase: str("GEMINI_API_BASE", "https://generativelanguage.googleapis.com").replace(/\/+$/, ""),
  // The agent's memory (lib/memory.ts): notes, a summary of earlier
  // conversations and the shorts made. The desktop app has it; MEMORY=1
  // turns it on for local development.
  memoryAvailable: env.DESKTOP_APP === "1" || env.MEMORY === "1",
  // Gemini's address for paired phones chatting while the PC is off. Empty =
  // Google's (tests point the emulator at a stand-in).
  companionGeminiBase: str("COMPANION_GEMINI_BASE", "").replace(/\/+$/, ""),
  // Morning Setup's weather: Open-Meteo (free, no key). Tests use a stand-in.
  openMeteoGeocodingUrl: str("OPEN_METEO_GEOCODING_URL", "https://geocoding-api.open-meteo.com/v1/search"),
  openMeteoForecastUrl: str("OPEN_METEO_FORECAST_URL", "https://api.open-meteo.com/v1/forecast"),
  // YouTube: the Data API and Google's OAuth endpoints ("Connect YouTube
  // account" signs in through the browser). Tests use stand-ins.
  youtubeApiBase: str("YOUTUBE_API_BASE", "https://www.googleapis.com").replace(/\/+$/, ""),
  googleOAuthAuthUrl: str("GOOGLE_OAUTH_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
  googleOAuthTokenUrl: str("GOOGLE_OAUTH_TOKEN_URL", "https://oauth2.googleapis.com/token"),
  // Reader fallback for pages that can't be read directly (JS-only, blocked).
  // Free, no key; point JINA_READER_URL at a stand-in in tests.
  jinaReaderUrl: str("JINA_READER_URL", "https://r.jina.ai"),
} as const;

// Everything optional at runtime is intentionally absent here so lean (free)
// deployments boot without extra accounts: blank Google keys hide the OAuth
// button, blank Stripe keys make billing endpoints return a clear error, and
// a missing DATABASE_URL falls back to the local JSON store.
const REQUIRED_PROD = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"];

const REQUIRED_DEV = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"];

/** Validate config — crash in dev if JWT secrets are using defaults. */
export function validateConfig(): void {
  const required = config.isProd ? REQUIRED_PROD : REQUIRED_DEV;
  const missing = required.filter((k) => !env[k] || env[k]!.length === 0);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  // In development, ensure JWT secrets are not the default values
  if (!config.isProd) {
    const defaultAccess = "dev-access-secret-change-me";
    const defaultRefresh = "dev-refresh-secret-change-me";
    if (config.jwtAccessSecret === defaultAccess) {
      throw new Error("JWT_ACCESS_SECRET is using the default value. Please set a custom secret in development.");
    }
    if (config.jwtRefreshSecret === defaultRefresh) {
      throw new Error("JWT_REFRESH_SECRET is using the default value. Please set a custom secret in development.");
    }
  }

  // Non-FREE default plans are for local testing only — yell very loudly if
  // this ever reaches a production boot.
  if (config.isProd && config.defaultSignupPlan !== "FREE") {
    console.error(
      "[soundwave] ⚠⚠⚠  DEFAULT_SIGNUP_PLAN=" + config.defaultSignupPlan +
      " — new accounts get a paid plan for free. This should NEVER be set in production; remove it before publishing.",
    );
  }
}

/** Resolve the FFmpeg binary path (env override → vendored static binary → system PATH). */
export function resolveFfmpegPath(): string {
  if (config.ffmpegPath && existsSyncSafe(config.ffmpegPath)) return config.ffmpegPath;

  const isWin = process.platform === "win32";
  const exeName = isWin ? "ffmpeg.exe" : "ffmpeg";

  const candidates: string[] = [
    path.join(process.cwd(), "..", "vendor", "ffmpeg", exeName),
    path.join(process.cwd(), "vendor", "ffmpeg", exeName),
    path.join(process.cwd(), "..", "vendor", "ffmpeg", "bin", exeName),
    path.join(process.cwd(), "vendor", "ffmpeg", "bin", exeName),
    path.join(process.cwd(), exeName),
    path.join(process.cwd(), "..", exeName),
  ];

  if (isWin) {
    const userProfile = process.env.USERPROFILE || "";
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programData = process.env.ProgramData || "C:\\ProgramData";

    candidates.push(
      "C:\\ffmpeg\\bin\\ffmpeg.exe",
      "C:\\ffmpeg\\ffmpeg.exe",
      path.join(programData, "chocolatey", "bin", "ffmpeg.exe"),
      path.join(userProfile, "scoop", "shims", "ffmpeg.exe"),
      path.join(programFiles, "ffmpeg", "bin", "ffmpeg.exe"),
      path.join(localAppData, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
      path.join(userProfile, "AppData", "Local", "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
      path.join(userProfile, "Downloads", "ffmpeg", "bin", "ffmpeg.exe"),
      path.join(userProfile, "Downloads", "ffmpeg.exe")
    );

    // Auto-scan WinGet Packages directory for Gyan / Essentials build
    if (localAppData) {
      const wingetPkgs = path.join(localAppData, "Microsoft", "WinGet", "Packages");
      try {
        if (existsSyncSafe(wingetPkgs)) {
          const dirs = fs.readdirSync(wingetPkgs);
          for (const d of dirs) {
            if (d.toLowerCase().includes("ffmpeg")) {
              candidates.push(
                path.join(wingetPkgs, d, "ffmpeg.exe"),
                path.join(wingetPkgs, d, "bin", "ffmpeg.exe")
              );
              try {
                const subdirs = fs.readdirSync(path.join(wingetPkgs, d));
                for (const sub of subdirs) {
                  candidates.push(path.join(wingetPkgs, d, sub, "bin", "ffmpeg.exe"));
                }
              } catch {}
            }
          }
        }
      } catch {}
    }
  } else {
    candidates.push(
      "/usr/local/bin/ffmpeg",
      "/usr/bin/ffmpeg",
      "/bin/ffmpeg"
    );
  }

  for (const c of candidates) {
    if (existsSyncSafe(c)) return c;
  }

  return "ffmpeg";
}

function existsSyncSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}