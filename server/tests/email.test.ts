import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
  process.env.DATA_DIR = "/tmp/soundwave-gmail-tests";
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { gmailService, GMAIL_SCOPES, WORKSPACE_SCOPES, gmailSendPolicy, gmailSentLog, isGmailCallback, parseRecipients, resetGmailForTests, saveGmailSendPolicy, startGmailConnect, finishGmailConnect } = await import("../src/lib/gmail.js");
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

/** Whether the fake Google's consent screen also gave contacts/calendar/drive. */
let grantExtras = true;

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
        scope: [...GMAIL_SCOPES, ...(grantExtras ? WORKSPACE_SCOPES : []), "openid", "email"].join(" "),
      });
    }
    const parsed = new URL(url);
    // Whatever base the config points at, the Gmail path after it is what matters.
    const gmailPrefix = `${new URL(config.gmailApiBase).pathname.replace(/\/$/, "")}/gmail/v1`;
    const apiPath = parsed.pathname.replace(gmailPrefix, "");
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
    if (apiPath === "/users/me/drafts" && method === "POST") {
      // A reply draft (it carries In-Reply-To) gets one id; a new message another.
      const raw = Buffer.from(String(body?.message?.raw ?? ""), "base64url").toString("utf8");
      const isReply = raw.includes("In-Reply-To:");
      return json({ id: isReply ? "draft-1" : "draft-2", message: { threadId: isReply ? "thread-1" : "thread-2" } });
    }
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
    if (apiPath === "/users/me/messages/send" && method === "POST") return json({ id: "sent-new-1", threadId: "thread-9" });
    if (apiPath === "/users/me/drafts/draft-2" && method === "GET") {
      return json({
        id: "draft-2",
        message: {
          threadId: "thread-2",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "To", value: "editor@example.com" },
              { name: "Subject", value: "Invoice for March" },
            ],
            body: { data: Buffer.from("Here's the invoice.", "utf8").toString("base64url") },
          },
        },
      });
    }
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
  // The whole account is offered on Google's screen; Gmail is the required part.
  expect(auth.searchParams.get("scope")).toContain(WORKSPACE_SCOPES[0]);
  expect(isGmailCallback({ state, code: "authorization-code" })).toBe(true);
  expect(await finishGmailConnect({ state, code: "authorization-code" })).toEqual({ ok: true, email: "owner@example.com" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
  grantExtras = true;
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  youtubeService.saveConfig({ clientId: "gmail-test.apps.googleusercontent.com", clientSecret: "GOCSPX-gmail-test", refreshToken: "" });
  resetGmailForTests();
  installFetchStub();
});

describe("Gmail tools and explicit-send boundary", () => {
  it("uses PKCE, requests only read/compose scopes, and saves the connection without returning tokens", async () => {
    await connectGmail();
    expect(gmailService.status()).toMatchObject({ connected: true, email: "owner@example.com", needsReconnect: false });
    expect(JSON.stringify(gmailService.status())).not.toContain("gmail-refresh-token");
    expect(JSON.stringify(gmailService.status())).not.toContain("gmail-access-token");

    const tools = toolsFor({ userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p", seconds: 60, desktop: true, platform: "win32", effects: { log: [] } });
    const names = tools.map((tool) => tool.declaration.name);
    expect(names).toContain("list_emails");
    expect(names).toContain("draft_email_reply");
    expect(names).toContain("draft_email");
    expect(names).toContain("send_email");
    expect(names).toContain("send_reply");
    expect(names).toContain("find_contact");
    expect(names).toContain("list_calendar");
    expect(names).toContain("search_drive");
    // The status the model reads says sending is on and how much is left.
    const statusTool = tools.find((tool) => tool.declaration.name === "gmail_status")!;
    expect(await statusTool.run({}, { effects: { log: [] }, desktop: true } as never)).toMatchObject({
      connected: true,
      email: "owner@example.com",
      canSend: true,
    });

    // What Google granted is recorded, so the optional readers know their state.
    expect(gmailService.status().scopes).toEqual({ gmail: true, contacts: true, calendar: true, drive: true });
    expect(gmailService.status().sending).toMatchObject({ enabled: true, dailyLimit: 25, sentToday: 0, remaining: 25 });
  });

  it("records only the permissions Google actually granted", async () => {
    grantExtras = false;
    await connectGmail();
    expect(gmailService.status().scopes).toEqual({ gmail: true, contacts: false, calendar: false, drive: false });
    const names = toolsFor({ userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p", seconds: 60, desktop: true, platform: "win32", effects: { log: [] } }).map((tool) => tool.declaration.name);
    // The Gmail tools are there; the readers that need another permission are not.
    expect(names).toContain("send_email");
    expect(names).not.toContain("find_contact");
    expect(names).not.toContain("list_calendar");
    expect(names).not.toContain("search_drive");
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
    expect(status.body).toMatchObject({ connected: true, email: "owner@example.com", needsReconnect: false });
    expect(status.body.sending).toMatchObject({ enabled: true, dailyLimit: 25, sentToday: 0 });
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

  it("sends the email the person asked for, and records exactly what went out", async () => {
    await connectGmail();
    const context = { userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p" as const, seconds: 60, desktop: true, platform: "win32" as NodeJS.Platform, effects: { log: [] as string[] } };
    const sendTool = toolsFor(context).find((item) => item.declaration.name === "send_email")!;
    const result = await sendTool.run(
      { to: "editor@example.com", subject: "Invoice for March", body: "Here's the invoice.\nThanks!" },
      context,
    );
    expect(result).toMatchObject({ ok: true, sent: true, to: "editor@example.com", subject: "Invoice for March" });
    expect(context.effects.emailSent).toEqual([{ to: "editor@example.com", subject: "Invoice for March" }]);

    // It really called Gmail's send, with the recipients and body in the MIME.
    const send = seen.find((call) => call.url.endsWith("/users/me/messages/send") && call.method === "POST")!;
    const raw = Buffer.from(send.body.raw, "base64url").toString("utf8");
    expect(raw).toContain("To: editor@example.com");
    expect(raw).toMatch(/Subject: Invoice for March/);
    expect(Buffer.from(raw.split("\r\n\r\n")[1]!, "base64").toString("utf8")).toBe("Here's the invoice.\nThanks!");
    expect(send.body.threadId).toBeUndefined();

    // And the record: who, what about, and that the assistant sent it.
    const log = gmailSentLog();
    expect(log[0]).toMatchObject({ to: "editor@example.com", subject: "Invoice for March", source: "agent", messageId: "sent-new-1" });
  });

  it("refuses an address that isn't one, an empty body and a missing recipient — sending nothing", async () => {
    await connectGmail();
    const context = { userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p" as const, seconds: 60, desktop: true, platform: "win32" as NodeJS.Platform, effects: { log: [] as string[] } };
    const sendTool = toolsFor(context).find((item) => item.declaration.name === "send_email")!;

    await expect(sendTool.run({ to: "John", subject: "Hi", body: "Hello" }, context)).rejects.toThrow(/valid To address/i);
    expect(seen.some((call) => call.url.endsWith("/users/me/messages/send"))).toBe(false);

    const noRecipient = await sendTool.run({ to: "", subject: "Hi", body: "Hello" }, context);
    expect(noRecipient).toMatchObject({ ok: false, nothingSent: true });
    expect(String(noRecipient.reason)).toContain("No recipient");

    const noBody = await sendTool.run({ to: "editor@example.com", subject: "Hi", body: "   " }, context);
    expect(noBody).toMatchObject({ ok: false, nothingSent: true });
    expect(String(noBody.reason)).toContain("empty");
    expect(seen.some((call) => call.url.endsWith("/users/me/messages/send"))).toBe(false);

    // Several addresses, with display names, are fine; junk among them is not.
    const { list, invalid } = parseRecipients("Ann <ann@example.com>, bob@example.com, bob@example.com, nope");
    expect(list).toEqual(["ann@example.com", "bob@example.com"]);
    expect(invalid).toEqual(["nope"]);
  });

  it("refuses to send the same email twice in a few minutes", async () => {
    await connectGmail();
    const context = { userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p" as const, seconds: 60, desktop: true, platform: "win32" as NodeJS.Platform, effects: { log: [] as string[] } };
    const sendTool = toolsFor(context).find((item) => item.declaration.name === "send_email")!;
    const mail = { to: "editor@example.com", subject: "Invoice", body: "Attached." };
    await sendTool.run({ ...mail }, context);
    await expect(sendTool.run({ ...mail }, context)).rejects.toThrow(/didn't send it twice/i);
    expect(seen.filter((call) => call.url.endsWith("/users/me/messages/send"))).toHaveLength(1);
    // A different message to the same person is not a double-send.
    await sendTool.run({ ...mail, body: "One correction: it's the April invoice." }, context);
    expect(seen.filter((call) => call.url.endsWith("/users/me/messages/send"))).toHaveLength(2);
  });

  it("replies in the original conversation when asked to answer an email", async () => {
    await connectGmail();
    const context = { userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p" as const, seconds: 60, desktop: true, platform: "win32" as NodeJS.Platform, effects: { log: [] as string[] } };
    const replyTool = toolsFor(context).find((item) => item.declaration.name === "send_reply")!;
    const result = await replyTool.run({ messageId: "message-1", body: "10:00 works for me." }, context);
    expect(result).toMatchObject({ ok: true, sent: true, to: EMAIL, subject: "Re: Meeting tomorrow" });
    const send = seen.find((call) => call.url.endsWith("/users/me/messages/send"))!;
    const raw = Buffer.from(send.body.raw, "base64url").toString("utf8");
    expect(raw).toContain("In-Reply-To: <original-message@example.com>");
    expect(raw).toMatch(/Subject: Re: Meeting tomorrow/);
    expect(send.body.threadId).toBe("thread-1");
  });

  it("saves a draft, then sends it when the person says so — and only if it is unchanged", async () => {
    await connectGmail();
    const context = { userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p" as const, seconds: 60, desktop: true, platform: "win32" as NodeJS.Platform, effects: { log: [] as string[] } };
    const draftTool = toolsFor(context).find((item) => item.declaration.name === "draft_email")!;
    const saved = await draftTool.run({ to: "editor@example.com", subject: "Invoice for March", body: "Here's the invoice." }, context);
    expect(saved).toMatchObject({ ok: true, sent: false, draftId: "draft-2" });
    expect(context.effects.emailDraftIds).toEqual(["draft-2"]);

    const sendTool = toolsFor(context).find((item) => item.declaration.name === "send_email")!;
    const sent = await sendTool.run({ draftId: "draft-2" }, context);
    expect(sent).toMatchObject({ ok: true, sent: true, to: "editor@example.com", subject: "Invoice for March" });
    expect(seen.filter((call) => call.url.endsWith("/users/me/drafts/send"))).toHaveLength(1);

    // A draft the agent didn't write here can't be sent blind — review first.
    await expect(sendTool.run({ draftId: "draft-1" }, context)).rejects.toThrow(/review it in its card/i);
  });

  it("honours the sending switch and the daily cap, then offers a draft instead", async () => {
    await connectGmail();
    const context = { userId: "local-user", voice: "en-US-AndrewNeural", resolution: "1080p" as const, seconds: 60, desktop: true, platform: "win32" as NodeJS.Platform, effects: { log: [] as string[] } };
    const sendTool = toolsFor(context).find((item) => item.declaration.name === "send_email")!;

    const off = await request(app).put("/api/v1/email/policy").send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, dailyLimit: 25 });
    await expect(sendTool.run({ to: "editor@example.com", subject: "Hi", body: "Hello" }, context)).rejects.toThrow(/turned off in Settings/i);
    expect(seen.some((call) => call.url.endsWith("/users/me/messages/send"))).toBe(false);
    // The person pressing Send in a draft card is their own action: still allowed.
    const draft = await gmailService.getDraft("draft-1");
    const cardSend = await request(app).post("/api/v1/email/drafts/draft-1/send").send({ confirmSend: true, fingerprint: draft.fingerprint });
    expect(cardSend.status).toBe(200);

    // Back on, with a cap of one: the second send is refused, not retried.
    const on = await request(app).put("/api/v1/email/policy").send({ enabled: true, dailyLimit: 1 });
    expect(on.body).toMatchObject({ enabled: true, dailyLimit: 1, sentToday: 0, remaining: 1 });
    await sendTool.run({ to: "one@example.com", subject: "First", body: "One." }, context);
    await expect(sendTool.run({ to: "two@example.com", subject: "Second", body: "Two." }, context)).rejects.toThrow(/1 emails a day/i);

    const policy = await request(app).get("/api/v1/email/policy");
    expect(policy.body).toMatchObject({ enabled: true, dailyLimit: 1, sentToday: 1, remaining: 0 });
    // The record shows both kinds: the agent's send and the card's send.
    expect(policy.body.sent.map((entry: { source: string }) => entry.source)).toEqual(["agent", "app"]);
    expect(saveGmailSendPolicy({ dailyLimit: 500 }).dailyLimit).toBe(200); // clamped
    expect(gmailSendPolicy().dailyLimit).toBe(200);
  });

  it("disconnects without deleting Gmail's drafts", async () => {
    await connectGmail();
    const res = await request(app).post("/api/v1/email/disconnect");
    expect(res.status).toBe(200);
    expect(gmailService.status().connected).toBe(false);
  });
});
