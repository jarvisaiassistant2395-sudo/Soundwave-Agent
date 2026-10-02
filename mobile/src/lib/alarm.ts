// ── Alarms on this phone, set by the agent ─────────────────────────────────
// The agent (on the PC, or on the phone itself with the PC off) can set an
// alarm here: the phone rings with its own alarm screen — Snooze / Turn off —
// and when the user turns it off the morning briefing starts by itself after
// the seconds they chose (Settings → "Alarm & the briefing", default 30).
//
// The heavy lifting is native (android/…/AlarmPlugin.java + AlarmService), so
// the alarm fires with the app closed and the PC off. In a desktop browser
// there's no plugin: available() is false and everything says so honestly.

import { Capacitor, registerPlugin, type Plugin } from "@capacitor/core";
import {
  alarmLabel,
  briefingAfterSeconds,
  clockLabel,
  DEFAULT_BRIEFING_AFTER_ALARM_SECONDS,
  MAX_BRIEFING_AFTER_ALARM_SECONDS,
} from "../../../server/src/lib/brain/core/alarm";

export interface PhoneAlarm {
  id: string;
  /** When it rings, ms since epoch. */
  at: number;
  label: string;
  /** Seconds after the alarm is turned off before the morning briefing starts. */
  briefingAfterSeconds: number;
}

interface AlarmPlugin extends Plugin {
  schedule(opts: { at: number; label?: string; briefingAfterSeconds?: number }): Promise<PhoneAlarm>;
  cancel(opts: { id: string }): Promise<{ cancelled: boolean }>;
  list(): Promise<{ alarms: PhoneAlarm[] }>;
  getBriefingDelay(): Promise<{ seconds: number }>;
  setBriefingDelay(opts: { seconds: number }): Promise<{ seconds: number }>;
  /** True (once) when an alarm was turned off and the briefing is due. */
  consumePendingBriefing(): Promise<{ due: boolean; at?: number }>;
  notificationsAllowed(): Promise<{ allowed: boolean }>;
  requestNotifications(): Promise<{ allowed: boolean }>;
}

const Alarm = registerPlugin<AlarmPlugin>("Alarm");

export function alarmAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Alarm");
}

/** What an alarm the agent asked for should be (the tool's args, one alarm). */
export interface AlarmRequest {
  at: number;
  label?: string;
  briefingAfterSeconds?: number;
}

export interface AlarmRun {
  /** The alarm now set on the phone, when it worked. */
  alarm?: PhoneAlarm;
  /** Something to say in the chat when it didn't. */
  problem?: string;
  /** What the phone answered (the tool's result). */
  result: Record<string, unknown>;
}

/** How stale an alarm request may be before setting it would be wrong (the PC was away). */
export const ALARM_TOO_OLD_MS = 60_000;

/** Sets the alarm on this phone, or says why not (never pretends). */
export async function setAlarmNow(request: AlarmRequest, now = new Date()): Promise<AlarmRun> {
  if (!Number.isFinite(request.at)) {
    return { result: { set: false, reason: "No alarm time." }, problem: "I need a time for that alarm." };
  }
  if (request.at < now.getTime() - ALARM_TOO_OLD_MS) {
    return {
      result: { set: false, reason: "The alarm time has passed.", wasFor: clockLabel(request.at) },
      problem: `That alarm was for ${clockLabel(request.at)} — it has already passed (the phone wasn't reachable then). Ask me again.`,
    };
  }
  if (!alarmAvailable()) {
    return { result: { set: false, reason: "Alarms need the Soundwave app on the phone." }, problem: "Only the phone app can set an alarm here." };
  }
  const label = alarmLabel(request.label);
  const seconds = briefingAfterSeconds(request.briefingAfterSeconds, await getBriefingDelay());
  const alarm = await Alarm.schedule({ at: request.at, ...(label ? { label } : {}), briefingAfterSeconds: seconds });
  return {
    result: {
      set: true,
      ringsAt: clockLabel(alarm.at),
      label: alarm.label || undefined,
      briefingAfterSeconds: alarm.briefingAfterSeconds,
      note: `The alarm is on the phone. When it's turned off the morning briefing starts ${alarm.briefingAfterSeconds === 0 ? "right away" : `${alarm.briefingAfterSeconds} seconds later`}.`,
    },
    alarm,
  };
}

export async function listAlarms(): Promise<PhoneAlarm[]> {
  if (!alarmAvailable()) return [];
  try {
    return (await Alarm.list()).alarms ?? [];
  } catch {
    return [];
  }
}

export async function cancelAlarm(id: string): Promise<boolean> {
  if (!alarmAvailable()) return false;
  try {
    return (await Alarm.cancel({ id })).cancelled;
  } catch {
    return false;
  }
}

/** The seconds the briefing waits after an alarm is turned off (once set by the user). */
export async function getBriefingDelay(): Promise<number> {
  if (!alarmAvailable()) return DEFAULT_BRIEFING_AFTER_ALARM_SECONDS;
  try {
    return briefingAfterSeconds((await Alarm.getBriefingDelay()).seconds, DEFAULT_BRIEFING_AFTER_ALARM_SECONDS);
  } catch {
    return DEFAULT_BRIEFING_AFTER_ALARM_SECONDS;
  }
}

export async function setBriefingDelay(seconds: number): Promise<number> {
  const clamped = Math.min(MAX_BRIEFING_AFTER_ALARM_SECONDS, Math.max(0, Math.round(seconds)));
  if (!alarmAvailable()) return clamped;
  try {
    return (await Alarm.setBriefingDelay({ seconds: clamped })).seconds;
  } catch {
    return clamped;
  }
}

/** An alarm was turned off and the briefing is due (checked when the app opens). */
export async function consumePendingBriefing(): Promise<boolean> {
  if (!alarmAvailable()) return false;
  try {
    return (await Alarm.consumePendingBriefing()).due;
  } catch {
    return false;
  }
}

export async function notificationsAllowed(): Promise<boolean> {
  if (!alarmAvailable()) return true;
  try {
    return (await Alarm.notificationsAllowed()).allowed;
  } catch {
    return true;
  }
}

export async function requestNotifications(): Promise<boolean> {
  if (!alarmAvailable()) return false;
  try {
    return (await Alarm.requestNotifications()).allowed;
  } catch {
    return false;
  }
}

/** The alarm rang and was turned off: the briefing should start now. */
export function onBriefingDue(handler: () => void): () => void {
  if (!alarmAvailable()) return () => undefined;
  const sub = Alarm.addListener("briefingDue", () => handler());
  return () => void sub.then((s) => s.remove());
}
