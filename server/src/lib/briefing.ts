// ── The daily morning briefing on the PC ────────────────────────────────────
// When it's due (Settings → Morning Setup: "every morning at 08:00"), the PC
// researches the user's topics with Gemini and writes the briefing before
// anyone asks, then posts it in the conversation marked with its day. The
// phone app and the Command Center speak it the first time they're opened
// after that — once: whoever plays it first marks it heard.
//
// If the PC was off at the due time it catches up when it starts (until 10
// hours after the due time) — unless the phone already made today's briefing
// on its own; that one comes back with the phone's offline messages.
// The automatic briefing never opens websites or apps (the chip does).

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { replyToMessage, type ChatMessage } from "./chatMessages.js";
import { appendToConversation, getConversation } from "./conversation.js";
import { activeBrain } from "./brain/settings.js";
import { briefingPlan, memoryAvailable } from "./memory.js";
import { runMorningSetup } from "./morning.js";
import { BRIEFING_WINDOW_MINUTES, briefingDue, inBriefingWindow as inWindow, localDay } from "./brain/core/morning.js";

export { BRIEFING_WINDOW_MINUTES };

interface BriefingState {
  day: string | null;
  messageId: string | null;
  preparedAt: number | null;
  heardAt: number | null;
  heardOn: "pc" | "phone" | null;
}

const EMPTY: BriefingState = { day: null, messageId: null, preparedAt: null, heardAt: null, heardOn: null };

function fileFor(): string {
  return path.join(config.dataDir, "briefing.json");
}

function loadState(): BriefingState {
  try {
    return { ...EMPTY, ...(JSON.parse(fs.readFileSync(fileFor(), "utf8")) as Partial<BriefingState>) };
  } catch {
    return { ...EMPTY };
  }
}

function saveState(next: BriefingState): void {
  try {
    fs.mkdirSync(path.dirname(fileFor()), { recursive: true });
    fs.writeFileSync(fileFor(), JSON.stringify(next, null, 2), "utf8");
  } catch (err) {
    console.warn(`[briefing] could not save: ${(err as Error).message}`);
  }
}

/** Due today and still within the morning window. */
export function inBriefingWindow(time: string, now = new Date()): boolean {
  return inWindow(time, now);
}

/** Today's briefing in the conversation (made by the PC, the chip, the agent, or the phone). */
export function todaysBriefingMessage(day = localDay(new Date())): ChatMessage | null {
  const msgs = getConversation().messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.sender === "assistant" && m.briefingDate === day) return m;
  }
  return null;
}

let preparing: Promise<ChatMessage | null> | null = null;

/** Why the PC can't write a briefing right now — the phone acts on this. */
export type BriefingRefusal = "no-memory" | "no-key" | "no-topics";

/**
 * Whether the PC could write today's briefing this moment, and if not, which
 * ingredient is missing. The phone asks for a briefing after an alarm: when the
 * PC refuses, the phone has to know *why* — it writes its own briefing instead
 * (and says so), and a run that fails has to name the missing piece rather than
 * "your PC had nothing". Silence was the old behaviour, and it cost a CI run to
 * find out which of the three it was.
 */
export function briefingReadiness(): { ready: boolean; reason: BriefingRefusal | null } {
  if (!memoryAvailable()) return { ready: false, reason: "no-memory" };
  if (!activeBrain()) return { ready: false, reason: "no-key" };
  if (briefingPlan().topics.length === 0) return { ready: false, reason: "no-topics" };
  return { ready: true, reason: null };
}

export function briefingStatus(now = new Date()) {
  const plan = briefingPlan();
  const day = localDay(now);
  const state = loadState();
  const message = todaysBriefingMessage(day);
  const heard = state.day === day && state.heardAt ? { at: state.heardAt, on: state.heardOn } : null;
  return {
    day,
    plan,
    due: plan.auto && briefingDue(plan.time, now),
    inWindow: plan.auto && inBriefingWindow(plan.time, now),
    preparing: Boolean(preparing),
    message,
    heard,
  };
}

/**
 * Researches and writes today's briefing now (or returns the one that's there).
 *
 * This is the *automatic* path (the scheduler, the Command Center opening, the
 * phone). It refuses to run when there is nothing to prepare from — no Gemini
 * key, or no topics — and that refusal is deliberate, not a shortcut:
 *
 *   • Without a key there is no research and no written briefing, only a
 *     placeholder sentence telling the person to add a key.
 *   • Without topics there is nothing to research.
 *
 * Either way the placeholder would *become* "today's briefing", and the
 * existing-briefing check above means the real one could never be written for
 * the rest of the 10-hour window: someone who added their key at 09:30, or
 * their first topic at 10:00, would get no briefing that day. (That is also
 * what made CI dependent on the hour — before 08:00 nothing was prepared, after
 * it the day was consumed before the test could set its topics.)
 *
 * The 🌅 chip and the agent's run_morning_setup tool go through
 * `/api/v1/morning/run`, which is the person asking, so those still work
 * without a key and still say what to do.
 */
export function prepareTodaysBriefing(reason: "schedule" | "phone" | "app"): Promise<ChatMessage | null> {
  const day = localDay(new Date());
  const existing = todaysBriefingMessage(day);
  if (existing) return Promise.resolve(existing);
  const ready = briefingReadiness();
  if (!ready.ready) {
    // Someone asked (the phone, the app) and can't get a briefing: leave the
    // reason in the log. The scheduler is silent — it retries every minute.
    if (reason !== "schedule") console.warn(`[briefing] not writing today's briefing (${reason} asked): ${ready.reason}`);
    return Promise.resolve(null);
  }
  if (preparing) return preparing;
  preparing = (async () => {
    try {
      const reply = await runMorningSetup({ via: "pc", open: false });
      const msg: ChatMessage = { ...replyToMessage(reply, "Morning briefing"), briefingDate: day };
      appendToConversation(msg);
      saveState({ day, messageId: msg.id, preparedAt: Date.now(), heardAt: null, heardOn: null });
      console.log(`[briefing] today's briefing is ready (${reason})`);
      return msg;
    } catch (err) {
      console.warn(`[briefing] couldn't prepare today's briefing: ${(err as Error).message}`);
      return null;
    } finally {
      preparing = null;
    }
  })();
  return preparing;
}

/** Played on the PC or the phone (or made by the phone itself): don't speak it again elsewhere. */
export function markBriefingHeard(day: string, on: "pc" | "phone"): void {
  const state = loadState();
  if (state.day === day && state.heardAt) return;
  const message = todaysBriefingMessage(day);
  saveState({ day, messageId: message?.id ?? state.messageId, preparedAt: state.day === day ? state.preparedAt : null, heardAt: Date.now(), heardOn: on });
}

/** Desktop app: prepare the briefing when it's due (checked every minute, and soon after start). */
export function initBriefingScheduler(): () => void {
  if (!memoryAvailable()) return () => undefined;
  const tick = () => {
    const plan = briefingPlan();
    const now = new Date();
    if (!plan.auto || !inBriefingWindow(plan.time, now) || todaysBriefingMessage(localDay(now)) || preparing) return;
    void prepareTodaysBriefing("schedule");
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  const first = setTimeout(tick, 15_000);
  first.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}

/** Tests: forget the state. */
export function resetBriefingForTests(): void {
  preparing = null;
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}
