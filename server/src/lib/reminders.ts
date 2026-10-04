// ── Timers and reminders that really ring ───────────────────────────────────
// "Remind me to check the render in 20 minutes." The moment is worked out by
// brain/core/reminders.ts (pure, tested); this file holds the list on disk,
// rings them once, and puts the ring in the shared conversation — so the
// Command Center, the voice bar and the phone all show it, and a desktop
// notification pops when the app is in the tray.
//
// It lives on this PC: Soundwave has to be running (the tray counts) for a
// timer to go off, and the agent says so when it sets one. Nothing is faked:
// a reminder that never rang can't exist here — it either rings or the person
// cancels it, and list_reminders shows exactly what is waiting.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { appendToConversation } from "./conversation.js";
import { chatTime, newMessageId, type ChatMessage } from "./chatMessages.js";
import {
  MAX_REMINDER_AHEAD_MS,
  describeReminder,
  dueReminders,
  parseWhen,
  reminderMessage,
  type ReminderKind,
  type ReminderLike,
} from "./brain/core/reminders.js";

export type Reminder = ReminderLike;

interface ReminderFile {
  reminders: Reminder[];
}

const FILE_LIMIT = 100;
const KEEP_FIRED_MS = 7 * 24 * 60 * 60 * 1000;

function fileFor(): string {
  return path.join(config.dataDir, "reminders.json");
}

function load(): Reminder[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as ReminderFile;
    return Array.isArray(parsed?.reminders) ? parsed.reminders.filter((r) => r && typeof r.at === "number") : [];
  } catch {
    return [];
  }
}

function save(reminders: Reminder[]): void {
  const now = Date.now();
  const kept = reminders
    .filter((r) => !r.firedAt || now - r.firedAt < KEEP_FIRED_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, FILE_LIMIT);
  try {
    fs.mkdirSync(path.dirname(fileFor()), { recursive: true });
    fs.writeFileSync(fileFor(), JSON.stringify({ reminders: kept }, null, 2));
  } catch (err) {
    console.warn("[reminders] could not save:", (err as Error).message);
  }
}

export interface ReminderView {
  id: string;
  at: number;
  label: string;
  kind: ReminderKind;
  /** "in 10 minutes", "tomorrow at 08:00" — the same shape the agent answers with. */
  when: string;
  text: string;
}

function view(r: Reminder, now: Date): ReminderView {
  return { id: r.id, at: r.at, label: r.label, kind: r.kind, when: describeReminder(r, now), text: reminderMessage(r) };
}

/** Everything waiting to ring, soonest first. */
export function listReminders(now: Date = new Date()): ReminderView[] {
  return load()
    .filter((r) => !r.firedAt)
    .sort((a, b) => a.at - b.at)
    .map((r) => view(r, now));
}

export interface CreateResult {
  ok: boolean;
  /** The reminder that was set (when ok). */
  reminder?: ReminderView;
  error?: string;
}

/**
 * Sets a timer or a reminder from what the person said ("in 10 minutes",
 * "tomorrow at 8am", "at 17:30"). A time it can't read is an honest error, never
 * a guess: the caller passes the parse failure's sentence straight on.
 */
export function createReminder(when: string, label = "", now: Date = new Date()): CreateResult {
  const parsed = parseWhen(when, now);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const at = parsed.at;
  if (at - now.getTime() > MAX_REMINDER_AHEAD_MS) {
    return { ok: false, error: "That's more than a year away — I won't remember that far." };
  }
  const clean = String(label ?? "").trim().slice(0, 200);
  const reminder: Reminder = {
    id: `rem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    at,
    label: clean,
    kind: parsed.kind,
    createdAt: now.getTime(),
    firedAt: null,
  };
  const all = load();
  all.push(reminder);
  save(all);
  return { ok: true, reminder: view(reminder, now) };
}

/** Cancels by id, or by the words of its label ("the render"). Returns what went. */
export function cancelReminder(idOrLabel: string, now: Date = new Date()): { ok: boolean; cancelled?: ReminderView; error?: string } {
  const needle = String(idOrLabel ?? "").trim();
  if (!needle) return { ok: false, error: "Which one? list_reminders shows what's waiting." };
  const all = load();
  const waiting = all.filter((r) => !r.firedAt);
  const exact = waiting.find((r) => r.id === needle);
  const byLabel =
    exact ??
    waiting.find((r) => r.label.toLowerCase() === needle.toLowerCase()) ??
    waiting.find((r) => needle.length >= 3 && r.label.toLowerCase().includes(needle.toLowerCase()));
  if (!byLabel) {
    return {
      ok: false,
      error: waiting.length
        ? `Nothing waiting matches “${needle}”. Waiting: ${waiting.map((r) => (r.label ? `${r.label} (${describeReminder(r, now)})` : describeReminder(r, now))).join("; ")}.`
        : "Nothing is waiting — there's no timer or reminder to cancel.",
    };
  }
  save(all.filter((r) => r.id !== byLabel.id));
  return { ok: true, cancelled: view(byLabel, now) };
}

/** Tests: start from an empty list. */
export function resetRemindersForTests(): void {
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing there */
  }
}

/** How the ring gets announced: the chat, and a desktop notification when there is one. */
function announce(reminder: Reminder): void {
  const text = reminderMessage(reminder);
  const message: ChatMessage = {
    id: newMessageId(),
    sender: "assistant",
    text,
    time: chatTime(),
    at: Date.now(),
    tag: "SYS",
  };
  appendToConversation(message);
  const host = (globalThis as { __soundwaveDesktopHost?: { notify?(opts: { title: string; body: string; route?: string }): boolean } })
    .__soundwaveDesktopHost;
  try {
    host?.notify?.({ title: "Soundwave", body: text, route: "/agent" });
  } catch {
    /* notifications are a bonus, never a failure */
  }
}

/**
 * Rings everything that's due, exactly once. Called every 20 seconds by the
 * server once it's up, and directly by the tests.
 */
export function ringDueReminders(now: Date = new Date()): Reminder[] {
  const all = load();
  const due = dueReminders(all, now);
  if (!due.length) return [];
  const firedAt = Date.now();
  for (const r of due) r.firedAt = firedAt;
  // Marked and saved first: a reminder rings once, even if announcing it throws.
  save(all);
  for (const r of due) announce(r);
  return due;
}

/** The server calls this once. Returns a stop function (tests use it). */
export function initReminders(): () => void {
  const tick = () => {
    try {
      ringDueReminders();
    } catch (err) {
      console.warn("[reminders] tick failed:", (err as Error).message);
    }
  };
  const timer = setInterval(tick, 20_000);
  timer.unref?.();
  const first = setTimeout(tick, 4_000);
  first.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
