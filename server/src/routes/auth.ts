import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ApiError } from "../middleware/error.js";
import { authLoginLimiter, authSignupLimiter } from "../lib/security.js";
import {
  clearAuthCookies,
  createUserSession,
  hashPassword,
  publicUser,
  randomToken,
  setAuthCookies,
  sha256,
  signAccessToken,
  verifyPassword,
  verifyRefreshToken,
} from "../lib/auth.js";
import { getStore } from "../lib/store.js";
import { passwordResetEmail, sendMail, verificationEmail } from "../lib/mail.js";
import { deviceInfo, requireAuth } from "../middleware/auth.js";
import { config } from "../config.js";
import { exchangeGoogleCode, googleAuthUrl, oauthEnabled, type OAuthProvider } from "../lib/oauth.js";

const router = Router();

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(100, "Password must be at most 100 characters.")
  .regex(/[a-z]/, "Password must contain a lowercase letter.")
  .regex(/[A-Z]/, "Password must contain an uppercase letter.")
  .regex(/[0-9]/, "Password must contain a number.")
  .regex(/[^A-Za-z0-9]/, "Password must contain a special character.");

const emailSchema = z.string().email("Enter a valid email address.").max(254);

const signupSchema = z.object({
  name: z.string().min(2).max(100),
  email: emailSchema,
  password: passwordSchema,
});

const signinSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(100),
});

// ── In-memory account/email rate-limit counters (per-process) ──────────────────
const counter = new Map<string, { count: number; windowStart: number }>();
function hit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const c = counter.get(key);
  if (!c || now - c.windowStart > windowMs) {
    counter.set(key, { count: 1, windowStart: now });
    return { ok: true, retryAfter: 0 };
  }
  c.count += 1;
  if (c.count > limit) {
    return { ok: false, retryAfter: Math.ceil((c.windowStart + windowMs - now) / 1000) };
  }
  // Clean up stale entries every 1000 hits to prevent memory leak
  if (counter.size > 10000) {
    const cutoff = now - windowMs * 2;
    for (const [k, v] of counter) {
      if (v.windowStart < cutoff) counter.delete(k);
    }
  }
  return { ok: true, retryAfter: 0 };
}

const failedLogins = new Map<string, number>();

// ── Sign up ─────────────────────────────────────────────────────────────────
router.post("/signup", authSignupLimiter, validate({ body: signupSchema }), async (req, res, next) => {
  try {
    const { name, email, password } = req.body as z.infer<typeof signupSchema>;
    const store = await getStore();
    if (await store.findUserByEmail(email)) {
      throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists.");
    }
    const passwordHash = await hashPassword(password);
    const verificationToken = randomToken(24);
    const user = await store.createUser({
      name,
      email,
      passwordHash,
      emailVerificationToken: sha256(verificationToken),
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    await sendMail(verificationEmail(user.email, user.name, verificationToken));

    const bundle = await createUserSession(store, user.id, req.ip ?? "unknown", deviceInfo(req));
    setAuthCookies(res, signAccessToken(user.id), bundle.refreshToken, randomToken(16));
    res.status(201).json({ user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

// ── Sign in ─────────────────────────────────────────────────────────────────
router.post("/signin", authLoginLimiter, validate({ body: signinSchema }), async (req, res, next) => {
  try {
    const { email, password } = req.body as z.infer<typeof signinSchema>;
    const store = await getStore();
    const user = await store.findUserByEmail(email);

    // Prevent enumeration: identical message whether the email exists or not.
    if (!user || !user.passwordHash) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    }
    if ((failedLogins.get(user.id) ?? 0) >= 5) {
      throw new ApiError(403, "CAPTCHA_REQUIRED", "Too many failed attempts. Please complete the CAPTCHA.");
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      failedLogins.set(user.id, (failedLogins.get(user.id) ?? 0) + 1);
      const remaining = 5 - (failedLogins.get(user.id) ?? 0);
      throw new ApiError(401, "INVALID_CREDENTIALS", remaining > 0 ? `Invalid email or password. ${remaining} attempts remaining.` : "Invalid email or password.");
    }
    failedLogins.delete(user.id);
    const bundle = await createUserSession(store, user.id, req.ip ?? "unknown", deviceInfo(req));
    setAuthCookies(res, signAccessToken(user.id), bundle.refreshToken, randomToken(16));
    res.json({ user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

// ── Sign out ────────────────────────────────────────────────────────────────
router.post("/signout", async (req, res, next) => {
  try {
    const raw = req.headers.cookie ?? "";
    const m = raw.match(/(?:^|;\\s*)refresh_token=([^;]*)/);
    if (m) {
      const claims = verifyRefreshToken(decodeURIComponent(m[1]!));
      if (claims) {
        const store = await getStore();
        await store.deleteSession(claims.sid);
      }
    }
    clearAuthCookies(res);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ── Refresh ─────────────────────────────────────────────────────────────────
router.post("/refresh", async (req, res, next) => {
  try {
    const raw = req.headers.cookie ?? "";
    const m = raw.match(/(?:^|;\\s*)refresh_token=([^;]*)/);
    if (!m) throw new ApiError(401, "UNAUTHORIZED", "No session.");
    const token = decodeURIComponent(m[1]!);
    const claims = verifyRefreshToken(token);
    if (!claims) throw new ApiError(401, "UNAUTHORIZED", "Session expired.");
    const store = await getStore();
    const session = await store.findSessionById(claims.sid);
    if (!session) throw new ApiError(401, "UNAUTHORIZED", "Session expired.");
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      await store.deleteSession(session.id);
      throw new ApiError(401, "UNAUTHORIZED", "Session expired.");
    }
    if (session.refreshTokenHash !== sha256(token)) {
      await store.deleteAllSessionsForUser(claims.sub); // suspected token theft
      throw new ApiError(401, "UNAUTHORIZED", "Session invalidated.");
    }
    const user = await store.findUserById(claims.sub);
    if (!user) throw new ApiError(401, "UNAUTHORIZED", "Session invalidated.");
    await store.deleteSession(session.id);
    const bundle = await createUserSession(store, user.id, req.ip ?? "unknown", session.deviceInfo);
    setAuthCookies(res, signAccessToken(user.id), bundle.refreshToken, randomToken(16));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ── Session ─────────────────────────────────────────────────────────────────
router.get("/session", requireAuth, (req, res) => {
  res.json(publicUser(req.user!));
});

router.get("/sessions", requireAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const sessions = await store.listSessionsForUser(req.user!.id);
    res.json({ sessions: sessions.map((s) => ({ id: s.id, deviceInfo: s.deviceInfo, ipAddress: s.ipAddress, lastActiveAt: s.lastActiveAt, createdAt: s.createdAt })) });
  } catch (e) {
    next(e);
  }
});

router.delete("/sessions", requireAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    await store.deleteAllSessionsForUser(req.user!.id);
    clearAuthCookies(res);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ── Forgot / reset password ─────────────────────────────────────────────────
const forgotSchema = z.object({ email: emailSchema });
router.post("/forgot-password", authLoginLimiter, validate({ body: forgotSchema }), async (req, res, next) => {
  try {
    const { email } = req.body as z.infer<typeof forgotSchema>;
    const rl = hit(`forgot:${email.toLowerCase()}`, 3, 60 * 60 * 1000);
    if (!rl.ok) throw new ApiError(429, "RATE_LIMITED", "Too many reset requests. Try again later.", rl.retryAfter);
    const store = await getStore();
    const user = await store.findUserByEmail(email);
    if (user) {
      const token = randomToken(24);
      await store.updateUser(user.id, {
        passwordResetToken: sha256(token),
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      // Invalidate all existing sessions for this user to prevent token reuse
      await store.deleteAllSessionsForUser(user.id);
      clearAuthCookies(res);
      await sendMail(passwordResetEmail(user.email, user.name, token));
    }
    // Always success — prevents user enumeration.
    res.json({ ok: true, message: "If an account exists for that email, a reset link has been sent." });
  } catch (e) {
    next(e);
  }
});

const resetSchema = z.object({ token: z.string().min(10), password: passwordSchema });
router.post("/reset-password", validate({ body: resetSchema }), async (req, res, next) => {
  try {
    const { token, password } = req.body as z.infer<typeof resetSchema>;
    const store = await getStore();
    const user = await store.findUserByResetTokenHash(sha256(token));
    if (!user || !user.passwordResetExpires || new Date(user.passwordResetExpires).getTime() < Date.now()) {
      throw new ApiError(400, "INVALID_TOKEN", "This reset link is invalid or has expired.");
    }
    const passwordHash = await hashPassword(password);
    await store.updateUser(user.id, { passwordHash, passwordResetToken: null, passwordResetExpires: null });
    // Invalidate all existing sessions for this user.
    await store.deleteAllSessionsForUser(user.id);
    clearAuthCookies(res);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ── Email verification ──────────────────────────────────────────────────────
const verifySchema = z.object({ token: z.string().min(10) });
router.post("/verify-email", validate({ body: verifySchema }), async (req, res, next) => {
  try {
    const { token } = req.body as z.infer<typeof verifySchema>;
    const store = await getStore();
    const user = await store.findUserByVerificationTokenHash(sha256(token));
    if (!user || !user.emailVerificationExpires || new Date(user.emailVerificationExpires).getTime() < Date.now()) {
      throw new ApiError(400, "INVALID_TOKEN", "This verification link is invalid or has expired.");
    }
    await store.updateUser(user.id, { emailVerified: true, emailVerificationToken: null, emailVerificationExpires: null });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post("/resend-verification", requireAuth, async (req, res, next) => {
  try {
    const rl = hit(`resend:${req.user!.id}`, 1, 2 * 60 * 1000);
    if (!rl.ok) throw new ApiError(429, "RATE_LIMITED", "Please wait before requesting another email.", rl.retryAfter);
    if (req.user!.emailVerified) {
      res.json({ ok: true });
      return;
    }
    const store = await getStore();
    const token = randomToken(24);
    await store.updateUser(req.user!.id, {
      emailVerificationToken: sha256(token),
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    await sendMail(verificationEmail(req.user!.email, req.user!.name, token));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ── OAuth (Google) — authorization-code flow ────────────────────────────────
// Public capability check — lets the auth UI hide the Google button when
// OAuth isn't configured instead of redirecting users to an error page.
router.get("/providers", (_req, res) => {
  res.json({ providers: { google: oauthEnabled("google") } });
});

//  1. GET /oauth/:provider            → 302 to the provider with a state cookie
//  2. GET /oauth/:provider/callback   → verify state, exchange code, sign in

// When a provider isn't configured, step 1 redirects to the app's
// /oauth/callback?error=not_configured so the UI can explain instead of
// throwing a raw JSON error at a top-level navigation.
function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function oauthStateCookie(res: Response, value: string | null): void {
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: config.isProd, path: "/" };
  if (value) res.cookie("oauth_state", value, { ...opts, maxAge: 10 * 60 * 1000 });
  else res.clearCookie("oauth_state", { path: "/" });
}

router.get("/oauth/:provider", (req, res, next) => {
  const provider = req.params.provider as OAuthProvider;
  if (provider !== "google") {
    return next(new ApiError(400, "INVALID_PROVIDER", "Unknown OAuth provider."));
  }
  if (!oauthEnabled(provider)) {
    return res.redirect(`${config.appUrl}/oauth/callback?error=not_configured`);
  }
  const state = randomToken(16);
  oauthStateCookie(res, state);
  res.redirect(googleAuthUrl(state));
});

router.get("/oauth/:provider/callback", async (req, res, next) => {
  const provider = req.params.provider as OAuthProvider;
  if (provider !== "google") {
    return next(new ApiError(400, "INVALID_PROVIDER", "Unknown OAuth provider."));
  }
  const fail = (code: string) => res.redirect(`${config.appUrl}/oauth/callback?error=${encodeURIComponent(code)}`);

  try {
    // Provider-side denials (e.g. user clicked "Cancel") can arrive without a
    // valid state, so handle them before the state check.
    if (typeof req.query.error === "string") {
      return fail(req.query.error === "access_denied" ? "cancelled" : "provider_error");
    }
    const state = req.query.state;
    const cookieState = readCookie(req, "oauth_state");
    if (typeof state !== "string" || !cookieState || state !== cookieState) return fail("state_mismatch");
    oauthStateCookie(res, null);

    const code = req.query.code;
    if (typeof code !== "string" || code.length === 0) return fail("missing_code");
    const profile = await exchangeGoogleCode(code);
    const store = await getStore();
    let user = await store.findUserByEmail(profile.email);
    if (user) {
      // Link: backfill avatar if the account doesn't have one yet.
      if (!user.avatarUrl && profile.avatarUrl) {
        await store.updateUser(user.id, { avatarUrl: profile.avatarUrl });
        user.avatarUrl = profile.avatarUrl;
      }
    } else {
      user = await store.createUser({
        name: profile.name,
        email: profile.email,
        // The provider already verified this email — trust it, matching the
        // behavior the test suite encodes (and standard OAuth practice).
        emailVerified: true,
        avatarUrl: profile.avatarUrl,
        passwordHash: null,
      });
    }

    const bundle = await createUserSession(store, user.id, req.ip ?? "unknown", deviceInfo(req));
    setAuthCookies(res, signAccessToken(user.id), bundle.refreshToken, randomToken(16));
    res.redirect(`${config.appUrl}/oauth/callback`);
  } catch (e) {
    console.error("[oauth] callback failed:", (e as Error)?.message ?? e);
    fail("provider_error");
  }
});

export default router;