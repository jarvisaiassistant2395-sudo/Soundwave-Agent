// ── "Connect YouTube": Google sign-in for the desktop app ───────────────────
// The installed-app (loopback) flow with PKCE. The OAuth client is Soundwave's
// own (shipped in the build → the customer just presses Connect and signs in),
// or, when a build has none, the person's own "Desktop app" client from Google
// Cloud (see the guide). Either way it signs them in through their web browser,
// and Google redirects back to this app on
// http://127.0.0.1:<its port> (any port works for Desktop clients). The
// refresh token is saved without anyone copying tokens around. The callback
// arrives at "/" — the plain loopback address from Google's own examples —
// and is recognized by its one-time `state`.

import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { youtubeService } from "./youtube.js";
import { registerChannel } from "./youtubeChannels.js";

export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];
const TTL_MS = 15 * 60_000;

const pending = new Map<string, { verifier: string; redirectUri: string; at: number }>();

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class ConnectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function prune(): void {
  const now = Date.now();
  for (const [state, p] of pending) if (now - p.at > TTL_MS) pending.delete(state);
}

/** The Google sign-in address to open in the browser. `port`: where this server listens. */
export function startYouTubeConnect(port: number): { url: string; redirectUri: string } {
  const client = youtubeService.client();
  if (!client) {
    throw new ConnectError(
      "NO_CLIENT",
      "This build doesn't include Soundwave's own Google app, so YouTube needs your own free OAuth client once: open “Advanced: your own Google Cloud project” in Settings → YouTube & Shorts, follow the three steps, paste what you get and press Connect.",
    );
  }
  prune();
  const state = b64url(randomBytes(18));
  const verifier = b64url(randomBytes(48));
  const redirectUri = `http://127.0.0.1:${port}`;
  pending.set(state, { verifier, redirectUri, at: Date.now() });
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  return { url: `${config.googleOAuthAuthUrl}?${q}`, redirectUri };
}

/** Is this request Google coming back from a sign-in we started? */
export function isYouTubeCallback(query: Record<string, unknown>): boolean {
  return typeof query.state === "string" && pending.has(query.state) && (typeof query.code === "string" || typeof query.error === "string");
}

const HINTS: Record<string, string> = {
  access_denied:
    "Google didn't give access. If you pressed Cancel, just connect again. If it says the app is blocked or hasn't completed verification, add your Gmail as a test user (Google Auth platform → Audience → Test users) or press “Publish app” there.",
  redirect_uri_mismatch: "Your OAuth client isn't a “Desktop app”. In Google Cloud → Google Auth platform → Clients, create a client of type Desktop app and paste its ID and secret.",
  invalid_client: "Google doesn't recognise the Client ID or secret — copy both again from Google Auth platform → Clients.",
  invalid_grant: "The sign-in code expired or was already used. Press “Connect YouTube account” again.",
  org_internal: "This OAuth client only allows accounts from its own organisation. Set the audience to External in Google Auth platform → Audience.",
};

export type ConnectResult = { ok: true; channelTitle: string | null; warning?: string } | { ok: false; code: string; message: string };

/** Google redirected back: trade the code for tokens and save them. */
export async function finishYouTubeConnect(query: Record<string, unknown>): Promise<ConnectResult> {
  const state = String(query.state);
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry) return { ok: false, code: "expired", message: "This sign-in link expired. Press “Connect YouTube account” in Soundwave again." };
  if (typeof query.error === "string") {
    const code = query.error;
    return { ok: false, code, message: HINTS[code] ?? `Google said: ${code}${typeof query.error_description === "string" ? ` — ${query.error_description}` : ""}` };
  }
  const client = youtubeService.client();
  if (!client) return { ok: false, code: "no_client", message: HINTS.invalid_client ?? "No OAuth client to finish the sign-in with." };
  let res: Response;
  try {
    res = await fetch(config.googleOAuthTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code: String(query.code),
        code_verifier: entry.verifier,
        grant_type: "authorization_code",
        redirect_uri: entry.redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, code: "network", message: `Couldn't reach Google to finish signing in (${(err as Error).message}). Check the internet connection and try again.` };
  }
  const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!res.ok) {
    const code = body.error ?? `http_${res.status}`;
    return { ok: false, code, message: HINTS[code] ?? `Google refused the sign-in: ${body.error_description || code}` };
  }
  if (!body.refresh_token) {
    return { ok: false, code: "no_refresh_token", message: "Google didn't send a refresh token. Remove Soundwave's access at myaccount.google.com/permissions, then connect again." };
  }
  youtubeService.saveConfig({ refreshToken: body.refresh_token, clientSource: client.source, connectedClientId: client.clientId });
  if (body.access_token) youtubeService.saveConfig({ accessToken: body.access_token, tokenExpiry: Date.now() + (body.expires_in ?? 3600) * 1000 });
  const granted = (body.scope ?? "").split(/\s+/);
  const test = await youtubeService.testConnection();
  if (test.ok) {
    // Every sign-in is a channel (lib/youtubeChannels.ts): the first one is the
    // channel the app had before, the next ones are added next to it.
    registerChannel({
      refreshToken: body.refresh_token,
      channelTitle: test.channelTitle ?? null,
      channelId: test.channelId ?? null,
      clientSource: client.source,
      connectedClientId: client.clientId,
    });
    return { ok: true, channelTitle: test.channelTitle ?? null };
  }
  const missingRead = !granted.includes(YOUTUBE_SCOPES[1]!);
  return {
    ok: true,
    channelTitle: null,
    warning: missingRead
      ? "Uploading is allowed, but Soundwave can't read your channel's name and numbers — connect again and allow both permissions."
      : `Connected, but YouTube didn't return a channel: ${test.error ?? "unknown error"}. Make sure this Google account has a YouTube channel.`,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page the browser shows after Google redirects back. */
export function connectPage(r: ConnectResult): string {
  const title = r.ok ? (r.warning ? "YouTube is connected — with a warning" : "YouTube is connected") : "YouTube isn't connected";
  const lines = r.ok
    ? [r.channelTitle ? `Channel: <b>${esc(r.channelTitle)}</b>` : "", r.warning ? esc(r.warning) : "", "You can close this tab and go back to Soundwave AI."]
    : [esc(r.message), "Close this tab and try again in Soundwave AI (Command Center → gear → YouTube &amp; Shorts)."];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Soundwave AI — ${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070b14;color:#e5e7eb;font:16px/1.5 system-ui,sans-serif}main{max-width:520px;padding:32px;border:1px solid #1f2a44;border-radius:18px;background:#0a1224}h1{margin:0 0 12px;font-size:22px;color:${r.ok ? "#34d399" : "#fca5a5"}}p{margin:8px 0}</style></head>
<body><main><h1>${esc(title)}</h1>${lines.filter(Boolean).map((l) => `<p>${l}</p>`).join("")}</main></body></html>`;
}

/** Tests: forget pending sign-ins. */
export function resetYouTubeConnectForTests(): void {
  pending.clear();
}
