// ── Who you are: one button, one Google account ─────────────────────────────
// Soundwave signs in with Google and nothing else — there are no passwords to
// make, forget or reset, and no second account to keep. The flow (lib/
// googleSignIn.ts) is the installed-app one: the app opens Google in the
// person's browser, Google redirects back to this server on loopback, and the
// app claims the session with a secret only it knows.
//
//   GET    /api/v1/auth/providers      is Google sign-in available on this build?
//   POST   /api/v1/auth/google/start   { url, loginId, secret } — open `url` in a browser
//   GET    /api/v1/auth/google/callback  Google lands here (browser); shows a plain page
//   GET    /api/v1/auth/google/wait    ?loginId&secret — the app polls until it is done
//   POST   /api/v1/auth/google/claim   the app takes the session (sets its cookies)
//   GET    /api/v1/auth/session        who is signed in
//   GET    /api/v1/auth/sessions       the devices signed in (this PC's windows, the phone…)
//   DELETE /api/v1/auth/sessions       sign out everywhere
//   POST   /api/v1/auth/signout        sign out here
//   POST   /api/v1/auth/refresh        rotate the session cookies
//   POST   /api/v1/auth/dev-session    development only, and only without a Google app
//
// The session is permanent by design: this is a desktop app on the person's own
// PC, so "sign in again next week" would be a bug, not security. Signing out is
// the person's own act, from the profile banner or Settings.

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ApiError } from "../middleware/error.js";
import { config } from "../config.js";
import { localAppGuard } from "../middleware/localApp.js";
import { authSignInLimiter } from "../lib/security.js";
import { clearAuthCookies, createUserSession, publicUser, randomToken, setAuthCookies, sha256, signAccessToken, verifyRefreshToken } from "../lib/auth.js";
import { getStore } from "../lib/store.js";
import { deviceInfo, requireAuth } from "../middleware/auth.js";
import {
  SignInError,
  claimSignIn,
  finishGoogleSignIn,
  isSignInCallback,
  loopbackCallbackUri,
  readPendingSignIn,
  rememberSignedInUser,
  signInConfigured,
  signInPage,
  startGoogleSignIn,
} from "../lib/googleSignIn.js";

const router = Router();

/** The port Google should redirect back to: this server's own. */
function serverPort(req: Request): number {
  const fromEnv = Number(process.env.PORT);
  const header = String(req.headers.host ?? "").split(":")[1];
  const port = Number.isFinite(Number(header)) && Number(header) > 0 ? Number(header) : Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 4000;
  return port;
}

// ── Who can sign in ─────────────────────────────────────────────────────────

/** True when this build has no Google app of its own and isn't a packaged build. */
function devSignInAllowed(): boolean {
  return !config.isProd && !signInConfigured();
}

/**
 * What the welcome screen needs to know before anyone presses anything: is
 * there a Google app to sign in with, and (development builds with none) may
 * this PC be opened without one.
 */
router.get("/providers", (_req, res) => {
  const google = signInConfigured();
  res.json({ providers: { google }, configured: google, devSignIn: devSignInAllowed() });
});

// ── The sign-in itself ──────────────────────────────────────────────────────

router.post("/google/start", authSignInLimiter, (req, res, next) => {
  try {
    const started = startGoogleSignIn(loopbackCallbackUri(serverPort(req)));
    res.json({ ...started, devSignIn: devSignInAllowed() });
  } catch (err) {
    if (err instanceof SignInError) return next(new ApiError(409, err.code, err.message));
    next(err);
  }
});

//  1. GET /google/start     → the app gets a URL and opens it in the browser
//  2. GET /google/callback  → Google redirects the browser here; the browser
//                             sees a plain page, the app is told separately

router.get("/google/callback", async (req, res) => {
  const query = req.query as Record<string, unknown>;
  // Google can be told "no": the address it returns with an error and no state
  // we know is not a sign-in we started.
  if (typeof query.error === "string" && !isSignInCallback(query)) {
    return res
      .status(400)
      .type("html")
      .send(
        signInPage({
          ok: false,
          title: "Soundwave AI — sign-in wasn't finished",
          lines: ["Google reported that the sign-in was cancelled or refused.", "Go back to Soundwave and press Continue with Google to try again."],
        }),
      );
  }
  try {
    const result = await finishGoogleSignIn(query);
    if (!result.ok) {
      return res
        .status(400)
        .type("html")
        .send(signInPage({ ok: false, title: "Soundwave AI — sign-in failed", lines: [result.message, "Close this tab, go back to Soundwave, and press Continue with Google again."] }));
    }

    // Find or create the local account for this Google account, then tell the
    // pending sign-in who it is so the app can claim it.
    const store = await getStore();
    let user = await store.findUserByEmail(result.profile.email);
    if (user) {
      if (result.profile.avatarUrl && !user.avatarUrl) {
        await store.updateUser(user.id, { avatarUrl: result.profile.avatarUrl });
        user = (await store.findUserById(user.id)) ?? user;
      }
      // A returning person may have renamed themselves in Soundwave; Google's
      // name is only a starting point, so it is not written over theirs.
    } else {
      user = await store.createUser({
        email: result.profile.email,
        name: result.profile.name,
        avatarUrl: result.profile.avatarUrl ?? null,
      });
    }
    rememberSignedInUser(result.loginId, user.id);

    res
      .status(200)
      .type("html")
      .send(
        signInPage({
          ok: true,
          title: "Soundwave AI — you're signed in",
          lines: [`Signed in as ${user.email}.`, "Close this tab and go back to Soundwave — it is already waiting for you."],
        }),
      );
  } catch (err) {
    console.error("[signin] callback failed:", (err as Error)?.message ?? err);
    res
      .status(500)
      .type("html")
      .send(signInPage({ ok: false, title: "Soundwave AI — sign-in failed", lines: ["Something went wrong finishing the sign-in.", "Close this tab and press Continue with Google in Soundwave again."] }));
  }
});

/** The app polls this while the browser is open (no cookies yet). */
router.get("/google/wait", (req, res) => {
  const loginId = String(req.query.loginId ?? "");
  const secret = String(req.query.secret ?? "");
  res.json(readPendingSignIn(loginId, secret));
});

const claimSchema = z.object({ loginId: z.string().min(8).max(200), secret: z.string().min(8).max(200) });

router.post("/google/claim", authSignInLimiter, validate({ body: claimSchema }), async (req, res, next) => {
  try {
    const { loginId, secret } = req.body as z.infer<typeof claimSchema>;
    const claimed = claimSignIn(loginId, secret);
    if (!claimed.ok) {
      const status = claimed.code === "pending" ? 202 : claimed.code === "forbidden" ? 403 : 409;
      return res.status(status).json({ error: { code: claimed.code.toUpperCase(), message: claimed.message } });
    }
    const store = await getStore();
    const user = await store.findUserById(claimed.account.userId);
    if (!user) throw new ApiError(409, "NO_ACCOUNT", "That account is no longer here. Press Continue with Google again.");
    // Permanent: this is the person's own PC, and a session that expires would
    // mean signing in again for no reason. Signing out is deliberate.
    const bundle = await createUserSession(store, user.id, req.ip ?? "unknown", deviceInfo(req), { permanent: true });
    setAuthCookies(res, signAccessToken(user.id), bundle.refreshToken, randomToken(16));
    res.json({ user: publicUser(user), signedIn: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Development only: a local build with no Google app configured (no OAuth
 * client in the build, no `credentials.json`) can still be opened, so the app
 * can be worked on offline. A packaged build has NODE_ENV=production and a
 * client, and this route simply is not there — the app window is still gated.
 */
router.post("/dev-session", authSignInLimiter, localAppGuard(devSignInAllowed, "Sign-in is only available with Google."), async (req, res, next) => {
  try {
    const store = await getStore();
    const email = "dev@soundwave.local";
    let user = await store.findUserByEmail(email);
    if (!user) user = await store.createUser({ email, name: "Local development" });
    const bundle = await createUserSession(store, user.id, req.ip ?? "unknown", deviceInfo(req), { permanent: true });
    setAuthCookies(res, signAccessToken(user.id), bundle.refreshToken, randomToken(16));
    res.json({ user: publicUser(user), signedIn: true, development: true });
  } catch (err) {
    next(err);
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
    res.json({
      sessions: sessions.map((s) => ({ id: s.id, deviceInfo: s.deviceInfo, ipAddress: s.ipAddress, lastActiveAt: s.lastActiveAt, createdAt: s.createdAt, permanent: s.expiresAt === null })),
    });
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

function readRefreshCookie(req: Request): string | null {
  const raw = req.headers.cookie ?? "";
  const m = raw.match(/(?:^|;\s*)refresh_token=([^;]*)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

router.post("/signout", async (req, res, next) => {
  try {
    const token = readRefreshCookie(req);
    if (token) {
      const claims = verifyRefreshToken(token);
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

router.post("/refresh", async (req, res, next) => {
  try {
    const token = readRefreshCookie(req);
    if (!token) throw new ApiError(401, "UNAUTHORIZED", "No session.");
    const claims = verifyRefreshToken(token);
    if (!claims) throw new ApiError(401, "UNAUTHORIZED", "Session expired.");
    const store = await getStore();
    const session = await store.findSessionById(claims.sid);
    if (!session) throw new ApiError(401, "UNAUTHORIZED", "Session expired.");
    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
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
    const bundle = await createUserSession(store, user.id, req.ip ?? "unknown", session.deviceInfo, { permanent: session.expiresAt === null });
    setAuthCookies(res, signAccessToken(user.id), bundle.refreshToken, randomToken(16));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
