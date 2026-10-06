// ── "Send this to that guy at 5 pm" ─────────────────────────────────────────
// The whole point of scheduling is that nobody has to be there when it fires:
// the email is written and validated when the person asks, held on this PC, and
// sent at the moment they named — with no confirmation at that moment. These
// tests drive the queue with a clock we control (the same trick the briefing
// tests use) and a fake Gmail, so "at 5 pm" is provable without waiting.
//
// What is deliberately asserted, beyond "it sent": that nothing goes out early,
// that the person's own sending switch, daily cap and address checks still apply
// at the moment of sending, that a refusal is not retried forever while Google's
// own 5xx is, that a PC that was off sends late (and says how late) but never
// sends an email that is hours stale, and that an interrupted send is *reported*
// rather than repeated — a double-sent email is worse than a question.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
  process.env.DATA_DIR = "/tmp/soundwave-email-schedule-tests";
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const {
  GMAIL_SCOPES,
  WORKSPACE_SCOPES,
  gmailSentLog,
  gmailService,
  resetGmailForTests,
  saveGmailSendPolicy,
  finishGmailConnect,
  startGmailConnect,
} = await import("../src/lib/gmail.js");
const {
  MAX_LATE_MS,
  cancelScheduledEmail,
  listScheduledEmails,
  resetScheduledEmailsForTests,
  scheduleEmail,
  sendDueScheduledEmails,
} = await import("../src/lib/emailSchedule.js");
const { getConversation, resetConversationForTests } = await import("../src/lib/conversation.js");
const { youtubeService } = await import("../src/lib/youtube.js");
const { toolsFor } = await import("../src/lib/brain/tools.js");

const app = createApp();
const SCHEDULE_FILE = () => path.join(config.dataDir, "gmail", "scheduled.json");
/** 09:00 on Tuesday 6 October 2026, local time — the clock the person's "5 pm" refers to. */
const MORNING = new Date(2026, 9, 6, 9, 0, 0);
const AT_FIVE_PM = new Date(2026, 9, 6, 17, 0, 0);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const seen: Array<{ url: string; method: string; body: any }> = [];
/** What the fake Gmail answers a send with; the tests move it between runs. */
let sendResponse: () => Response = () => json({ id: "sent-new-1", threadId: "thread-9" });
/** When set, a send hangs here — a Gmail that is slow to answer. */
let sendGate: Promise<void> | null = null;

function installFetchStub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      let body: any = {};
      try {
        body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      } catch {
        body = init.body;
      }
      seen.push({ url, method, body });

      if (url === config.googleOAuthTokenUrl) {
        return json({
          access_token: "gmail-access-token",
          refresh_token: "gmail-refresh-token",
          expires_in: 3600,
          scope: [...GMAIL_SCOPES, ...WORKSPACE_SCOPES, "openid", "email"].join(" "),
        });
      }
      const parsed = new URL(url);
      const gmailPrefix = `${new URL(config.gmailApiBase).pathname.replace(/\/$/, "")}/gmail/v1`;
      const apiPath = parsed.pathname.replace(gmailPrefix, "");
      if (apiPath === "/users/me/profile") return json({ emailAddress: "owner@example.com" });
      if (apiPath === "/users/me/messages/message-1") {
        return json({
          id: "message-1",
          threadId: "thread-1",
          labelIds: ["INBOX"],
          snippet: "Can we meet tomorrow?",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "Alice Example <alice@example.com>" },
              { name: "To", value: "owner@example.com" },
              { name: "Subject", value: "Meeting tomorrow" },
              { name: "Message-ID", value: "<original-message@example.com>" },
            ],
            body: { data: Buffer.from("Can we meet tomorrow at 10?", "utf8").toString("base64url") },
          },
        });
      }
      if (apiPath === "/users/me/messages/send" && method === "POST") {
        if (sendGate) await sendGate;
        return sendResponse();
      }
      return json({ error: { message: `Unhandled fake request ${method} ${apiPath}` } }, 404);
    }),
  );
}

async function connectGmail() {
  const started = startGmailConnect(47844);
  const state = new URL(started.url).searchParams.get("state")!;
  const result = await finishGmailConnect({ state, code: "authorization-code" });
  expect(result).toEqual({ ok: true, email: "owner@example.com" });
}

/** The MIME of the send Gmail was asked to perform (decoded head + body). */
function lastSentRaw(): { headers: string; body: string } {
  const send = seen.filter((call) => call.url.endsWith("/users/me/messages/send")).at(-1)!;
  const raw = Buffer.from(String(send.body.raw), "base64url").toString("utf8");
  const [headers = "", encoded = ""] = raw.split("\r\n\r\n");
  return { headers, body: Buffer.from(encoded, "base64").toString("utf8") };
}

const toolContext = () =>
  ({
    userId: "local-user",
    voice: "en-US-AndrewNeural",
    resolution: "1080p" as const,
    seconds: 60,
    desktop: true,
    platform: "win32" as NodeJS.Platform,
    effects: { log: [] as string[] },
  }) as {
    effects: { log: string[]; emailScheduled?: Array<{ to: string; subject: string; when: string; at: number }>; emailSent?: Array<{ to: string; subject: string }> };
    [key: string]: unknown;
  };

const assistantLines = () => getConversation().messages.filter((m) => m.sender === "assistant").map((m) => m.text);

beforeEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
  sendResponse = () => json({ id: "sent-new-1", threadId: "thread-9" });
  sendGate = null;
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  youtubeService.saveConfig({ clientId: "schedule-test.apps.googleusercontent.com", clientSecret: "GOCSPX-schedule-test", refreshToken: "" });
  resetGmailForTests();
  resetScheduledEmailsForTests();
  resetConversationForTests();
  installFetchStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("email scheduled for a later moment", () => {
  // send_email and send_reply are the only paths here that read the clock
  // themselves (the scheduler takes the moment it is called with). Pin Date to
  // the morning these tests are written around, so "at 5 pm" means today's 5 pm
  // at whatever hour of the day the suite happens to run — before 5 pm it is
  // "at 17:00", after it is "tomorrow at 17:00", and the test then fails for
  // being right. Only Date is faked: the scheduler's own timers stay real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: MORNING });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is written when asked and does NOT go out then", async () => {
    await connectGmail();
    const context = toolContext();
    const sendTool = toolsFor(context as never).find((tool) => tool.declaration.name === "send_email")!;

    const result = await sendTool.run(
      { to: "marko@example.com", subject: "Keys", body: "I'll drop the keys at the office.", when: "at 5 pm" },
      context as never,
    );
    // What the model is told is what it must tell the person: the moment, no
    // further confirmation, cancellable in Settings → Email.
    expect(result).toMatchObject({ ok: true, scheduled: true, sent: false, when: "at 17:00", to: "marko@example.com", subject: "Keys" });
    expect(context.effects.emailScheduled).toHaveLength(1);
    expect(context.effects.emailScheduled?.[0]).toMatchObject({ to: "marko@example.com", when: "at 17:00" });

    // Nothing was sent, and nothing was even asked of Gmail.
    expect(seen.some((call) => call.url.endsWith("/users/me/messages/send"))).toBe(false);
    const { scheduled } = listScheduledEmails(MORNING);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ to: "marko@example.com", subject: "Keys", status: "scheduled", due: "in 8 hours" });
    expect(scheduled[0]!.body).toBe("I'll drop the keys at the office.");
  });

  it("sends at the moment, by itself, with the text the person approved", async () => {
    await connectGmail();
    scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Keys", body: "I'll drop the keys at the office." }, MORNING);

    // A tick before the moment changes nothing at all.
    const early = await sendDueScheduledEmails(new Date(2026, 9, 6, 16, 59, 30));
    expect(early.sent).toHaveLength(0);
    expect(seen.some((call) => call.url.endsWith("/users/me/messages/send"))).toBe(false);

    const at = await sendDueScheduledEmails(AT_FIVE_PM);
    expect(at.sent).toHaveLength(1);
    const { headers, body } = lastSentRaw();
    expect(headers).toContain("To: marko@example.com");
    expect(headers).toMatch(/Subject: Keys/);
    expect(body).toBe("I'll drop the keys at the office.");
    // Recorded as an agent send, so the daily cap counts it and the page shows it.
    expect(gmailSentLog()[0]).toMatchObject({ to: "marko@example.com", subject: "Keys", source: "agent" });
    expect(listScheduledEmails(AT_FIVE_PM).scheduled).toHaveLength(0);
    expect(listScheduledEmails(AT_FIVE_PM).history[0]).toMatchObject({ status: "sent" });
    // And the conversation says it happened, in the person's own list of messages.
    expect(assistantLines().some((line) => line.startsWith("✉️ Sent to marko@example.com"))).toBe(true);
    // Only once, however many ticks run afterwards.
    await sendDueScheduledEmails(new Date(2026, 9, 6, 17, 30, 0));
    expect(seen.filter((call) => call.url.endsWith("/users/me/messages/send"))).toHaveLength(1);
  });

  it("never sends twice, even when a tick runs into a slow Gmail", async () => {
    await connectGmail();
    scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Overlap", body: "Only once, please." }, MORNING);

    // Gmail is thinking; the 20-second tick fires again while it does.
    let release: () => void = () => {};
    sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = sendDueScheduledEmails(AT_FIVE_PM);
    // Twenty minutes later (the moment a second tick would see it *and* find the
    // entry long past its due time, which is exactly what looks "stale").
    const second = sendDueScheduledEmails(new Date(AT_FIVE_PM.getTime() + 20 * 60_000));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.sent.length + b.sent.length).toBe(1);
    expect(seen.filter((call) => call.url.endsWith("/users/me/messages/send"))).toHaveLength(1);
    // No "I'm not sure it went out" — a second tick inside a live send must not
    // decide the send died, or the person is told a lie about their own email.
    expect(assistantLines().some((line) => line.includes("I'm not sure the email"))).toBe(false);
    expect(listScheduledEmails(new Date(AT_FIVE_PM.getTime() + 60_000)).history[0]).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("keeps the person's own sending switch, daily cap and address checks", async () => {
    await connectGmail();
    const ok = scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Keys", body: "Keys are at the office." }, MORNING);
    expect(ok.status).toBe("scheduled");

    // Sending from chat turned off after it was scheduled: it must not slip out.
    saveGmailSendPolicy({ enabled: false });
    const refused = await sendDueScheduledEmails(AT_FIVE_PM);
    expect(refused.sent).toHaveLength(0);
    expect(refused.failed).toHaveLength(1);
    expect(refused.failed[0]!.lastError).toContain("turned off");
    expect(seen.some((call) => call.url.endsWith("/users/me/messages/send"))).toBe(false);
    expect(listScheduledEmails(AT_FIVE_PM).history[0]).toMatchObject({ status: "failed" });

    // A note in the chat says so, in words the person can act on.
    expect(assistantLines().some((line) => line.includes("couldn't send the email to marko@example.com"))).toBe(true);

    // And a daily cap is a cap, even for a queued email.
    resetScheduledEmailsForTests();
    saveGmailSendPolicy({ enabled: true, dailyLimit: 1 });
    scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "One", body: "First." }, MORNING);
    await sendDueScheduledEmails(new Date(2026, 9, 6, 17, 0, 0));
    scheduleEmail({ when: "tomorrow at 9am", to: "marko@example.com", subject: "Two", body: "Second." }, MORNING);
    const capped = await sendDueScheduledEmails(new Date(2026, 9, 7, 9, 0, 0));
    expect(capped.failed[0]!.lastError).toContain("emails a day");
  });

  it("reports a refusal instead of retrying it, and retries Google's own errors", async () => {
    await connectGmail();

    // A 403 from Google is a refusal: the person has to fix something.
    sendResponse = () => json({ error: { message: "forbidden" } }, 403);
    scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Keys", body: "Keys are at the office." }, MORNING);
    const refused = await sendDueScheduledEmails(AT_FIVE_PM);
    expect(refused.failed).toHaveLength(1);
    expect(listScheduledEmails(AT_FIVE_PM).history[0]!.attempts).toBe(1);
    expect(listScheduledEmails(AT_FIVE_PM).scheduled).toHaveLength(0);

    // A 503 is Google having a bad moment: it stays queued and tries again — but
    // not forever. Three attempts, then the person is told.
    resetScheduledEmailsForTests();
    sendResponse = () => json({ error: { message: "backend error" } }, 503);
    scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Keys", body: "Keys are at the office." }, MORNING);
    const firstTry = await sendDueScheduledEmails(AT_FIVE_PM);
    expect(firstTry.sent).toHaveLength(0);
    expect(firstTry.failed).toHaveLength(0);
    const stillWaiting = listScheduledEmails(AT_FIVE_PM).scheduled[0]!;
    expect(stillWaiting.status).toBe("scheduled");
    expect(stillWaiting.attempts).toBe(1);
    expect(stillWaiting.lastError).toContain("Gmail request failed");

    // Second attempt, an hour later (the queue backs off), now Google is well.
    sendResponse = () => json({ id: "sent-new-1", threadId: "thread-9" });
    const secondTry = await sendDueScheduledEmails(new Date(2026, 9, 6, 18, 0, 0));
    expect(secondTry.sent).toHaveLength(1);
    expect(listScheduledEmails(new Date(2026, 9, 6, 18, 0, 0)).history[0]!.attempts).toBe(2);

    // Three strikes on a broken Google: failed, with the reason kept.
    // Different words from the block above on purpose: the same words to the same
    // person inside five minutes is the double-send rule, and this is about
    // retries — a duplicate refusal here would be the wrong reason to stop.
    resetScheduledEmailsForTests();
    sendResponse = () => json({ error: { message: "backend error" } }, 503);
    scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Third attempt", body: "Still trying." }, MORNING);
    await sendDueScheduledEmails(AT_FIVE_PM);
    await sendDueScheduledEmails(new Date(2026, 9, 6, 18, 1, 0));
    const third = await sendDueScheduledEmails(new Date(2026, 9, 6, 19, 2, 0));
    expect(third.failed).toHaveLength(1);
    expect(third.failed[0]!.attempts).toBe(3);
  });

  it("sends late when the PC was off — and says how late — but never hours stale", async () => {
    await connectGmail();
    scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Keys", body: "Keys are at the office." }, MORNING);

    // The app was closed at 17:00 and started again at 17:40.
    const late = await sendDueScheduledEmails(new Date(2026, 9, 6, 17, 40, 0));
    expect(late.sent).toHaveLength(1);
    expect(late.sent[0]!.lateBy).toBe(40 * 60_000);
    expect(assistantLines().some((line) => line.includes("40 minute(s) after the at 17:00"))).toBe(true);

    // Eight hours later it is not an email any more: it is kept, unsent, and
    // the person is asked — sending a stale message silently would be worse.
    resetScheduledEmailsForTests();
    scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Keys", body: "Keys are at the office." }, MORNING);
    const staleAt = new Date(AT_FIVE_PM.getTime() + MAX_LATE_MS + 60_000);
    const sendsSoFar = seen.filter((call) => call.url.endsWith("/users/me/messages/send")).length;
    const missed = await sendDueScheduledEmails(staleAt);
    expect(missed.missed).toHaveLength(1);
    // The stale one added no send of its own.
    expect(seen.filter((call) => call.url.endsWith("/users/me/messages/send"))).toHaveLength(sendsSoFar);
    const history = listScheduledEmails(staleAt).history[0]!;
    expect(history.status).toBe("missed");
    expect(history.body).toBe("Keys are at the office.");
    expect(assistantLines().some((line) => line.includes("I didn't send the email to marko@example.com"))).toBe(true);
  });

  it("reports a send the app died in the middle of, and never repeats it", async () => {
    await connectGmail();
    const entry = scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Keys", body: "Keys are at the office." }, MORNING);
    // Exactly what a crash between "sending" and the answer leaves behind.
    const file = SCHEDULE_FILE();
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.emails = saved.emails.map((e: Record<string, unknown>) =>
      e.id === entry.id ? { ...e, status: "sending", attempts: 1 } : e,
    );
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));

    const result = await sendDueScheduledEmails(new Date(2026, 9, 6, 17, 20, 0));
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.lastError).toContain("Check the Sent folder");
    // The important half: nothing was sent again on the person's behalf.
    expect(seen.some((call) => call.url.endsWith("/users/me/messages/send"))).toBe(false);
    expect(assistantLines().some((line) => line.includes("Gmail's Sent folder has the answer"))).toBe(true);
  });

  it("cancels on request, and the cancelled email never goes out", async () => {
    await connectGmail();
    const queued = scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Keys", body: "Keys are at the office." }, MORNING);

    const context = toolContext();
    const cancelTool = toolsFor(context as never).find((tool) => tool.declaration.name === "cancel_scheduled_email")!;
    const cancelled = await cancelTool.run({ id: queued.id }, context as never);
    expect(cancelled).toMatchObject({ ok: true, cancelled: true, to: "marko@example.com", subject: "Keys" });

    const sent = await sendDueScheduledEmails(AT_FIVE_PM);
    expect(sent.sent).toHaveLength(0);
    expect(seen.some((call) => call.url.endsWith("/users/me/messages/send"))).toBe(false);
    expect(listScheduledEmails(AT_FIVE_PM).scheduled).toHaveLength(0);
    expect(listScheduledEmails(AT_FIVE_PM).history[0]).toMatchObject({ status: "cancelled" });

    // Cancelling by words works too — that is how a person refers to it.
    const again = scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Invoice for March", body: "Here it is." }, MORNING);
    const byWords = cancelScheduledEmail("the invoice", MORNING);
    expect(byWords.ok).toBe(true);
    expect(byWords.cancelled?.id).toBe(again.id);
    expect(cancelScheduledEmail("nothing like this", MORNING).ok).toBe(false);
  });

  it("answers a bad address or an unreadable time straight away, and stores nothing", () => {
    expect(() => scheduleEmail({ when: "at 5 pm", to: "not-an-address", subject: "x", body: "y" }, MORNING)).toThrowError(/valid To address/);
    expect(() => scheduleEmail({ when: "whenever", to: "marko@example.com", subject: "x", body: "y" }, MORNING)).toThrowError(/can't read a time/);
    expect(() => scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "x", body: "   " }, MORNING)).toThrowError(/needs something to say/);
    expect(() => scheduleEmail({ when: "now", to: "marko@example.com", subject: "x", body: "y" }, MORNING)).toThrow();
    expect(listScheduledEmails(MORNING).scheduled).toHaveLength(0);
  });

  it("schedules a reply inside its original conversation", async () => {
    await connectGmail();
    const context = toolContext();
    const replyTool = toolsFor(context as never).find((tool) => tool.declaration.name === "send_reply")!;

    const result = await replyTool.run({ messageId: "message-1", body: "Yes — 10 is fine.", when: "at 5 pm" }, context as never);
    expect(result).toMatchObject({ ok: true, scheduled: true, sent: false, when: "at 17:00" });
    expect(context.effects.emailScheduled?.[0]).toMatchObject({ when: "at 17:00" });
    expect(seen.some((call) => call.url.endsWith("/users/me/messages/send"))).toBe(false);

    await sendDueScheduledEmails(AT_FIVE_PM);
    const send = seen.filter((call) => call.url.endsWith("/users/me/messages/send")).at(-1)!;
    const raw = Buffer.from(String(send.body.raw), "base64url").toString("utf8");
    expect(send.body.threadId).toBe("thread-1");
    expect(raw).toContain("In-Reply-To: <original-message@example.com>");
    expect(raw).toContain("To: alice@example.com");
    expect(raw).toMatch(/Subject: Re: Meeting tomorrow/);
  });

  it("shows what is waiting over the API, and cancels it there", async () => {
    await connectGmail();
    const queued = scheduleEmail({ when: "tomorrow at 9am", to: "marko@example.com", subject: "Keys", body: "Keys are at the office." }, MORNING);

    const list = await request(app).get("/api/v1/email/scheduled");
    expect(list.status).toBe(200);
    expect(list.body.scheduled).toHaveLength(1);
    expect(list.body.scheduled[0]).toMatchObject({ id: queued.id, to: "marko@example.com", subject: "Keys", status: "scheduled", when: "tomorrow at 09:00" });
    // The text is readable before it goes: the person approves what will be sent.
    expect(list.body.scheduled[0].body).toBe("Keys are at the office.");

    const cancel = await request(app).delete(`/api/v1/email/scheduled/${queued.id}`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled).toMatchObject({ status: "cancelled" });
    expect((await request(app).get("/api/v1/email/scheduled")).body.scheduled).toHaveLength(0);

    const missing = await request(app).delete("/api/v1/email/scheduled/sch_nothing");
    expect(missing.status).toBe(404);
    // Same local-app boundary as the rest of the Gmail routes.
    const crossOrigin = await request(app).get("/api/v1/email/scheduled").set("Origin", "https://attacker.example");
    expect(crossOrigin.status).toBe(403);
  });

  it("tells the agent what is waiting, with the times", async () => {
    await connectGmail();
    scheduleEmail({ when: "at 5 pm", to: "marko@example.com", subject: "Keys", body: "Keys are at the office." }, MORNING);
    const context = toolContext();
    const tool = toolsFor(context as never).find((item) => item.declaration.name === "list_scheduled_emails")!;
    const listed = await tool.run({}, context as never);
    expect(listed).toMatchObject({ waiting: 1 });
    expect((listed as { note: string }).note).toContain("marko@example.com");
    expect((listed as { note: string }).note).toContain("at 17:00");
  });
});
