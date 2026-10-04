// Gmail access for the desktop agent. The agent may read inbox messages and
// create unsent drafts; sending is deliberately not exposed as an agent tool.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { JSDOM } from "jsdom";
import { config } from "../config.js";
import { youtubeService } from "./youtube.js";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;
const STATE_TTL_MS = 15 * 60_000;
const MAX_BODY_CHARS = 12_000;
const MAX_LIST = 10;

interface GmailConfig {
  email: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
  clientSource: "own" | "built-in";
  connectedClientId: string;
}
interface PendingConnect {
  verifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  clientSource: "own" | "built-in";
  at: number;
}
export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  body?: string;
}
export interface GmailDraft {
  id: string;
  threadId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: string[];
  fingerprint: string;
}

const pending = new Map<string, PendingConnect>();
const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const decodeBase64Url = (value: string) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const safeHeader = (value: string) => value.replace(/[\r\n\0]/g, " ").trim();

function fileFor(): string {
  return path.join(config.dataDir, "gmail", "gmail_config.json");
}
function readConfig(): GmailConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as Partial<GmailConfig>;
    if (!raw.email || !raw.refreshToken || !raw.connectedClientId || !raw.clientSource) return null;
    return raw as GmailConfig;
  } catch {
    return null;
  }
}
function saveConfig(value: GmailConfig): void {
  const file = fileFor();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    // Windows ACLs protect the per-user app-data directory instead.
  }
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function compactFingerprint(draft: Pick<GmailDraft, "threadId" | "to" | "cc" | "bcc" | "subject" | "body" | "attachments">): string {
  return createHash("sha256").update(JSON.stringify([draft.threadId, draft.to, draft.cc, draft.bcc, draft.subject, draft.body, draft.attachments])).digest("hex");
}

function collectParts(payload: any, out: Array<{ mimeType: string; data: string }> = []): Array<{ mimeType: string; data: string }> {
  if (!payload || payload.filename) return out;
  if (payload.body?.data && typeof payload.body.data === "string") out.push({ mimeType: String(payload.mimeType ?? ""), data: payload.body.data });
  for (const part of Array.isArray(payload.parts) ? payload.parts : []) collectParts(part, out);
  return out;
}
function plainTextFromHtml(html: string): string {
  const dom = new JSDOM(html);
  try {
    dom.window.document.querySelectorAll("script, style, head, title, svg").forEach((node) => node.remove());
    return (dom.window.document.body.textContent ?? "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  } finally {
    dom.window.close();
  }
}
function messageBody(payload: any): string {
  const parts = collectParts(payload);
  const plain = parts.find((p) => p.mimeType.toLowerCase() === "text/plain");
  const html = parts.find((p) => p.mimeType.toLowerCase() === "text/html");
  const data = plain?.data ?? html?.data ?? payload?.body?.data;
  if (typeof data !== "string") return "";
  // Bound before decoding or parsing HTML: message bodies can be arbitrarily large.
  const decoded = decodeBase64Url(data.slice(0, MAX_BODY_CHARS * 8)).toString("utf8");
  return (plain ? decoded : plainTextFromHtml(decoded)).slice(0, MAX_BODY_CHARS);
}
function attachmentNames(payload: any, out: string[] = []): string[] {
  if (!payload) return out;
  if (typeof payload.filename === "string" && payload.filename.trim()) out.push(safeHeader(payload.filename).slice(0, 200));
  for (const part of Array.isArray(payload.parts) ? payload.parts : []) attachmentNames(part, out);
  return [...new Set(out)].slice(0, 20);
}
function headersOf(payload: any): Map<string, string> {
  const headers = new Map<string, string>();
  for (const item of Array.isArray(payload?.headers) ? payload.headers : []) {
    if (typeof item?.name === "string" && typeof item?.value === "string") headers.set(item.name.toLowerCase(), safeHeader(item.value));
  }
  return headers;
}
function emailAddress(value: string): string {
  const match = value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/i);
  return match?.[0] ?? "";
}
function mapMessage(raw: any, includeBody = false): GmailMessage {
  const headers = headersOf(raw?.payload);
  return {
    id: String(raw?.id ?? ""),
    threadId: String(raw?.threadId ?? ""),
    from: headers.get("from") ?? "",
    to: headers.get("to") ?? "",
    subject: headers.get("subject") ?? "(no subject)",
    date: headers.get("date") ?? "",
    snippet: String(raw?.snippet ?? "").slice(0, 600),
    unread: Array.isArray(raw?.labelIds) && raw.labelIds.includes("UNREAD"),
    ...(includeBody ? { body: messageBody(raw?.payload) } : {}),
  };
}
function base64Lines(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}
function encodedHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
function rawReply(to: string, subject: string, body: string, original: GmailMessage, originalHeaders: Map<string, string>): string {
  const messageId = safeHeader(originalHeaders.get("message-id") ?? "");
  const references = [safeHeader(originalHeaders.get("references") ?? ""), messageId].filter(Boolean).join(" ").slice(-2000);
  const headers = [
    `To: ${to}`,
    `Subject: ${encodedHeader(subject)}`,
    ...(messageId ? [`In-Reply-To: ${messageId}`] : []),
    ...(references ? [`References: ${references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(body, "utf8").toString("base64")),
  ];
  return headers.join("\r\n");
}

export class GmailError extends Error {
  constructor(message: string, readonly status = 502, readonly code = "GMAIL_ERROR") {
    super(message);
    this.name = "GmailError";
  }
}

class GmailService {
  status(): { connected: boolean; email: string | null; needsReconnect: boolean } {
    const saved = readConfig();
    if (!saved) return { connected: false, email: null, needsReconnect: false };
    const client = youtubeService.client();
    const connected = Boolean(client && client.clientId === saved.connectedClientId && client.source === saved.clientSource);
    return { connected, email: connected ? saved.email : null, needsReconnect: !connected };
  }

  disconnect(): void {
    const file = fileFor();
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }

  async finishConnect(query: Record<string, unknown>): Promise<{ ok: boolean; email?: string; message?: string }> {
    const state = typeof query.state === "string" ? query.state : "";
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || Date.now() - entry.at > STATE_TTL_MS) return { ok: false, message: "That Gmail sign-in expired. Start again from Settings → Email." };
    if (typeof query.error === "string") return { ok: false, message: query.error === "access_denied" ? "Google didn't give Soundwave access. You can try again whenever you're ready." : `Google refused the sign-in (${safeHeader(query.error)}).` };
    if (typeof query.code !== "string") return { ok: false, message: "Google didn't return a sign-in code. Try connecting again." };

    let response: Response;
    try {
      response = await fetch(config.googleOAuthTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: entry.clientId,
          client_secret: entry.clientSecret,
          code: query.code,
          code_verifier: entry.verifier,
          grant_type: "authorization_code",
          redirect_uri: entry.redirectUri,
        }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return { ok: false, message: `Couldn't reach Google to finish signing in: ${(err as Error).message}` };
    }
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!response.ok || !data.access_token || !data.refresh_token) {
      return { ok: false, message: `Google couldn't connect Gmail: ${safeHeader(data.error_description ?? data.error ?? `HTTP ${response.status}`)}. Check the Gmail API and OAuth consent settings, then try again.` };
    }
    const granted = new Set((data.scope ?? "").split(/\s+/));
    if (GMAIL_SCOPES.some((scope) => !granted.has(scope))) {
      return { ok: false, message: "Google did not grant both Gmail permissions. Reconnect and allow reading email and creating drafts." };
    }
    let profile: { emailAddress?: string };
    try {
      profile = await this.requestJson("/users/me/profile", data.access_token);
    } catch (err) {
      return { ok: false, message: `Gmail connected, but Soundwave couldn't read the account address: ${(err as Error).message}` };
    }
    const email = String(profile.emailAddress ?? "").trim();
    if (!email || !email.includes("@")) return { ok: false, message: "Google didn't return a Gmail address for this account." };
    saveConfig({
      email,
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      tokenExpiry: Date.now() + (data.expires_in ?? 3600) * 1000,
      clientSource: entry.clientSource,
      connectedClientId: entry.clientId,
    });
    return { ok: true, email };
  }

  async listInbox(query = "", limit = 8): Promise<GmailMessage[]> {
    const safeLimit = Math.min(MAX_LIST, Math.max(1, Math.round(limit) || 8));
    const params = new URLSearchParams({ maxResults: String(safeLimit), labelIds: "INBOX" });
    if (query.trim()) params.set("q", query.trim().slice(0, 500));
    const result = await this.requestJson(`/users/me/messages?${params.toString()}`) as { messages?: Array<{ id?: string }> };
    const rows = Array.isArray(result.messages) ? result.messages : [];
    return Promise.all(rows.filter((m) => typeof m.id === "string").map(async (m) => {
      const raw = await this.requestJson(`/users/me/messages/${encodeURIComponent(m.id!)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
      return mapMessage(raw);
    }));
  }

  async readMessage(id: string): Promise<GmailMessage> {
    const raw = await this.requestJson(`/users/me/messages/${encodeURIComponent(id)}?format=full`);
    return mapMessage(raw, true);
  }

  async createReplyDraft(messageId: string, body: string): Promise<{ id: string; threadId: string; to: string; subject: string }> {
    const originalRaw = await this.requestJson(`/users/me/messages/${encodeURIComponent(messageId)}?format=full`);
    const original = mapMessage(originalRaw, true);
    const originalHeaders = headersOf(originalRaw?.payload);
    const to = emailAddress(originalHeaders.get("reply-to") ?? original.from);
    if (!to) throw new GmailError("I couldn't find a safe reply address on that email, so I didn't create a draft.", 422, "NO_REPLY_ADDRESS");
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    const threadId = String(originalRaw?.threadId ?? original.threadId);
    const raw = rawReply(to, safeHeader(subject).slice(0, 500), body.trim().slice(0, MAX_BODY_CHARS), original, originalHeaders);
    const created = await this.requestJson("/users/me/drafts", undefined, { method: "POST", body: JSON.stringify({ message: { raw: b64url(raw), threadId } }) }) as { id?: string; message?: { threadId?: string } };
    if (!created.id) throw new GmailError("Gmail did not return an ID for the saved draft.");
    return { id: created.id, threadId: created.message?.threadId ?? threadId, to, subject };
  }

  async getDraft(id: string): Promise<GmailDraft> {
    const raw = await this.requestJson(`/users/me/drafts/${encodeURIComponent(id)}?format=full`);
    const message = raw?.message ?? {};
    const headers = headersOf(message.payload);
    const draft = {
      id: String(raw?.id ?? id),
      threadId: String(message.threadId ?? ""),
      to: headers.get("to") ?? "",
      cc: headers.get("cc") ?? "",
      bcc: headers.get("bcc") ?? "",
      subject: headers.get("subject") ?? "(no subject)",
      body: messageBody(message.payload),
      attachments: attachmentNames(message.payload),
    };
    return { ...draft, fingerprint: compactFingerprint(draft) };
  }

  async sendDraft(id: string, expectedFingerprint: string): Promise<{ messageId: string; threadId: string }> {
    const draft = await this.getDraft(id);
    if (draft.attachments.length) throw new GmailError("This draft has attachments. Review and send it directly in Gmail instead.", 409, "ATTACHMENTS_REQUIRE_GMAIL");
    if (draft.fingerprint !== expectedFingerprint) throw new GmailError("This draft changed after you reviewed it. Close the confirmation and review the latest version before sending.", 409, "DRAFT_CHANGED");
    const sent = await this.requestJson("/users/me/drafts/send", undefined, { method: "POST", body: JSON.stringify({ id }) }) as { id?: string; threadId?: string };
    return { messageId: String(sent.id ?? ""), threadId: String(sent.threadId ?? draft.threadId) };
  }

  private async requestJson(pathname: string, accessToken?: string, init: RequestInit = {}): Promise<any> {
    const token = accessToken ?? await this.accessToken();
    let response: Response;
    try {
      response = await fetch(`${config.gmailApiBase}/gmail/v1${pathname}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new GmailError(`Couldn't reach Gmail: ${(err as Error).message}`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = (data as any)?.error?.errors?.[0]?.reason ?? (data as any)?.error?.status ?? "";
      if (response.status === 401 || code === "invalid_grant") throw new GmailError("Gmail access expired. Reconnect Gmail in Settings → Email.", 401, "RECONNECT_REQUIRED");
      throw new GmailError(`Gmail request failed (${response.status}). Check that Gmail API is enabled and the connected account has access.`, response.status, "GMAIL_API_ERROR");
    }
    return data;
  }

  private async accessToken(): Promise<string> {
    const saved = readConfig();
    const client = youtubeService.client();
    if (!saved) throw new GmailError("Connect Gmail in Settings → Email before using email tools.", 409, "NOT_CONNECTED");
    if (!client || client.clientId !== saved.connectedClientId || client.source !== saved.clientSource) throw new GmailError("The Google OAuth client changed. Reconnect Gmail in Settings → Email.", 409, "RECONNECT_REQUIRED");
    if (saved.accessToken && saved.tokenExpiry && saved.tokenExpiry > Date.now() + 60_000) return saved.accessToken;
    let response: Response;
    try {
      response = await fetch(config.googleOAuthTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: saved.refreshToken, grant_type: "refresh_token" }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new GmailError(`Couldn't refresh Gmail access: ${(err as Error).message}`);
    }
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!response.ok || !data.access_token) {
      if (data.error === "invalid_grant") throw new GmailError("Gmail access expired. Reconnect Gmail in Settings → Email.", 401, "RECONNECT_REQUIRED");
      throw new GmailError(`Couldn't refresh Gmail access (${response.status}). Reconnect Gmail in Settings → Email.`, 401, "RECONNECT_REQUIRED");
    }
    const updated = { ...saved, accessToken: data.access_token, tokenExpiry: Date.now() + (data.expires_in ?? 3600) * 1000 };
    saveConfig(updated);
    return updated.accessToken!;
  }
}

export const gmailService = new GmailService();

export function startGmailConnect(port: number): { url: string; redirectUri: string } {
  const client = youtubeService.client();
  if (!client) throw new GmailError("Set up a Google OAuth client in Settings → YouTube & Shorts before connecting Gmail.", 409, "NO_GOOGLE_CLIENT");
  for (const [state, value] of pending) if (Date.now() - value.at > STATE_TTL_MS) pending.delete(state);
  const state = randomBytes(18).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const redirectUri = `http://127.0.0.1:${port}`;
  pending.set(state, { verifier, redirectUri, clientId: client.clientId, clientSecret: client.clientSecret, clientSource: client.source, at: Date.now() });
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [...GMAIL_SCOPES, "openid", "email"].join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return { url: `${config.googleOAuthAuthUrl}?${params}`, redirectUri };
}

export function isGmailCallback(query: Record<string, unknown>): boolean {
  return typeof query.state === "string" && pending.has(query.state) && (typeof query.code === "string" || typeof query.error === "string");
}

export async function finishGmailConnect(query: Record<string, unknown>) {
  return gmailService.finishConnect(query);
}

export function gmailConnectPage(result: { ok: boolean; email?: string; message?: string }): string {
  const title = result.ok ? "Gmail connected" : "Gmail isn't connected";
  const content = result.ok
    ? `Soundwave can now read ${escapeHtml(result.email ?? "your Gmail")}, create unsent drafts, and will ask before sending anything. You can close this tab and return to Soundwave.`
    : `${escapeHtml(result.message ?? "The sign-in did not finish.")} Close this tab and return to Soundwave to try again.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} — Soundwave AI</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070b14;color:#e5e7eb;font:16px/1.5 system-ui,sans-serif}main{max-width:540px;padding:32px;border:1px solid #1f2a44;border-radius:18px;background:#0a1224}h1{margin:0 0 12px;color:${result.ok ? "#34d399" : "#fca5a5"};font-size:22px}p{margin:8px 0}</style></head><body><main><h1>${title}</h1><p>${content}</p></main></body></html>`;
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function resetGmailForTests(): void {
  pending.clear();
  gmailService.disconnect();
}
