// ── OAuth (Google) — authorization-code flow ────────────────────────────────
// No SDKs — plain fetch against the provider's token/userinfo endpoints.
// Users are matched by email: an existing account is linked, otherwise a new
// email-verified account is created. The redirect URI is always the app's own
// /api/v1/auth/oauth/<provider>/callback (proxied to this server in dev).

import { config } from "../config.js";

export type OAuthProvider = "google";

export interface OAuthProfile {
  email: string;
  name: string;
  avatarUrl: string | null;
}

export function oauthEnabled(provider: OAuthProvider): boolean {
  if (provider === "google") return Boolean(config.googleClientId && config.googleClientSecret);
  return false;
}

export function oauthRedirectUri(provider: OAuthProvider): string {
  return `${config.appUrl}/api/v1/auth/oauth/${provider}/callback`;
}

// ── Authorization URLs ──────────────────────────────────────────────────────
export function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: oauthRedirectUri("google"),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ── Code exchange ───────────────────────────────────────────────────────────
async function postForm(url: string, body: Record<string, string>): Promise<Record<string, string>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`OAuth token exchange failed (${res.status})`);
  return (await res.json()) as Record<string, string>;
}

export async function exchangeGoogleCode(code: string): Promise<OAuthProfile> {
  const token = await postForm("https://oauth2.googleapis.com/token", {
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: oauthRedirectUri("google"),
    grant_type: "authorization_code",
  });
  const info = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!info.ok) throw new Error(`Google userinfo failed (${info.status})`);
  const u = (await info.json()) as { email?: string; name?: string; picture?: string };
  if (!u.email) throw new Error("Google did not return an email address.");
  return {
    email: u.email,
    name: u.name || u.email.split("@")[0] || "User",
    avatarUrl: u.picture ?? null,
  };
}
