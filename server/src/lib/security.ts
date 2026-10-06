import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";

// ── HTTP security headers ───────────────────────────────────────────────────
// TTS is server-side (Microsoft Neural voices), so no WebAssembly, no Web
// Workers, and no model CDN are required on the client — the CSP is tight.
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "img-src": ["'self'", "data:", "blob:"],
      "media-src": ["'self'", "blob:"],
      "connect-src": ["'self'"],
      "frame-ancestors": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "object-src": ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  xContentTypeOptions: true,
  xFrameOptions: false, // frame-ancestors 'none' is set in CSP instead
  xXssProtection: false, // deprecated — CSP is the replacement
});

// ── Rate limiting (applied to ALL backend endpoints) ────────────────────────
const trustIp = (req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string => {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]!.trim();
  return req.ip ?? "unknown";
};

/**
 * How many requests a minute one client gets. A hosted server keeps the tight
 * 120; the desktop app is one person on their own PC whose window polls stats,
 * jobs and the conversation, and 120 was small enough that the app rate-limited
 * itself — the packaged end-to-end run hit "Too many requests" saving a memory
 * note. The desktop ceiling is still a runaway guard, not an open door.
 */
export function generalLimitPerMinute(desktop: boolean = config.desktopApp): number {
  return desktop ? 2000 : 120;
}

export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: generalLimitPerMinute(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Try to get user ID from auth cookies for per-user limiting
    const cookies = req.headers.cookie ?? "";
    const m = cookies.match(/(?:^|;\s*)access_token=([^;]*)/);
    if (m && m[1]) {
      // User is authenticated - key by user identifier (token prefix)
      return `user:${m[1].substring(0, 16)}`;
    }
    return trustIp(req);
  },
  message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } },
});

/** Signing in: the app starts a sign-in and then claims it (no passwords). */
export const authSignInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isProd ? 40 : 400,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => trustIp(req),
  message: { error: { code: "RATE_LIMITED", message: "Too many sign-in attempts. Try again in 15 minutes." } },
});

export const usageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => trustIp(req),
  message: { error: { code: "RATE_LIMITED", message: "Too many usage reports." } },
});

export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60, // increased from 5 to 60 per 60s per IP; per-user throttling added in generalLimiter
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => trustIp(req),
  message: { error: { code: "RATE_LIMITED", message: "Upload limit reached. Try again shortly." } },
});