// ── Email that goes out at the time you asked for ───────────────────────────
// "Send this to Marko at 5 pm." The message is written when the person asks —
// so they see exactly what will go out, and can cancel it — and it is sent at
// the time they named, with **no second confirmation**: asking twice is not
// what "send it at 5" means, and a scheduled email that waits for someone to be
// at the keyboard is not scheduled at all.
//
// It lives on this PC, like the reminders: the app must be running (the tray
// counts) for the moment to be kept. If the PC was off or asleep when the time
// came, the email goes out at the next start — the announce line says how late
// it really was — unless it is more than MAX_LATE_MS late, in which case it is
// kept, marked "missed", and *not* sent (a stale email arriving hours late is
// worse than asking), with the text still there to send on request.
//
// Every send goes through the same door as an immediate one
// (gmailService.sendMessage → assertSendAllowed + the no-duplicates rule), so
// "sending from chat is off", the daily cap and the address checks apply to a
// scheduled email exactly as they do to "send this now". A refused send is
// *failed*, never quietly retried forever: the agent tells the person why.
//
// Nothing here guesses: an unreadable time is an honest error, and an entry is
// marked "sending" (durably) *before* the network call, so a crash mid-send can
// never turn into a second email — an interrupted send is reported, and Gmail's
// Sent folder is where the truth is checked.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { appendToConversation } from "./conversation.js";
import { chatTime, newMessageId, type ChatMessage } from "./chatMessages.js";
import { GmailError, MAX_BODY_CHARS, gmailService, parseRecipients } from "./gmail.js";
import { MAX_REMINDER_AHEAD_MS, describeWhen, parseWhen } from "./brain/core/reminders.js";

export type ScheduledStatus = "scheduled" | "sending" | "sent" | "failed" | "missed" | "cancelled";

export interface ScheduledEmail {
  id: string;
  createdAt: number;
  /** When it should go out. */
  at: number;
  /** The person's own words for the moment: "at 17:00", "tomorrow at 08:00". */
  when: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** A scheduled reply to a message from list_emails/read_email, if any. */
  replyToMessageId?: string;
  status: ScheduledStatus;
  /** How many times a send was attempted (0 while it is still waiting). */
  attempts: number;
  /** When the current attempt began — what decides whether a "sending" entry died. */
  sendingSince?: number;
  /** Why it failed, in the words the person should see. */
  lastError?: string;
  /** When it actually went out. */
  sentAt?: number;
  messageId?: string;
  /** How late it really was (sentAt − at) when that is worth saying. */
  lateBy?: number;
  /** When it was cancelled. */
  cancelledAt?: number;
}

export interface ScheduledEmailView extends ScheduledEmail {
  /** "in 2 hours", "now", "just now" — how far off it is. */
  due: string;
  /** "Tue 17:00" — the moment in this PC's own time. */
  atLocal: string;
}

interface ScheduleFile {
  emails: ScheduledEmail[];
}

/** The window a queued email may still be sent in once its moment has passed. */
export const MAX_LATE_MS = 6 * 60 * 60 * 1000;
/** Give up after this many *transient* failures (a 5xx from Google, a dead network). */
const MAX_ATTEMPTS = 3;
/** Writes are kept this long after they finish, so the page can show what happened. */
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;
const FILE_LIMIT = 100;
/** A transient failure waits this long before the next try. */
const RETRY_BACKOFF_MS = 60_000;
/** A send that has been "sending" longer than this died with the app. */
const SENDING_STALE_MS = 10 * 60_000;
/** Never two ticks inside the queue at once (a slow Gmail, a 20-second tick). */
let running = false;

function fileFor(): string {
  return path.join(config.dataDir, "gmail", "scheduled.json");
}

function load(): ScheduledEmail[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as ScheduleFile;
    if (!Array.isArray(parsed?.emails)) return [];
    return parsed.emails.filter((e) => e && typeof e.id === "string" && typeof e.at === "number");
  } catch {
    return [];
  }
}

function save(emails: ScheduledEmail[]): void {
  const now = Date.now();
  const finished = (s: ScheduledStatus) => s === "sent" || s === "failed" || s === "cancelled" || s === "missed";
  const kept = emails
    .filter((e) => !(finished(e.status) && now - (e.sentAt ?? e.cancelledAt ?? e.at) > KEEP_FINISHED_MS))
    .sort((a, b) => a.at - b.at)
    .slice(-FILE_LIMIT);
  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ emails: kept }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function newId(): string {
  return `sch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function cleanSubject(value: string): string {
  return String(value ?? "")
    .replace(/[\r\n\0]/g, " ")
    .trim()
    .slice(0, 500);
}

/** Addresses as written → the header each field should carry, or a refusal. */
function recipientsFor(field: "To" | "Cc" | "Bcc", value: string): string {
  if (!String(value ?? "").trim()) return "";
  const { list, invalid } = parseRecipients(value);
  if (invalid.length) {
    throw new GmailError(
      `That doesn't look like a valid ${field} address: ${invalid.join(", ")}. Nothing was scheduled.`,
      422,
      "BAD_RECIPIENT",
    );
  }
  return list.join(", ");
}

/** "at 5 pm" → the moment, plus the wording to show. An unreadable time is an error, never a guess. */
function resolveWhen(when: string, now: Date): { at: number; said: string } {
  const parsed = parseWhen(when, now);
  if (!("error" in parsed)) return { at: parsed.at, said: parsed.said };
  // A model (or a person pasting one) may hand over an exact moment instead of
  // words. That is still exact, so accept it — but only as a fallback.
  const iso = Date.parse(String(when ?? "").trim());
  if (Number.isFinite(iso)) {
    const at = new Date(iso);
    return { at: iso, said: at.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) };
  }
  throw new GmailError(parsed.error, 422, "BAD_WHEN");
}

export interface ScheduleInput {
  when: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  replyToMessageId?: string;
}

/**
 * Queues the email the person asked for. Validated *now* (addresses, body,
 * time) so a mistake is answered while they are still in the conversation —
 * not silently at 5 pm.
 */
export function scheduleEmail(input: ScheduleInput, now: Date = new Date()): ScheduledEmailView {
  const replyToMessageId = String(input.replyToMessageId ?? "").trim().slice(0, 500);
  const body = String(input.body ?? "").trim();
  if (!body) throw new GmailError("An email needs something to say — the message body was empty, so nothing was scheduled.", 422, "EMPTY_BODY");
  const to = recipientsFor("To", input.to ?? "");
  const cc = recipientsFor("Cc", input.cc ?? "");
  const bcc = recipientsFor("Bcc", input.bcc ?? "");
  if (!to && !cc && !bcc && !replyToMessageId) {
    throw new GmailError("There was no email address to send to, so nothing was scheduled. Ask the person who they mean.", 422, "NO_RECIPIENT");
  }
  const { at, said } = resolveWhen(input.when, now);
  if (at - now.getTime() > MAX_REMINDER_AHEAD_MS) {
    throw new GmailError("That's more than a year away — I can't hold an email that long. Pick a nearer time.", 422, "WHEN_TOO_FAR");
  }
  // Under a minute away is "now" by any reasonable reading: scheduling it would
  // only add a tick of latency, so say so instead of pretending.
  if (at - now.getTime() < 60_000) {
    throw new GmailError(
      `That's ${at <= now.getTime() ? "already passed" : "less than a minute away"}. Send it now instead, or name a later time.`,
      422,
      "WHEN_TOO_SOON",
    );
  }

  const entry: ScheduledEmail = {
    id: newId(),
    createdAt: now.getTime(),
    at,
    when: said,
    to,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    subject: cleanSubject(input.subject ?? ""),
    body: body.slice(0, MAX_BODY_CHARS),
    ...(replyToMessageId ? { replyToMessageId } : {}),
    status: "scheduled",
    attempts: 0,
  };
  save([...load(), entry]);
  return view(entry, now);
}

function atLocal(at: number): string {
  return new Date(at).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

function view(entry: ScheduledEmail, now: Date): ScheduledEmailView {
  const due =
    entry.status === "scheduled"
      ? describeWhen(entry.at, now)
      : entry.status === "sent"
        ? `sent ${atLocal(entry.sentAt ?? entry.at)}${entry.lateBy ? ` (${Math.round(entry.lateBy / 60_000)} min late)` : ""}`
        : entry.status === "cancelled"
          ? `cancelled ${atLocal(entry.cancelledAt ?? entry.at)}`
          : entry.status === "sending"
            ? "sending now"
            : entry.status === "missed"
              ? `missed — was due ${atLocal(entry.at)}`
              : `couldn't send — was due ${atLocal(entry.at)}`;
  return { ...entry, due, atLocal: atLocal(entry.at) };
}

/** Everything waiting, soonest first, then the recent finished ones (newest first). */
export function listScheduledEmails(now: Date = new Date()): { scheduled: ScheduledEmailView[]; history: ScheduledEmailView[] } {
  const all = load();
  const waiting = all
    .filter((e) => e.status === "scheduled" || e.status === "sending")
    .sort((a, b) => a.at - b.at)
    .map((e) => view(e, now));
  const history = all
    .filter((e) => e.status === "sent" || e.status === "failed" || e.status === "missed" || e.status === "cancelled")
    .sort((a, b) => (b.sentAt ?? b.cancelledAt ?? b.at) - (a.sentAt ?? a.cancelledAt ?? a.at))
    .map((e) => view(e, now));
  return { scheduled: waiting, history };
}

/** Words that describe an email rather than identify it ("the", "email", "send"). */
const FILLER = new Set([
  "the", "one", "that", "this", "email", "emails", "mail", "message", "to", "for", "about", "from",
  "scheduled", "send", "sending", "waiting", "out", "and", "with", "please", "cancel", "him", "her", "them",
]);

/**
 * Does a description like "the invoice" or "the one to Marko" point at this
 * email? Every word that carries meaning must appear in who/what it is — so
 * "the invoice to Marko" needs both, while filler words are ignored.
 */
function wordsMatch(haystack: string, needle: string): boolean {
  const words = needle
    .toLowerCase()
    .split(/[^a-z0-9@._+-]+/)
    .filter((word) => word.length >= 3 && !FILLER.has(word));
  if (!words.length) return false;
  const hay = haystack.toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** Cancels by id, or by who/what it is ("the one to Marko", "the invoice"). */
export function cancelScheduledEmail(idOrWords: string, now: Date = new Date()): { ok: boolean; cancelled?: ScheduledEmailView; error?: string } {
  const needle = String(idOrWords ?? "").trim();
  if (!needle) return { ok: false, error: "Which one? The scheduled list shows what's waiting." };
  const all = load();
  const waiting = all.filter((e) => e.status === "scheduled" || e.status === "sending");
  const lower = needle.toLowerCase();
  const match =
    waiting.find((e) => e.id === needle) ??
    waiting.find((e) => e.subject.toLowerCase() === lower) ??
    waiting.find((e) => wordsMatch(`${e.to} ${e.cc ?? ""} ${e.bcc ?? ""} ${e.subject}`, needle));
  if (!match) {
    return {
      ok: false,
      error: waiting.length
        ? `Nothing waiting matches “${needle}”. Waiting: ${waiting.map((e) => `${e.to || e.replyToMessageId} “${e.subject || "(no subject)"}” (${e.when})`).join("; ")}.`
        : "Nothing is scheduled — there's no email waiting to be sent.",
    };
  }
  // A cancelled email is finished: it is never picked up by the ticker again.
  const next = all.map((e) => (e.id === match.id ? { ...e, status: "cancelled" as const, cancelledAt: now.getTime() } : e));
  save(next);
  return { ok: true, cancelled: view(next.find((e) => e.id === match.id) as ScheduledEmail, now) };
}

/** How the moment is announced: the shared conversation (phone sees it) + a desktop notification. */
function announce(text: string): void {
  const message: ChatMessage = {
    id: newMessageId(),
    sender: "assistant",
    text,
    time: chatTime(),
    at: Date.now(),
    tag: "SYS",
  };
  try {
    appendToConversation(message);
  } catch (err) {
    console.warn("[email-schedule] could not announce:", (err as Error).message);
  }
  const host = (globalThis as { __soundwaveDesktopHost?: { notify?(opts: { title: string; body: string; route?: string }): boolean } })
    .__soundwaveDesktopHost;
  try {
    host?.notify?.({ title: "Soundwave", body: text, route: "/agent" });
  } catch {
    /* notifications are a bonus, never a failure */
  }
}

function describeTarget(entry: ScheduledEmail): string {
  const who = entry.to || entry.cc || entry.bcc || (entry.replyToMessageId ? "the conversation" : "(no address)");
  return `${who} — “${entry.subject || "(no subject)"}”`;
}

/** "3 days", "5 hours", "20 minutes" — how overdue something is, coarsely. */
function describeLateness(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Google's own hiccups are worth another try; a refusal is not. */
function isTransient(err: unknown): boolean {
  if (!(err instanceof GmailError)) return true;
  if (err.status >= 500) return true;
  return err.code === "SEND_UNCONFIRMED";
}

function sendOne(entry: ScheduledEmail): Promise<{ messageId: string; threadId: string; to: string; subject: string }> {
  if (entry.replyToMessageId) {
    return gmailService.sendReply(entry.replyToMessageId, entry.body, { source: "agent" });
  }
  return gmailService.sendMessage(
    { to: entry.to, cc: entry.cc ?? "", bcc: entry.bcc ?? "", subject: entry.subject, body: entry.body },
    { source: "agent" },
  );
}

/**
 * Sends everything that's due, oldest first. Called by the ticker and directly
 * by the tests. A queued email is marked "sending" *and saved* before the
 * network call, so an interrupted send is reported rather than repeated.
 */
export async function sendDueScheduledEmails(now: Date = new Date()): Promise<{ sent: ScheduledEmail[]; failed: ScheduledEmail[]; missed: ScheduledEmail[] }> {
  const sent: ScheduledEmail[] = [];
  const failed: ScheduledEmail[] = [];
  const missed: ScheduledEmail[] = [];
  if (running) return { sent, failed, missed };
  running = true;
  try {
    return await drainDue(now, sent, failed, missed);
  } finally {
    running = false;
  }
}

async function drainDue(
  now: Date,
  sent: ScheduledEmail[],
  failed: ScheduledEmail[],
  missed: ScheduledEmail[],
): Promise<{ sent: ScheduledEmail[]; failed: ScheduledEmail[]; missed: ScheduledEmail[] }> {
  const all = load();
  if (!all.length) return { sent, failed, missed };

  let changed = false;
  // 1. An entry left "sending" by a crash or a kill: never retried silently —
  //    Gmail may already have it, and a second copy is worse than a question.
  for (const entry of all) {
    const startedSendingAt = entry.sendingSince ?? entry.at;
    if (entry.status === "sending" && now.getTime() - startedSendingAt > SENDING_STALE_MS) {
      entry.status = "failed";
      entry.lastError = "Soundwave stopped while this was being sent. Check the Sent folder in Gmail — it may have gone out.";
      changed = true;
      failed.push(entry);
      announce(`✉️ I'm not sure the email to ${describeTarget(entry)} went out — Soundwave closed while sending it. Gmail's Sent folder has the answer; nothing was retried.`);
    }
  }

  // 2. Anything that is due now.
  const due = all.filter((entry) => entry.status === "scheduled" && entry.at <= now.getTime()).sort((a, b) => a.at - b.at);
  for (const entry of due) {
    const late = now.getTime() - entry.at;
    if (late > MAX_LATE_MS) {
      entry.status = "missed";
      entry.lastError = `This PC was off at ${entry.when}; it's ${describeLateness(now.getTime() - entry.at)} late, so I left it unsent. Ask me to send it now and I will.`;
      changed = true;
      missed.push(entry);
      announce(`✉️ I didn't send the email to ${describeTarget(entry)} — it was due ${entry.when} and this PC was off until now. Say the word and I'll send it as it is.`);
      continue;
    }
    // Durable before the attempt: one email, ever.
    entry.status = "sending";
    entry.sendingSince = now.getTime();
    entry.attempts += 1;
    changed = true;
    save(all);
    try {
      const result = await sendOne(entry);
      entry.status = "sent";
      entry.sentAt = now.getTime();
      entry.messageId = result.messageId;
      entry.lastError = undefined;
      if (entry.sentAt - entry.at > 90_000) entry.lateBy = entry.sentAt - entry.at;
      changed = true;
      sent.push(entry);
      const lateNote = entry.lateBy ? `, ${Math.round(entry.lateBy / 60_000)} minute(s) after the ${entry.when} you asked for` : "";
      announce(`✉️ Sent to ${describeTarget(entry)}${lateNote}.`);
    } catch (err) {
      const message = err instanceof GmailError ? err.message : `Couldn't reach Gmail: ${(err as Error).message}`;
      const transient = isTransient(err);
      if (transient && entry.attempts < MAX_ATTEMPTS) {
        // Back to waiting: the ticker tries again shortly instead of hammering Google.
        entry.status = "scheduled";
        entry.at = Math.max(entry.at, now.getTime() + RETRY_BACKOFF_MS);
        entry.lastError = message;
        changed = true;
        console.warn(`[email-schedule] ${entry.id}: attempt ${entry.attempts} failed (${message}); retrying`);
      } else {
        entry.status = "failed";
        entry.lastError = message;
        changed = true;
        failed.push(entry);
        announce(`✉️ I couldn't send the email to ${describeTarget(entry)} — ${message}`);
      }
    }
  }
  if (changed) save(all);
  return { sent, failed, missed };
}

/** Tests: start from an empty schedule. */
export function resetScheduledEmailsForTests(): void {
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing there */
  }
}

/**
 * The server calls this once. Twenty seconds is the same cadence the reminders
 * use: close enough that "at 17:00" means 17:00, cheap enough to forget about.
 * The first tick is soon after start, which is also the catch-up for a PC that
 * was off when an email was due.
 */
export function initEmailSchedule(): () => void {
  const tick = () => {
    sendDueScheduledEmails().catch((err) => console.warn("[email-schedule] tick failed:", (err as Error).message));
  };
  const timer = setInterval(tick, 20_000);
  timer.unref?.();
  const first = setTimeout(tick, 5_000);
  first.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
