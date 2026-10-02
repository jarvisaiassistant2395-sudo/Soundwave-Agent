// ── Alarms on the phone (shared by the PC's brain and the phone's own) ──────
// The agent can set an alarm on the user's Android phone. At that time the
// phone rings (its own alarm screen, with Snooze and Turn off); when the user
// turns it off, the morning briefing starts by itself a few seconds later —
// the delay is the user's to set (phone Settings → Alarm, default 30 s), and
// the agent may give one per alarm.
//
// This file is pure TypeScript (no Node APIs, no packages): the PC builds the
// request for the phone with it, and the phone app uses the same rules when it
// answers by itself with the PC off.

import type { GeminiFunctionDeclaration } from "./gemini.js";

export const PHONE_ALARM_TOOL = "set_phone_alarm";

/** Alarms arrived in this version of the phone app (the PC checks the paired phone's). */
export const ALARMS_MIN_APP_VERSION = "1.3.0";

/** The morning briefing starts this many seconds after the alarm is turned off. */
export const DEFAULT_BRIEFING_AFTER_ALARM_SECONDS = 30;
/** Ten minutes is the most a person would wait; anything longer isn't "right after". */
export const MAX_BRIEFING_AFTER_ALARM_SECONDS = 600;

export const PHONE_ALARM_DECLARATION: GeminiFunctionDeclaration = {
  name: PHONE_ALARM_TOOL,
  description:
    "Set an alarm on the user's phone (the Soundwave Android companion app). Give the clock time in 24-hour HH:MM — work out the time yourself when they say \"in 20 minutes\" — or in_seconds for a short test. The phone rings at that time with Snooze and Turn off; when the user turns it off, their morning briefing starts by itself a few seconds later (the delay is theirs to set, default 30 s; briefing_after_seconds changes it for this alarm). The alarm lives on the phone, so the phone must be paired and connected (its app open) for this to work — when it isn't, say so instead of pretending it's set.",
  parameters: {
    type: "OBJECT",
    properties: {
      time: { type: "STRING", description: "Clock time on the phone, 24-hour HH:MM, e.g. \"06:30\" or \"17:45\". The next time it comes around is used (tomorrow if it has already passed today)." },
      in_seconds: { type: "NUMBER", description: "Instead of a clock time: the alarm goes off this many seconds from now (for tests or short reminders)." },
      label: { type: "STRING", description: 'A short name for the alarm, e.g. "Gym" or "Wake up". Optional.' },
      briefing_after_seconds: { type: "NUMBER", description: "Seconds after the user turns the alarm off before the morning briefing starts (0–600; default 30)." },
    },
    required: [],
  },
};

export interface AlarmTarget {
  /** When it rings, ms since epoch. */
  at: number;
  /** The clock time the user was told, "6:30 AM" (24-hour input → spoken label). */
  label12: string;
}

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "6:30" / "06:30" → { h, m }, or null when it isn't a clock time. */
export function parseClockTime(time: unknown): { h: number; m: number } | null {
  if (typeof time !== "string") return null;
  const m = CLOCK.exec(time.trim());
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

/** The next time that clock time comes around: today if still ahead, else tomorrow. */
export function nextAlarmAt(time: unknown, now: Date = new Date()): number | null {
  const clock = parseClockTime(time);
  if (!clock) return null;
  const at = new Date(now);
  at.setHours(clock.h, clock.m, 0, 0);
  if (at.getTime() <= now.getTime() + 1000) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** "6:30 AM" — how the alarm time is written in the conversation and spoken. */
export function clockLabel(at: number): string {
  const d = new Date(at);
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m} ${h24 < 12 ? "AM" : "PM"}`;
}

/**
 * The alarm the tool args ask for. `in_seconds` wins (it's the explicit one);
 * otherwise the next occurrence of the clock time. Null when neither is usable.
 */
export function alarmTarget(args: { time?: unknown; in_seconds?: unknown }, now: Date = new Date()): AlarmTarget | null {
  const seconds = typeof args.in_seconds === "number" && Number.isFinite(args.in_seconds) ? Math.round(args.in_seconds) : null;
  if (seconds !== null && seconds > 0) {
    const at = now.getTime() + Math.min(seconds, 7 * 24 * 3600) * 1000;
    return { at, label12: clockLabel(at) };
  }
  const at = nextAlarmAt(args.time, now);
  return at === null ? null : { at, label12: clockLabel(at) };
}

/** The briefing delay for this alarm (clamped), falling back to the phone's setting. */
export function briefingAfterSeconds(value: unknown, fallback = DEFAULT_BRIEFING_AFTER_ALARM_SECONDS): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
  const base = n === null ? fallback : n;
  return Math.min(MAX_BRIEFING_AFTER_ALARM_SECONDS, Math.max(0, base));
}

/**
 * Whether that app version can set alarms: true, false, or null when it can't
 * be read ("dev", a pairing that never said). Only the phone app has the
 * native alarm code, so an older build can't ring — the PC says so instead of
 * claiming an alarm it can't set.
 */
export function supportsAlarms(appVersion: unknown): boolean | null {
  if (typeof appVersion !== "string") return null;
  const parts = (v: string) => v.split(/[^\d]+/).filter(Boolean).map(Number);
  const has = parts(appVersion);
  if (!has.length || !has.every((n) => Number.isFinite(n))) return null;
  const need = parts(ALARMS_MIN_APP_VERSION);
  for (let i = 0; i < Math.max(has.length, need.length); i++) {
    const a = has[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** The short label for an alarm, cleaned up. */
export function alarmLabel(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 60) : "";
}
