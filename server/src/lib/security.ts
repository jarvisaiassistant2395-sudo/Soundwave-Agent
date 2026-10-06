import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";

// ── HTTP security headers ───────────────────────────────────────────────────
// TTS is server-side (Microsoft Neural voices), so no WebAssembly, no Web
// Workers, and no model CDN are required on the client — the CSP is tight.
//
// The directives are a named constant because this policy is the app's policy,
// not one server's: the packaged desktop app gets it from this middleware, the
// docker-compose deployment gets a hand-written copy in deploy/nginx.conf, and
// the phone app carries its own in mobile/index.html. When those drift, a
// library that injects a `<style>` at runtime is silently dropped in one place
// and works in another — so a test (tests/csp.test.ts) compares all three.
export const CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  // Google Fonts is in the stylesheet origin list only for a hosted deployment
  // that loads them from the CDN; the app itself self-hosts (frontend/src/fonts.css).
  "style-src": ["'self'", "https://fonts.googleapis.com"],
  "font-src": ["'self'", "https://fonts.gstatic.com"],
  "img-src": ["'self'", "data:", "blob:"],
  "media-src": ["'self'", "blob:"],
  "connect-src": ["'self'"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "object-src": ["'none'"],
  // These two are the last two helmet adds by itself. They are listed here
  // instead, because that is what makes the byte-identical mirror in
  // deploy/nginx.conf possible: this object is the whole policy, in this order,
  // and nothing is appended behind our back.
  "script-src-attr": ["'none'"],
  "upgrade-insecure-requests": [],
} as const;

/**
 * The policy as a header value — the string deploy/nginx.conf and
 * deploy/Caddyfile have to contain, verbatim.
 *
 * Helmet 7 wrote its own defaults in an order that happened to match this
 * object; helmet 8 writes them in a different one. Order means nothing to a
 * browser (the directives are a set), but "the mirror is byte-identical" is a
 * check a person can make with their eyes, so the policy is declared in full
 * and `useDefaults: false` keeps helmet from adding anything of its own.
 */
export function cspHeaderValue(): string {
  // Helmet's format: directives separated by ";" with no space, and a directive
  // with no values (upgrade-insecure-requests) written bare.
  const parts = Object.entries(CSP_DIRECTIVES).map(([key, values]) => (values.length ? `${key} ${values.join(" ")}` : key));
  return parts.join(";");
}

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    // Every directive below is ours, and no default is merged in — see above.
    useDefaults: false,
    directives: { ...CSP_DIRECTIVES },
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
/**
 * The address a rate limit is counted against.
 *
 * This used to read `X-Forwarded-For` unconditionally, which made every limit
 * in this file decorative: anyone who could reach the port directly sent a
 * different header per request and got a fresh bucket each time — including the
 * sign-in throttle, whose whole job is to slow a password-less guessing loop
 * down. `req.ip` is the right answer, and it is only interesting when Express
 * has been told what to trust (config.trustProxy, set from TRUST_PROXY in
 * app.ts): with the default of "trust nothing" it is the socket's own address,
 * which a caller cannot forge.
 *
 * The header is still consulted when the deployment says a proxy is in front —
 * that is what `trust proxy` means — and then only the last hop the proxy
 * appended is used, never the first value a client can write.
 */
const trustIp = (req: { ip?: string; socket?: { remoteAddress?: string } }): string => {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
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
