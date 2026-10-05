// Gmail (and the rest of the Google account) for the desktop agent.
//
// The agent may search and read the inbox, save drafts, and — when the person
// tells it to — send email. Sending is guarded rather than forbidden: it needs
// a connection, the "let the agent send" switch in Settings → Email (on by
// default), and it respects a daily cap, refuses duplicate sends, and records
// everything it sends so the person can see exactly what went out. The only
// thing it will never do is send something nobody asked for, or take an
// instruction from inside an email.
//
// Contacts, Calendar and Drive are read-only and optional: they use the same
// token, and each says "not granted" (asking for a reconnect) when the person
// didn't allow it.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { JSDOM } from "jsdom";
import { config } from "../config.js";
import { youtubeService } from "./youtube.js";

/** Required for Gmail: read messages, create drafts and (via compose) send. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;
/**
 * Asked for together with Gmail, but optional: a person may allow only email.
 * Gmail's own permission covers sending, so these are about knowing who to
 * write to, when they're free, and which file they mean.
 */
export const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
] as const;
export const ALL_GOOGLE_SCOPES = [...GMAIL_SCOPES, ...WORKSPACE_SCOPES] as const;
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
  /** What Google actually granted (missing on connections made before this). */
  scopes?: string[];
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

/** The switch and cap behind "the agent can send email" (Settings → Email). */
export interface GmailSendPolicy {
  /** When off, the agent may only save drafts — never send. */
  enabled: boolean;
  /** Most emails the agent may send in one day (1–200). */
  dailyLimit: number;
}

export interface GmailSentEntry {
  at: number;
  to: string;
  subject: string;
  messageId: string;
  threadId: string;
  /** "agent" = the assistant sent it from chat; "app" = the person pressed Send. */
  source: "agent" | "app";
  /** Hash of the body, so an identical re-send can be recognised without keeping the text. */
  bodyHash?: string;
}

export const DEFAULT_SEND_POLICY: GmailSendPolicy = { enabled: true, dailyLimit: 25 };
/** Two identical emails inside this window is a mistake, not a follow-up. */
const DUPLICATE_WINDOW_MS = 5 * 60_000;
const MAX_PER_FIELD = 10;
const MAX_SENT_KEPT = 200;

/** Where the policy and the record of what was sent live (both per-user, local). */
function policyFile(): string {
  return path.join(config.dataDir, "gmail", "sending.json");
}
function sentFile(): string {
  return path.join(config.dataDir, "gmail", "sent.json");
}
function agentDraftsFile(): string {
  return path.join(config.dataDir, "gmail", "agent_drafts.json");
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as T;
    return raw && typeof raw === "object" ? raw : fallback;
  } catch {
    return fallback;
  }
}
function writeJsonFile(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

export function gmailSendPolicy(): GmailSendPolicy {
  const raw = readJsonFile<Partial<GmailSendPolicy>>(policyFile(), {});
  const dailyLimit = Number.isFinite(Number(raw.dailyLimit)) ? Math.min(200, Math.max(1, Math.round(Number(raw.dailyLimit)))) : DEFAULT_SEND_POLICY.dailyLimit;
  return { enabled: raw.enabled !== false, dailyLimit };
}

export function saveGmailSendPolicy(patch: Partial<GmailSendPolicy>): GmailSendPolicy {
  const next: GmailSendPolicy = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : gmailSendPolicy().enabled,
    dailyLimit:
      patch.dailyLimit === undefined
        ? gmailSendPolicy().dailyLimit
        : Math.min(200, Math.max(1, Math.round(Number(patch.dailyLimit) || DEFAULT_SEND_POLICY.dailyLimit))),
  };
  writeJsonFile(policyFile(), next);
  return next;
}

/** Newest first: what this account has sent through Soundwave (agent and person). */
export function gmailSentLog(limit = 20): GmailSentEntry[] {
  const raw = readJsonFile<{ sent?: GmailSentEntry[] }>(sentFile(), {});
  const list = Array.isArray(raw.sent) ? raw.sent : [];
  return list.slice(0, Math.max(1, Math.min(MAX_SENT_KEPT, limit)));
}

function recordSent(entry: GmailSentEntry): void {
  const list = gmailSentLog(MAX_SENT_KEPT);
  writeJsonFile(sentFile(), { sent: [entry, ...list].slice(0, MAX_SENT_KEPT) });
  // The chat message already says what was sent; this is for the log on the page.
  console.log(`[gmail] sent "${entry.subject}" to ${entry.to} (${entry.source})`);
}

/** Agent sends so far today (the cap counts only what the assistant sent). */
export function gmailAgentSendsToday(now = new Date()): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return gmailSentLog(MAX_SENT_KEPT).filter((entry) => entry.source === "agent" && entry.at >= start).length;
}

/** Email address(es) as written → the list Gmail should receive, or the bad ones. */
export function parseRecipients(value: string): { list: string[]; invalid: string[] } {
  const parts = String(value ?? "")
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const list: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of parts.slice(0, MAX_PER_FIELD)) {
    const address = emailAddress(part);
    if (!address) {
      invalid.push(safeHeader(part).slice(0, 80));
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(safeHeader(address));
  }
  if (parts.length > MAX_PER_FIELD) invalid.push(`(more than ${MAX_PER_FIELD} addresses)`);
  return { list, invalid };
}

function recipientHeader(value: string, field: string): string {
  if (!String(value ?? "").trim()) return "";
  const { list, invalid } = parseRecipients(value);
  if (invalid.length) throw new GmailError(`That doesn't look like a valid ${field} address: ${invalid.join(", ")}. Nothing was sent.`, 422, "BAD_RECIPIENT");
  return list.join(", ");
}

/** The plain-text MIME Gmail is asked to send (base64 body, per the API's raw format). */
export function composeRaw(fields: {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers: string[] = [];
  const to = recipientHeader(fields.to ?? "", "To");
  const cc = recipientHeader(fields.cc ?? "", "Cc");
  const bcc = recipientHeader(fields.bcc ?? "", "Bcc");
  if (to) headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  const subject = safeHeader(fields.subject ?? "").slice(0, 500);
  if (subject) headers.push(`Subject: ${encodedHeader(subject)}`);
  const inReplyTo = safeHeader(fields.inReplyTo ?? "");
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  const references = safeHeader(fields.references ?? "");
  if (references) headers.push(`References: ${references.slice(-2000)}`);
  headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "");
  headers.push(base64Lines(Buffer.from(fields.body, "utf8").toString("base64")));
  return b64url(headers.join("\r\n"));
}

const pending = new Map<string, PendingConnect>();
const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const decodeBase64Url = (value: string) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const safeHeader = (value: string) => value.replace(/[\r\n\0]/g, " ").trim();
/** A short, stable fingerprint of a message body (never the text itself). */
const bodySignature = (body: string) => createHash("sha256").update(body.trim()).digest("hex").slice(0, 32);

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
  status(): {
    connected: boolean;
    email: string | null;
    needsReconnect: boolean;
    /** Which of the optional Google permissions this connection actually has. */
    scopes: { gmail: boolean; contacts: boolean; calendar: boolean; drive: boolean };
    sending: GmailSendPolicy & { sentToday: number; remaining: number };
  } {
    const saved = readConfig();
    const policy = gmailSendPolicy();
    const sentToday = saved ? gmailAgentSendsToday() : 0;
    const sending = { ...policy, sentToday, remaining: Math.max(0, policy.dailyLimit - sentToday) };
    if (!saved) {
      return { connected: false, email: null, needsReconnect: false, scopes: { gmail: false, contacts: false, calendar: false, drive: false }, sending };
    }
    const client = youtubeService.client();
    const connected = Boolean(client && client.clientId === saved.connectedClientId && client.source === saved.clientSource);
    const granted = this.grantedScopes();
    return {
      connected,
      email: connected ? saved.email : null,
      needsReconnect: !connected,
      scopes: {
        gmail: connected,
        contacts: granted.has(WORKSPACE_SCOPES[0]),
        calendar: granted.has(WORKSPACE_SCOPES[1]),
        drive: granted.has(WORKSPACE_SCOPES[2]),
      },
      sending,
    };
  }

  /** What Google granted this connection (same token drives Gmail, People, Calendar and Drive). */
  grantedScopes(): Set<string> {
    const saved = readConfig();
    return new Set(Array.isArray(saved?.scopes) ? saved!.scopes! : []);
  }

  /**
   * The permission a reader needs, as the message a person can act on. Before
   * refusing, it asks Google once what this connection really holds: a
   * connection made before Soundwave offered contacts/calendar/Drive may
   * already have them, and a token refresh is cheaper than a reconnect.
   */
  async requireScope(scope: string, what: string): Promise<void> {
    if (this.grantedScopes().has(scope)) return;
    await this.accessToken(true).catch(() => "");
    if (this.grantedScopes().has(scope)) return;
    throw new GmailError(
      `Soundwave doesn't have permission to ${what} yet. Reconnect Google in Settings → Email and allow the extra permissions on Google's screen.`,
      409,
      "SCOPE_NOT_GRANTED",
    );
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
    const granted = new Set((data.scope ?? "").split(/\s+/).filter(Boolean));
    if (GMAIL_SCOPES.some((scope) => !granted.has(scope))) {
      return {
        ok: false,
        message: "Google did not grant both Gmail permissions (reading mail and composing/sending). Reconnect and allow Gmail on Google's screen.",
      };
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
      // Only what Google actually returned: a missing optional scope simply
      // means that reader says "reconnect to allow it".
      scopes: [...granted],
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
    const sent = (await this.requestJson("/users/me/drafts/send", undefined, { method: "POST", body: JSON.stringify({ id }) })) as { id?: string; threadId?: string };
    const entry: GmailSentEntry = {
      at: Date.now(),
      to: draft.to || draft.cc || draft.bcc,
      subject: draft.subject,
      messageId: String(sent.id ?? ""),
      threadId: String(sent.threadId ?? draft.threadId),
      source: "app",
      bodyHash: bodySignature(draft.body),
    };
    recordSent(entry);
    return { messageId: entry.messageId, threadId: entry.threadId };
  }

  /** A new, unsent message (the agent's "write it but don't send it yet"). */
  async createDraft(input: { to?: string; cc?: string; bcc?: string; subject?: string; body: string }): Promise<{ id: string; threadId: string; to: string; subject: string; fingerprint: string }> {
    const body = String(input.body ?? "").trim();
    if (!body) throw new GmailError("A draft needs something to say — the message body was empty.", 422, "EMPTY_BODY");
    const to = recipientHeader(input.to ?? "", "To");
    const cc = recipientHeader(input.cc ?? "", "Cc");
    const bcc = recipientHeader(input.bcc ?? "", "Bcc");
    if (!to && !cc && !bcc) throw new GmailError("A draft needs a recipient. Tell me who it's for (their email address).", 422, "NO_RECIPIENT");
    const subject = safeHeader(input.subject ?? "").slice(0, 500);
    const raw = composeRaw({ to, cc, bcc, subject, body: body.slice(0, MAX_BODY_CHARS) });
    const created = (await this.requestJson("/users/me/drafts", undefined, {
      method: "POST",
      body: JSON.stringify({ message: { raw } }),
    })) as { id?: string; message?: { threadId?: string } };
    if (!created.id) throw new GmailError("Gmail did not return an ID for the saved draft.");
    const draftId = String(created.id);
    const saved = await this.getDraft(draftId);
    this.rememberAgentDraft(draftId, saved.fingerprint);
    return { id: draftId, threadId: String(created.message?.threadId ?? saved.threadId), to: saved.to || saved.cc || saved.bcc, subject: saved.subject, fingerprint: saved.fingerprint };
  }

  /**
   * Sends an email the person asked for. Guarded on purpose: a connection, the
   * sending switch, the daily cap, valid recipients, a non-empty body, and no
   * identical email in the last few minutes (models and retries double-send).
   */
  async sendMessage(
    input: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string; replyToMessageId?: string; draftId?: string },
    opts: { source?: "agent" | "app" } = {},
  ): Promise<{ messageId: string; threadId: string; to: string; subject: string }> {
    const source = opts.source ?? "agent";
    if (source === "agent") this.assertSendAllowed();
    if (input.draftId) return this.sendSavedDraft(input.draftId, opts);

    const body = String(input.body ?? "").trim();
    if (!body) throw new GmailError("An email needs something to say — the message body was empty, so nothing was sent.", 422, "EMPTY_BODY");
    const to = recipientHeader(input.to ?? "", "To");
    const cc = recipientHeader(input.cc ?? "", "Cc");
    const bcc = recipientHeader(input.bcc ?? "", "Bcc");
    if (!to && !cc && !bcc) throw new GmailError("There was no email address to send to, so nothing was sent. Ask the person who they mean.", 422, "NO_RECIPIENT");
    this.assertNotDuplicate({ to, cc, bcc, subject: input.subject ?? "", body });

    let threadId = "";
    let inReplyTo = "";
    let references = "";
    let subject = safeHeader(input.subject ?? "").slice(0, 500);
    if (input.replyToMessageId) {
      const originalRaw = await this.requestJson(`/users/me/messages/${encodeURIComponent(input.replyToMessageId)}?format=full`);
      const original = mapMessage(originalRaw, false);
      const originalHeaders = headersOf(originalRaw?.payload);
      inReplyTo = safeHeader(originalHeaders.get("message-id") ?? "");
      references = [safeHeader(originalHeaders.get("references") ?? ""), inReplyTo].filter(Boolean).join(" ");
      threadId = String(originalRaw?.threadId ?? original.threadId);
      if (!subject) subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    }

    const raw = composeRaw({ to, cc, bcc, subject, body: body.slice(0, MAX_BODY_CHARS), inReplyTo, references });
    const sent = (await this.requestJson("/users/me/messages/send", undefined, {
      method: "POST",
      body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
    })) as { id?: string; threadId?: string };
    if (!sent.id) throw new GmailError("Gmail accepted the request but didn't confirm the send. Check Gmail's Sent folder before trying again.", 502, "SEND_UNCONFIRMED");
    const entry: GmailSentEntry = {
      at: Date.now(),
      to: to || cc || bcc,
      subject: subject || "(no subject)",
      messageId: String(sent.id),
      threadId: String(sent.threadId ?? threadId),
      source,
      bodyHash: bodySignature(body),
    };
    recordSent(entry);
    return { messageId: entry.messageId, threadId: entry.threadId, to: entry.to, subject: entry.subject };
  }

  /** Replies in the original conversation (In-Reply-To + thread), for "reply to that and say…". */
  async sendReply(messageId: string, body: string, opts: { source?: "agent" | "app" } = {}): Promise<{ messageId: string; threadId: string; to: string; subject: string }> {
    const originalRaw = await this.requestJson(`/users/me/messages/${encodeURIComponent(messageId)}?format=full`);
    const originalHeaders = headersOf(originalRaw?.payload);
    const to = emailAddress(originalHeaders.get("reply-to") ?? mapMessage(originalRaw).from);
    if (!to) throw new GmailError("I couldn't find a safe reply address on that email, so nothing was sent.", 422, "NO_REPLY_ADDRESS");
    return this.sendMessage({ to, body, replyToMessageId: messageId }, opts);
  }

  /** Sends a draft the agent saved earlier — only if Gmail still has it exactly as it was. */
  async sendSavedDraft(id: string, opts: { source?: "agent" | "app" } = {}): Promise<{ messageId: string; threadId: string; to: string; subject: string }> {
    const source = opts.source ?? "agent";
    if (source === "agent") this.assertSendAllowed();
    const draft = await this.getDraft(id);
    const remembered = readJsonFile<Record<string, string>>(agentDraftsFile(), {})[id];
    if (!remembered) {
      throw new GmailError("That draft wasn't written in this conversation, so review it in its card before sending.", 409, "REVIEW_REQUIRED");
    }
    if (draft.attachments.length) throw new GmailError("That draft has attachments. Send it from Gmail instead.", 409, "ATTACHMENTS_REQUIRE_GMAIL");
    if (draft.fingerprint !== remembered) {
      throw new GmailError("That draft changed after it was written, so it wasn't sent. Review the latest version first.", 409, "DRAFT_CHANGED");
    }
    this.assertNotDuplicate({ to: draft.to || draft.cc || draft.bcc, cc: "", bcc: "", subject: draft.subject, body: draft.body });
    const sent = (await this.requestJson("/users/me/drafts/send", undefined, { method: "POST", body: JSON.stringify({ id }) })) as { id?: string; threadId?: string };
    const entry: GmailSentEntry = {
      at: Date.now(),
      to: draft.to || draft.cc || draft.bcc,
      subject: draft.subject,
      messageId: String(sent.id ?? ""),
      threadId: String(sent.threadId ?? draft.threadId),
      source,
      bodyHash: bodySignature(draft.body),
    };
    recordSent(entry);
    return { messageId: entry.messageId, threadId: entry.threadId, to: entry.to, subject: entry.subject };
  }

  /** Remembers a draft the agent wrote, so "send it" can tell whether it changed. */
  rememberAgentDraft(id: string, fingerprint: string): void {
    const all = readJsonFile<Record<string, string>>(agentDraftsFile(), {});
    all[id] = fingerprint;
    writeJsonFile(agentDraftsFile(), all);
  }

  private assertSendAllowed(): void {
    const policy = gmailSendPolicy();
    if (!policy.enabled) {
      throw new GmailError(
        "Sending email from chat is turned off in Settings → Email. I can save it as a draft instead.",
        409,
        "SEND_DISABLED",
      );
    }
    const sentToday = gmailAgentSendsToday();
    if (sentToday >= policy.dailyLimit) {
      throw new GmailError(
        `That's the ${policy.dailyLimit} emails a day I'm allowed to send. I can save this one as a draft, or you can raise the limit in Settings → Email.`,
        429,
        "SEND_LIMIT",
      );
    }
  }

  /** The same words to the same person twice in a few minutes is a double-send, not a follow-up. */
  private assertNotDuplicate(input: { to: string; cc: string; bcc: string; subject: string; body: string }): void {
    const signature = bodySignature(input.body);
    const duplicated = gmailSentLog(MAX_SENT_KEPT).some(
      (entry) =>
        Date.now() - entry.at < DUPLICATE_WINDOW_MS &&
        entry.source === "agent" &&
        entry.to.toLowerCase() === (input.to || input.cc || input.bcc).toLowerCase() &&
        entry.subject.trim().toLowerCase() === input.subject.trim().toLowerCase() &&
        entry.bodyHash === signature,
    );
    if (duplicated) {
      throw new GmailError("I just sent that same email, so I didn't send it twice. Tell me if you really want another copy.", 409, "DUPLICATE_SEND");
    }
  }

  /**
   * Any Google API this connection can reach with its token — Gmail, but also
   * People (contacts), Calendar and Drive. `accessToken` is only passed by the
   * sign-in flow, before the tokens are saved.
   */
  async googleJson<T = any>(url: string, init: RequestInit & { accessToken?: string } = {}): Promise<T> {
    const { accessToken, ...rest } = init;
    const token = accessToken ?? (await this.accessToken());
    const isGmail = url.includes("/gmail/");
    let response: Response;
    try {
      response = await fetch(url, {
        ...rest,
        headers: { Authorization: `Bearer ${token}`, ...(rest.body ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
        signal: rest.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new GmailError(`Couldn't reach ${isGmail ? "Gmail" : "Google"}: ${(err as Error).message}`);
    }
    const data = (await response.json().catch(() => ({}))) as any;
    if (!response.ok) {
      const reason = data?.error?.errors?.[0]?.reason ?? data?.error?.status ?? "";
      if (response.status === 401 || reason === "invalid_grant") {
        throw new GmailError("Google access expired. Reconnect Google in Settings → Email.", 401, "RECONNECT_REQUIRED");
      }
      if (response.status === 403) {
        throw new GmailError(
          `Google refused that request (403${reason ? `: ${safeHeader(String(reason))}` : ""}). Check that the API is enabled for this account in Google Cloud, or reconnect to grant it.`,
          403,
          "GOOGLE_FORBIDDEN",
        );
      }
      throw new GmailError(
        isGmail
          ? `Gmail request failed (${response.status}). Check that Gmail API is enabled and the connected account has access.`
          : `Google request failed (${response.status}).`,
        response.status,
        isGmail ? "GMAIL_API_ERROR" : "GOOGLE_API_ERROR",
      );
    }
    return data as T;
  }

  private async requestJson(pathname: string, accessToken?: string, init: RequestInit = {}): Promise<any> {
    return this.googleJson(`${config.gmailApiBase}/gmail/v1${pathname}`, { ...init, ...(accessToken ? { accessToken } : {}) });
  }

  /** `force` asks Google even when the saved token is still good (scope checks). */
  private async accessToken(force = false): Promise<string> {
    const saved = readConfig();
    const client = youtubeService.client();
    if (!saved) throw new GmailError("Connect Gmail in Settings → Email before using email tools.", 409, "NOT_CONNECTED");
    if (!client || client.clientId !== saved.connectedClientId || client.source !== saved.clientSource) throw new GmailError("The Google OAuth client changed. Reconnect Google in Settings → Email.", 409, "RECONNECT_REQUIRED");
    if (!force && saved.accessToken && saved.tokenExpiry && saved.tokenExpiry > Date.now() + 60_000) return saved.accessToken;
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
    const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; scope?: string };
    if (!response.ok || !data.access_token) {
      if (data.error === "invalid_grant") throw new GmailError("Google access expired. Reconnect Google in Settings → Email.", 401, "RECONNECT_REQUIRED");
      throw new GmailError(`Couldn't refresh Google access (${response.status}). Reconnect Google in Settings → Email.`, 401, "RECONNECT_REQUIRED");
    }
    // Google states the scopes this token really has on every refresh: a
    // connection made before Soundwave asked for contacts/calendar/Drive learns
    // what it already holds here — no reconnect, no scary consent screen just
    // to find out whether a reader may run.
    const refreshed = (data.scope ?? "").split(/\s+/).filter(Boolean);
    const scopes = refreshed.length ? [...new Set([...(saved.scopes ?? []), ...refreshed])] : saved.scopes;
    const updated: GmailConfig = { ...saved, accessToken: data.access_token, tokenExpiry: Date.now() + (data.expires_in ?? 3600) * 1000, ...(scopes ? { scopes } : {}) };
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
    // Gmail is required; contacts/calendar/drive are offered on the same screen
    // and recorded if allowed (a person may grant only email).
    scope: [...ALL_GOOGLE_SCOPES, "openid", "email"].join(" "),
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
    ? `Soundwave can now read ${escapeHtml(result.email ?? "your Gmail")}, save drafts, and send email when you tell it to. Everything it sends is listed in Settings → Email. You can close this tab and return to Soundwave.`
    : `${escapeHtml(result.message ?? "The sign-in did not finish.")} Close this tab and return to Soundwave to try again.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} — Soundwave AI</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070b14;color:#e5e7eb;font:16px/1.5 system-ui,sans-serif}main{max-width:540px;padding:32px;border:1px solid #1f2a44;border-radius:18px;background:#0a1224}h1{margin:0 0 12px;color:${result.ok ? "#34d399" : "#fca5a5"};font-size:22px}p{margin:8px 0}</style></head><body><main><h1>${title}</h1><p>${content}</p></main></body></html>`;
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function resetGmailForTests(): void {
  pending.clear();
  gmailService.disconnect();
  for (const file of [policyFile(), sentFile(), agentDraftsFile()]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* nothing saved */
    }
  }
}
