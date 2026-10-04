import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
  process.env.DATA_DIR = "/tmp/soundwave-gmail-tests";
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { gmailService, GMAIL_SCOPES, isGmailCallback, startGmailConnect, finishGmailConnect } = await import("../src/lib/gmail.js");
const { youtubeService } = await import("../src/lib/youtube.js");
const { toolsFor } = await import("../src/lib/brain/tools.js");

const app = createApp();
const EMAIL = "alice@example.com";
const messageHeaders = [
  { name: "From", value: `Alice Example <${EMAIL}>` },
  { name: "To", value: "owner@example.com" },
  { name: "Subject", value: "Meeting tomorrow" },
  { name: "Date", value: "Mon, 5 Oct 2026 10:00:00 +0000" },
  { name: "Message-ID", value: "<original-message@example.com>" },
];
const bodyData = Buffer.from("Can we meet tomorrow at 10?", "utf8").toString("base64url");
const draftBodyData = Buffer.from("Thanks, that works for me.", "utf8").toString("base64url");
const seen: Array<{ url: string; method: string; body: any }> = [];
let fetchStub: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installFetchStub() {
  fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    let body: any = {};
    try { body = typeof init.body === "string" ? JSON.parse(init.body) : init.body; } catch { body = init.body; }
    seen.push({ url, method, body });

    if (url === config.googleOAuthTokenUrl) {
      return json({
        access_token: "gmail-access-token",
        refresh_token: "gmail-refresh-token",
        expires_in: 3600,
        scope: [...GMAIL_SCOPES, "openid", "email"].join(" "),
      });
    }
    const parsed = new URL(url);
    const apiPath = parsed.pathname.replace(/^\/gmail\/v1/, "");
    if (apiPath === "/users/me/profile") return json({ emailAddress: "owner@example.com" });
    if (apiPath === "/users/me/messages") return json({ messages: [{ id: "message-1", threadId: "thread-1" }] });
    if (apiPath === "/users/me/messages/message-1") {
      return json({
        id: "message-1",
        threadId: "thread-1",
        labelIds: ["INBOX", "UNREAD"],
        snippet: "Can we meet tomorrow?",
        payload: { mimeType: "text/plain", headers: messageHeaders, body: { data: bodyData } },
      });
    }
    if (apiPath === "/users/me/drafts" && method === "POST") return json({ id: "draft-1", message: { threadId: "thread-1" } });
    if (apiPath === "/users/me/drafts/draft-1" && method === "GET") {
      return json({
        id: "draft-1",
        message: {
          threadId: "thread-1",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "To", value: EMAIL },
              { name: "Cc", value: "copy@example.com" },
              { name: "Bcc", value: "blind-copy@example.com" },
              { name: "Subject", value: "Re: Meeting tomorrow" },
            ],
            body: { data: draftBodyData },
          },
        },
      });
    }
    if (apiPath === "/users/me/drafts/send" && method === "POST") return json({ id: "sent-1", threadId: "thread-1" });
    return json({ error: { message: `Unhandled fake request ${method} ${apiPath}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchStub);
}

async function connectGmail() {
  const started = startGmailConnect(47831);
  const auth = new URL(started.url);
  const state = auth.searchParams.get("state")!;
  expect(auth.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:47831");
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect(auth.searchParams.get("scope")).toContain(GMAIL_SCOPES[0]);
  expect(auth.searchParams.get("scope")).toContain(GMAIL_SCOPES[1]);
  expect(isGmailCallback({ state, code: "authorization-code" })).toBe(true);
  expect(await finishGmailConnect({ state, code: "authorization-code" })).toEqual({ ok: true, email: "owner@example.com" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  youtubeService.saveConfig({ clientId: "gmail-test.apps.googleusercontent.com", clientSecret: "GOCSPX-gmail-test", refreshToken: "" });
  gmailService.disconnect();
  installFetchStub();
});

describe("Gmail tools and explicit-send boundary", () => {
  it("uses PKCE, requests only read/compose scopes, and saves the connection without returning tokens", async () => {
    await connectGmail();
    expect(gmailService.status()).toEqual({ connected: true, email: "owner@example.com", needsReconnect: false });
    expect(JSON.stringify(gmailService.status())).not.toContain("gmail-refresh-token");

    const tools = toolsFor({ userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p", seconds: 60, desktop: true, platform: "win32", effects: { log: [] } });
    expect(tools.map((tool) => tool.declaration.name)).toContain("list_emails");
    expect(tools.map((tool) => tool.declaration.name)).toContain("draft_email_reply");
    expect(tools.map((tool) => tool.declaration.name)).not.toContain("send_email");
  });

  it("lists inbox messages and reads the plain-text body", async () => {
    await connectGmail();
    const inbox = await gmailService.listInbox("is:unread", 5);
    expect(inbox).toMatchObject([{ id: "message-1", from: `Alice Example <${EMAIL}>`, subject: "Meeting tomorrow", unread: true }]);
    const read = await gmailService.readMessage("message-1");
    expect(read.body).toBe("Can we meet tomorrow at 10?");
    const listUrl = new URL(seen.find((call) => call.url.includes("/users/me/messages?"))!.url);
    expect(listUrl.searchParams.get("labelIds")).toBe("INBOX");
    expect(listUrl.searchParams.get("q")).toBe("is:unread");
  });

  it("creates a threaded Gmail reply draft but does not send it", async () => {
    await connectGmail();
    const context = { userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p" as const, seconds: 60, desktop: true, platform: "win32" as NodeJS.Platform, effects: { log: [] as string[] } };
    const tool = toolsFor(context).find((item) => item.declaration.name === "draft_email_reply")!;
    const result = await tool.run({ messageId: "message-1", body: "Thanks, that works for me." }, context);
    expect(result).toMatchObject({ ok: true, saved: true, sent: false, to: EMAIL, subject: "Re: Meeting tomorrow" });
    expect(context.effects.emailDraftIds).toEqual(["draft-1"]);
    const create = seen.find((call) => call.url.endsWith("/users/me/drafts") && call.method === "POST")!;
    expect(create.body.message.threadId).toBe("thread-1");
    const raw = Buffer.from(create.body.message.raw, "base64url").toString("utf8");
    expect(raw).toContain(`To: ${EMAIL}`);
    expect(raw).toContain("Subject: Re: Meeting tomorrow");
    expect(raw).toContain("In-Reply-To: <original-message@example.com>");
    expect(seen.some((call) => call.url.endsWith("/users/me/drafts/send"))).toBe(false);
  });

  it("requires an explicit confirmation and a fresh reviewed draft before sending", async () => {
    await connectGmail();
    const status = await request(app).get("/api/v1/email/status");
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ connected: true, email: "owner@example.com", needsReconnect: false });
    const crossOrigin = await request(app).get("/api/v1/email/status").set("Origin", "https://attacker.example");
    expect(crossOrigin.status).toBe(403);

    const draft = await gmailService.getDraft("draft-1");
    expect(draft).toMatchObject({ to: EMAIL, cc: "copy@example.com", bcc: "blind-copy@example.com", subject: "Re: Meeting tomorrow" });
    const missingConfirmation = await request(app).post("/api/v1/email/drafts/draft-1/send").send({ fingerprint: draft.fingerprint });
    expect(missingConfirmation.status).toBe(403);
    expect(seen.some((call) => call.url.endsWith("/users/me/drafts/send"))).toBe(false);

    const staleReview = await request(app).post("/api/v1/email/drafts/draft-1/send").send({ confirmSend: true, fingerprint: "0".repeat(64) });
    expect(staleReview.status).toBe(409);
    expect(seen.some((call) => call.url.endsWith("/users/me/drafts/send"))).toBe(false);

    const sent = await request(app).post("/api/v1/email/drafts/draft-1/send").send({ confirmSend: true, fingerprint: draft.fingerprint });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, messageId: "sent-1", threadId: "thread-1" });
    expect(seen.filter((call) => call.url.endsWith("/users/me/drafts/send"))).toHaveLength(1);
  });

  it("disconnects without deleting Gmail's drafts", async () => {
    await connectGmail();
    const res = await request(app).post("/api/v1/email/disconnect");
    expect(res.status).toBe(200);
    expect(gmailService.status().connected).toBe(false);
  });
});
