// ── "In 10 minutes" → a real moment in time ─────────────────────────────────
// The agent's timers and reminders, as pure functions so they can be tested
// without a clock: the model passes whatever the person said ("in 10 minutes",
// "tomorrow at 8", "at 17:30"), this turns it into an epoch millisecond, and
// what it can't understand it says it can't — never a guess about when to ring.

export type ReminderKind = "timer" | "reminder";

export interface ParsedWhen {
  at: number;
  kind: ReminderKind;
  /** The words the person used, tidied: "in 10 minutes", "tomorrow at 08:00". */
  said: string;
}

export interface ParseFailure {
  error: string;
}

export const MAX_REMINDER_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function clock(date: Date): { h: number; m: number } {
  return { h: date.getHours(), m: date.getMinutes() };
}

/** "10", "10m", "10 min", "10 minutes", "1h30", "2 hours", "90s", "1h 30m". */
function parseDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;
  // "1h30" / "2h15": the digits after the h are minutes. Rewritten before
  // matching, and only when no minutes unit is spelled out ("1h 30m" and
  // "2 hours 30 minutes" carry their own unit and are read as they are).
  const glued = /(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?\s*(\d{1,2})\b/.exec(trimmed);
  const t = glued && !/\d\s*(?:minutes?|mins?|m)\b/.test(trimmed) ? trimmed.replace(glued[0], `${glued[1]} hours ${glued[2]} minutes`) : trimmed;
  let ms = 0;
  let matched = false;
  const parts = t.matchAll(/(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g);
  for (const part of parts) {
    matched = true;
    const digits = part[1] ?? "";
    const unit = part[2] ?? "";
    const n = Number(digits.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) return null;
    if (/^h/.test(unit)) ms += n * HOUR;
    else if (/^m/.test(unit)) ms += n * MINUTE;
    else ms += n * 1000;
  }
  if (!matched) {
    // A bare number after "in" reads as minutes ("in 20").
    const bare = /^(\d+(?:[.,]\d+)?)$/.exec(t);
    if (bare) ms = Number((bare[1] ?? "0").replace(",", ".")) * MINUTE;
    else return null;
  }
  return ms > 0 ? ms : null;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "5:30pm" / "17:30" / "8" / "8 am" → hours and minutes, or null. */
function parseClock(text: string): { h: number; m: number } | null {
  const t = text.trim().toLowerCase().replace(/\./g, "");
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1] ?? "0");
  const min = m[2] ? Number(m[2]) : 0;
  const suffix = m[3];
  if (min > 59) return null;
  if (suffix === "pm" && h < 12) h += 12;
  if (suffix === "am" && h === 12) h = 0;
  if (h > 23) return null;
  // "at 8" with no am/pm: the next 8 o'clock, morning unless it's already past.
  if (!suffix && h < 8) h += 12;
  return { h, m: min };
}

function withClock(date: Date, h: number, m: number): Date {
  const out = new Date(date);
  out.setHours(h, m, 0, 0);
  return out;
}

/**
 * What did the person mean? Returns the moment, whether it reads as a timer
 * (a duration from now) or a reminder (a time of day), and the wording to show.
 * Anything else is an honest miss, with the shapes that do work.
 */
export function parseWhen(input: string, now: Date = new Date()): ParsedWhen | ParseFailure {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return { error: 'When? Say it like "in 10 minutes", "at 17:30", "tomorrow at 8am" or "friday at 9".' };
  }
  const text = raw.toLowerCase().replace(/^for\s+/, "").replace(/^in\s+/, "in ");

  // Durations: "in 10 minutes", "10 min", "1h 30m", "half an hour", "an hour".
  const durationText = text.replace(/^in\s+/, "");
  const worded = /^(?:half an hour|half hour|30 minutes?)$/.test(durationText)
    ? 30 * MINUTE
    : /^(?:an hour|one hour|1 hour)$/.test(durationText)
      ? HOUR
      : /^(?:a minute|one minute)$/.test(durationText)
        ? MINUTE
        : null;
  const duration = worded ?? parseDuration(durationText);
  if (duration != null) {
    if (duration > MAX_REMINDER_AHEAD_MS) return { error: "That's more than a year away — I won't remember that far." };
    const at = now.getTime() + Math.round(duration);
    return { at, kind: "timer", said: `in ${describeGapDuration(duration)}` };
  }

  const day = now.getDay();
  const { h: nowH, m: nowM } = clock(now);
  const atClock = (h: number, m: number, dayOffset = 0): number => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    return withClock(d, h, m).getTime();
  };

  // "tomorrow at 8" / "tomorrow 8:30"
  const tomorrow = /\btomorrow\b/.exec(text);
  if (tomorrow) {
    const rest = text.slice(tomorrow.index + tomorrow[0].length).replace(/^[\s,]*at\s+/, "");
    const c = parseClock(rest);
    if (!c) return { error: 'Tomorrow at what time? Say "tomorrow at 8am" or "tomorrow at 17:30".' };
    return { at: atClock(c.h, c.m, 1), kind: "reminder", said: `tomorrow at ${pad(c.h)}:${pad(c.m)}` };
  }

  // "tonight" — 21:00 if it's still coming, otherwise tomorrow evening.
  if (/\btonight\b/.test(text)) {
    const h = 21;
    const same = atClock(h, 0);
    return { at: same > now.getTime() ? same : atClock(h, 0, 1), kind: "reminder", said: "tonight at 21:00" };
  }

  // A weekday: "monday at 9", "on friday 17:00" — the next one, never today.
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const weekday = WEEKDAYS[i] ?? "";
    if (!new RegExp(`\\b${weekday}\\b`).test(text)) continue;
    const rest = text.replace(/^[a-z]*\s*on\s+/, "").replace(new RegExp(`(?:next\\s+)?${weekday}\\b`), "").replace(/^\s*at\s+/, "").trim();
    const c = parseClock(rest) ?? { h: 9, m: 0 };
    // "monday" always means the coming one — never today, even on a Monday.
    const ahead = ((i - day + 7) % 7) || 7;
    const at = atClock(c.h, c.m, ahead);
    return { at, kind: "reminder", said: `${weekday[0]?.toUpperCase() ?? ""}${weekday.slice(1)} at ${pad(c.h)}:${pad(c.m)}` };
  }

  // "at 17:30" / "8:00" / "8pm"
  const atWord = /\bat\s+(.+)$/.exec(text);
  const clockText = atWord?.[1] ?? text;
  const c = parseClock(clockText);
  if (c) {
    const today = atClock(c.h, c.m);
    const past = c.h < nowH || (c.h === nowH && c.m <= nowM);
    const at = past ? atClock(c.h, c.m, 1) : today;
    return { at, kind: "reminder", said: `${past ? "tomorrow at " : "at "}${pad(c.h)}:${pad(c.m)}` };
  }

  return {
    error: `I can't read a time from “${raw}”. Say it like "in 10 minutes", "at 17:30" or "tomorrow at 8am".`,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "in 10 minutes", "in 1 hour 5 minutes", "in 45 seconds" — the same wording the person used. */
export function describeGapDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const bits: string[] = [];
  if (h) bits.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m) bits.push(`${m} minute${m === 1 ? "" : "s"}`);
  if (!h && !m) bits.push(`${s} second${s === 1 ? "" : "s"}`);
  return bits.join(" ");
}

/**
 * How far away it is, in words: "in 10 minutes", "in 3 hours", "in 2 days",
 * "now" when it's due, "just now" once it has passed.
 */
export function describeWhen(at: number, now: Date = new Date()): string {
  const gap = at - now.getTime();
  if (gap <= 0) return "now";
  const minutes = Math.round(gap / MINUTE);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(gap / HOUR);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(gap / (24 * HOUR));
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

export interface ReminderLike {
  id: string;
  at: number;
  label: string;
  kind: ReminderKind;
  createdAt: number;
  /** Set the moment it rang, so it never rings twice. */
  firedAt?: number | null;
}

/** Everything due and not yet rung, oldest first. */
export function dueReminders<T extends ReminderLike>(reminders: T[], now: Date = new Date()): T[] {
  return reminders.filter((r) => !r.firedAt && r.at <= now.getTime()).sort((a, b) => a.at - b.at);
}

/** What the agent says when it rings — in the chat and on the phone. */
export function reminderMessage(r: ReminderLike): string {
  const head = r.kind === "timer" ? "⏰ Timer done" : "⏰ Reminder";
  return r.label ? `${head} — ${r.label}` : head;
}

/** The line list_reminders answers with. */
export function describeReminder(r: ReminderLike, now: Date = new Date()): string {
  const when = new Date(r.at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${r.label ? `“${r.label}” — ` : ""}${r.kind === "timer" ? "timer" : "reminder"} ${describeWhen(r.at, now)} (${when})`;
}
