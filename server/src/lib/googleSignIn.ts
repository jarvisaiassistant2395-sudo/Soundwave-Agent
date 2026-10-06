// ── "Continue with Google": how the app gets its account ────────────────────
// Soundwave has no passwords. On the first launch (and whenever the session is
// gone) the app shows one button; pressing it opens Google in the person's own
// browser — the installed-app (loopback) flow with PKCE, the same shape as
// “Connect YouTube” in lib/youtubeOAuth.ts, so it works exactly the same way in
// the packaged app, with no callback URL to register beyond what Google already
// allows for Desktop clients (any http://127.0.0.1:<port>).
//
// The one thing that differs from the YouTube flow is where the browser lands
// and who holds the session:
//
//   1. the app asks this server to start a sign-in → gets a URL plus a one-time
//      `loginId` and `secret` that only the app knows;
//   2. the person signs in in their browser; Google redirects to this server on
//      loopback, which verifies state + PKCE, reads the account from the ID
//      token, and finds or creates the local account;
//   3. the browser sees a plain "you're signed in, close this tab" page;
//   4. the app, which has been polling with its secret, claims the session and
//      the session cookies are set on *that* response — the app's own cookies.
//
// Step 4 matters: the browser and the app are different cookie jars, so the
// session can only be handed over by the app asking for it, and only someone
// holding the secret from step 1 can claim it. A pending sign-in expires after
// 15 minutes and can be claimed once.

import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { youtubeService } from "./youtube.js";

/**
 * Only identity. Uploading to YouTube, reading Drive or Gmail are separate
 * grants, asked for when that feature is first used — the first launch should
 * not ask for anything more than "who are you".
 */
export const GOOGLE_SIGNIN_SCOPES = ["openid", "email", "profile"];

const TTL_MS = 15 * 60_000;

interface PendingSignIn {
  /** The value Google hands back, tying its redirect to this sign-in. */
  state: string;
  /** Where Google will send the code back (this server, on loopback). */
  redirectUri: string;
  /** The one-time value the app must present to claim the session. */
  secret: string;
  verifier: string;
  at: number;
  /** Filled by the callback; the claim reads it. */
  done: { userId: string; name: string; email: string; avatarUrl?: string } | null;
  failure: { code: string; message: string } | null;
  claimed: boolean;
}

/** The account the callback found and the route saved, as the claim hands it over. */
export interface ClaimedAccount {
  userId: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

const pending = new Map<string, PendingSignIn>();

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class SignInError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function prune(): void {
  const now = Date.now();
  for (const [id, entry] of pending) if (now - entry.at > TTL_MS) pending.delete(id);
}

/** Is sign-in possible on this build? (It needs a Google OAuth client.) */
export function signInConfigured(): boolean {
  return youtubeService.client() !== null;
}

/** What the app tells the person when no Google app is configured here. */
export const NO_CLIENT_MESSAGE =
  "This build doesn't include Soundwave's own Google app yet, so signing in needs a free OAuth client once: in Google Cloud → Google Auth platform → Clients, create one of type “Desktop app”, then paste what you download into the box on this screen and press Continue with Google again.";

export interface StartedSignIn {
  url: string;
  redirectUri: string;
  loginId: string;
  secret: string;
  expiresAt: string;
}

/**
 * Where Google sends the browser back to: the API route that handles the
 * callback. Any loopback port and path is allowed for a Desktop client — it is
 * the *machine* Google trusts here, not a registered address.
 */
export function loopbackCallbackUri(port: number): string {
  return `http://127.0.0.1:${port}/api/v1/auth/google/callback`;
}

/**
 * Begin a sign-in. `redirectUri` is this server's own callback (`loopbackCallbackUri`),
 * which is where Google sends the browser when the person is done.
 */
export function startGoogleSignIn(redirectUri: string): StartedSignIn {
  const client = youtubeService.client();
  if (!client) throw new SignInError("NO_CLIENT", NO_CLIENT_MESSAGE);
  prune();
  const loginId = b64url(randomBytes(18));
  const secret = b64url(randomBytes(32));
  const state = b64url(randomBytes(18));
  const verifier = b64url(randomBytes(48));
  pending.set(loginId, { state, redirectUri, secret, verifier, at: Date.now(), done: null, failure: null, claimed: false });

  const query = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SIGNIN_SCOPES.join(" "),
    include_granted_scopes: "true",
    // No `prompt=consent`: the person is signing in, not granting an API scope,
    // so Google should recognise a browser already signed in and just continue.
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  return {
    url: `${config.googleOAuthAuthUrl}?${query}`,
    redirectUri,
    loginId,
    secret,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
  };
}

/** Which pending sign-in Google's `state` belongs to (the map is tiny). */
function entryForState(state: string): { loginId: string; entry: PendingSignIn } | null {
  for (const [loginId, entry] of pending) {
    if (entry.state === state) return { loginId, entry };
  }
  return null;
}

/**
 * The route saved (or created) the local account for the signed-in Google
 * account; the pending sign-in remembers which, so the claim can hand it over.
 */
export function rememberSignedInUser(loginId: string, userId: string): void {
  const entry = pending.get(loginId);
  if (entry?.done) entry.done.userId = userId;
}

/** Is this request Google coming back from a sign-in we started? */
export function isSignInCallback(query: Record<string, unknown>): boolean {
  return typeof query.state === "string" && entryForState(query.state) !== null;
}

const HINTS: Record<string, string> = {
  access_denied:
    "Google didn't sign you in. If you pressed Cancel, press Continue with Google again. If it says the app is blocked, add your Gmail as a test user (Google Auth platform → Audience → Test users) or press “Publish app”.",
  redirect_uri_mismatch: "The OAuth client isn't a “Desktop app”. In Google Cloud → Google Auth platform → Clients, create one of that type and paste its ID and secret.",
  invalid_client: "Google doesn't recognise the Client ID or secret — copy both again from Google Auth platform → Clients.",
  invalid_grant: "The sign-in code expired or was already used. Press Continue with Google again.",
  org_internal: "This OAuth client only allows accounts from its own organisation. Set the audience to External in Google Auth platform → Audience.",
};

export interface SignInProfile {
  email: string;
  name: string;
  avatarUrl?: string;
}

export type FinishResult = { ok: true; loginId: string; profile: SignInProfile } | { ok: false; loginId: string | null; code: string; message: string };

/** The payload of a Google ID token (JWT), without verifying its signature. */
export interface IdTokenClaims {
  iss?: string;
  aud?: string;
  exp?: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  picture?: string;
}

/** Decode the middle part of a JWT. Null when it isn't one. */
export function decodeIdToken(token: string): IdTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as IdTokenClaims;
    return typeof claims === "object" && claims ? claims : null;
  } catch {
    return null;
  }
}

/**
 * The account in an ID token, once it has been checked against the client that
 * asked for it. The token arrives over TLS straight from Google's token
 * endpoint (the authorization-code flow), which is what makes reading it
 * without re-verifying the signature acceptable — its audience, issuer, expiry
 * and verified email are all still checked.
 */
export function profileFromIdToken(token: string, clientId: string): SignInProfile | null {
  const claims = decodeIdToken(token);
  if (!claims) return null;
  const issuerOk = claims.iss === "accounts.google.com" || claims.iss === "https://accounts.google.com";
  if (!issuerOk) return null;
  if (claims.aud !== clientId) return null;
  if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
  if (!claims.email || claims.email_verified !== true) return null;
  const name = (claims.name || claims.given_name || claims.email.split("@")[0] || "there").trim();
  return { email: claims.email, name, ...(claims.picture ? { avatarUrl: claims.picture } : {}) };
}

/**
 * Google redirected back. Trades the code for tokens and works out who signed
 * in; the caller (routes/auth.ts) then finds or creates the local account.
 */
export async function finishGoogleSignIn(query: Record<string, unknown>): Promise<FinishResult> {
  const state = String(query.state ?? "");
  const found = entryForState(state);
  if (!found) return { ok: false, loginId: null, code: "expired", message: "This sign-in link expired. Press Continue with Google in Soundwave again." };
  const { loginId, entry } = found;

  const fail = (code: string, message?: string): FinishResult => {
    entry.failure = { code, message: message ?? HINTS[code] ?? `Google refused the sign-in: ${code}` };
    return { ok: false, loginId, code, message: entry.failure.message };
  };

  if (typeof query.error === "string") return fail(query.error);
  const client = youtubeService.client();
  if (!client) return fail("no_client", NO_CLIENT_MESSAGE);
  const code = query.code;
  if (typeof code !== "string" || !code) return fail("missing_code", "Google didn't send a sign-in code. Press Continue with Google again.");

  let res: Response;
  try {
    res = await fetch(config.googleOAuthTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        code_verifier: entry.verifier,
        grant_type: "authorization_code",
        redirect_uri: entry.redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return fail("network", `Couldn't reach Google to finish signing in (${(err as Error).message}). Check the internet connection and press Continue with Google again.`);
  }

  const body = (await res.json().catch(() => ({}))) as { id_token?: string; access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok) return fail(body.error ?? `http_${res.status}`, HINTS[body.error ?? ""] ?? `Google refused the sign-in: ${body.error_description || body.error || res.status}`);

  // The account comes from the ID token the token endpoint just returned. It is
  // used only when there is one: a token that *is* there but doesn't check out
  // is a refusal, not something to route around.
  let profile: SignInProfile | null = null;
  if (body.id_token) {
    profile = profileFromIdToken(body.id_token, client.clientId);
    if (!profile) {
      return fail("no_account", "Google signed in but the account details didn't check out. Make sure the OAuth client is the one for this app, then press Continue with Google again.");
    }
  } else if (body.access_token) {
    // Some client configurations return no ID token; ask who the token belongs to.
    profile = await profileFromUserinfo(body.access_token);
    if (!profile) return fail("no_account", "Google didn't say which account signed in. Recreate the Desktop OAuth client and try again.");
  } else {
    return fail("no_account", "Google didn't say which account signed in. Recreate the Desktop OAuth client and try again.");
  }

  entry.done = { userId: "", name: profile.name, email: profile.email, ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}) };
  entry.failure = null;
  return { ok: true, loginId, profile };
}

/**
 * The same account, read from Google's userinfo endpoint. Only used when the
 * token response carried no ID token (some client configurations).
 */
async function profileFromUserinfo(accessToken: string): Promise<SignInProfile | null> {
  try {
    const res = await fetch(config.googleUserinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { sub?: string; email?: string; email_verified?: boolean; name?: string; given_name?: string; picture?: string; aud?: string };
    if (!body.email) return null;
    // userinfo does not carry `aud`; it is answered for the token it was given,
    // which came from this client's own code exchange. The email must be verified.
    if (body.email_verified === false) return null;
    const name = (body.name || body.given_name || body.email.split("@")[0] || "there").trim();
    return { email: body.email, name, ...(body.picture ? { avatarUrl: body.picture } : {}) };
  } catch {
    return null;
  }
}

/** What the app polls: is the sign-in still waiting, done, or refused? */
export type SignInState =
  | { state: "unknown" }
  | { state: "pending" }
  | { state: "failed"; code: string; message: string }
  | { state: "done"; name: string; email: string };

export function readPendingSignIn(loginId: string, secret: string): SignInState {
  prune();
  const entry = pending.get(loginId);
  if (!entry || entry.secret !== secret) return { state: "unknown" };
  if (entry.failure) return { state: "failed", code: entry.failure.code, message: entry.failure.message };
  if (entry.done?.userId) return { state: "done", name: entry.done.name, email: entry.done.email };
  return { state: "pending" };
}

/**
 * The app presents its secret and takes the account. One-time: a claimed
 * sign-in cannot be claimed again, and a wrong secret gets nothing.
 */
export function claimSignIn(loginId: string, secret: string): { ok: true; account: ClaimedAccount } | { ok: false; code: string; message: string } {
  prune();
  const entry = pending.get(loginId);
  if (!entry) return { ok: false, code: "expired", message: "That sign-in expired. Press Continue with Google again." };
  if (entry.secret !== secret) return { ok: false, code: "forbidden", message: "That sign-in belongs to another window." };
  if (entry.claimed) return { ok: false, code: "claimed", message: "That sign-in was already used." };
  if (entry.failure) return { ok: false, code: entry.failure.code, message: entry.failure.message };
  if (!entry.done) return { ok: false, code: "pending", message: "Still waiting for Google." };
  if (!entry.done.userId) return { ok: false, code: "pending", message: "Still finishing the sign-in." };
  entry.claimed = true;
  return { ok: true, account: { ...entry.done, userId: entry.done.userId } };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page the person's browser shows once Google has come back. */
export function signInPage(result: { ok: boolean; title: string; lines: string[] }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Soundwave AI — ${esc(result.title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070b14;color:#e5e7eb;font:16px/1.5 system-ui,sans-serif}main{max-width:520px;padding:32px;border:1px solid #1f2a44;border-radius:18px;background:#0a1224}h1{margin:0 0 12px;font-size:22px;color:${result.ok ? "#34d399" : "#fca5a5"}}p{margin:8px 0}</style></head>
<body><main><h1>${esc(result.title)}</h1>${result.lines.map((l) => `<p>${esc(l)}</p>`).join("")}</main></body></html>`;
}

/** Tests: forget every pending sign-in (mirrors youtubeOAuth's helper). */
export function resetGoogleSignInForTests(): void {
  pending.clear();
}
