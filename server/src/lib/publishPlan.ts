// ── Scheduled publishing of user-created Shorts ─────────────────────────────
// A channel can carry one instruction — "space facts daily", for example.
// While Soundwave is running, the planner writes a regular vertical Short,
// renders it, and posts it to that channel.

import { getActiveShortJobs, startShortJob } from "../routes/agentShort.js";
import { appendToConversation } from "./conversation.js";
import { chatTime, newMessageId, type ChatMessage } from "./chatMessages.js";
import { activeBrain } from "./brain/settings.js";
import { channelViews, listChannels, noteChannelError, notePlanRun, planDue, type ChannelRecord } from "./youtubeChannels.js";

/** How often the running app looks for a plan that's due. */
const CHECK_INTERVAL_MS = 10 * 60_000;
/** Wait this long after boot before the first check (let the app settle). */
const FIRST_CHECK_MS = 90_000;

export interface PlanStatus {
  /** Channels with an active plan. */
  active: Array<{
    channelId: string;
    channelName: string;
    what: string;
    everyDays: number;
    time: string;
    due: boolean;
    lastRunAt: string | null;
    runs: number;
    lastError: string | null;
  }>;
  /** Why nothing would run right now, when that's the case. */
  blocked: string | null;
}

export function planStatus(now = new Date()): PlanStatus {
  const channels = listChannels().filter((c) => c.plan.auto && c.plan.what.trim());
  const active = channels.map((c) => ({
    channelId: c.id,
    channelName: c.name,
    what: c.plan.what,
    everyDays: c.plan.everyDays,
    time: c.plan.time,
    due: planDue(c.plan, now),
    lastRunAt: c.plan.lastRunAt ? new Date(c.plan.lastRunAt).toISOString() : null,
    runs: c.plan.runs,
    lastError: c.plan.lastError,
  }));
  let blocked: string | null = null;
  if (!active.length) blocked = "No channel has a plan yet (Settings → YouTube & Shorts).";
  else if (!active.some((a) => a.due)) blocked = "Nothing is due yet.";
  else if (!activeBrain()) blocked = "A plan needs a Gemini API key (Settings → Brain) so the script is really about that channel.";
  return { active, blocked };
}

/** The regular Short a channel's plan asks for. */
export function planRequest(channel: ChannelRecord): {
  topic: string;
  autoPublishYouTube: true;
  youtubeChannelId: string;
} {
  return {
    topic: channel.plan.what.trim(),
    autoPublishYouTube: true,
    youtubeChannelId: channel.id,
  };
}

function say(text: string): void {
  const message: ChatMessage = {
    id: newMessageId(Date.now()),
    sender: "assistant",
    text,
    time: chatTime(new Date()),
    at: Date.now(),
  };
  appendToConversation(message);
}

/** Runs the plans that are due right now. Returns what it started. */
export async function runDuePlans(now = new Date()): Promise<Array<{ channelId: string; channelName: string; jobId: string | null; skipped?: string }>> {
  if (!activeBrain()) return [];
  if (getActiveShortJobs().length) return [];
  const out: Array<{ channelId: string; channelName: string; jobId: string | null; skipped?: string }> = [];
  for (const channel of listChannels()) {
    if (!planDue(channel.plan, now)) continue;
    try {
      const request = planRequest(channel);
      const { jobId } = await startShortJob({ ...request, userId: "agent-local" });
      notePlanRun(channel.id, now.getTime());
      const label = channel.name || "that channel";
      say(`🎬 Making the next Short for “${label}”: ${request.topic}. It will be posted to that channel when it's done.`);
      out.push({ channelId: channel.id, channelName: label, jobId });
      // One planned video per tick, then let the pipeline breathe.
      break;
    } catch (err) {
      const reason = (err as Error).message || "unknown error";
      noteChannelError(channel.id, reason);
      say(`I couldn't start the planned Short for “${channel.name}”: ${reason}. I'll try again on the next check.`);
      out.push({ channelId: channel.id, channelName: channel.name, jobId: null, skipped: reason });
    }
  }
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Desktop app: look for a plan that's due while Soundwave AI runs. */
export function initPublishPlan(): () => void {
  if (timer) return () => undefined;
  const tick = (reason: "startup" | "schedule") => {
    void runDuePlans()
      .then((started) => {
        for (const s of started) console.log(`[plan] ${reason}: ${s.channelName} → ${s.jobId ?? `skipped (${s.skipped})`}`);
      })
      .catch((err) => console.warn(`[plan] check failed: ${(err as Error).message}`));
  };
  timer = setInterval(() => tick("schedule"), CHECK_INTERVAL_MS);
  timer.unref?.();
  const first = setTimeout(() => tick("startup"), FIRST_CHECK_MS);
  first.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    clearTimeout(first);
  };
}

/** Tests / settings page: which channels are configured and what they'd publish. */
export function planSummary(): Array<{ id: string; name: string; auto: boolean; what: string; due: boolean; runs: number; lastRunAt: number | null }> {
  return channelViews().map((c) => ({
    id: c.id,
    name: c.name,
    auto: c.plan.auto,
    what: c.plan.what,
    due: c.plan.due,
    runs: c.plan.runs,
    lastRunAt: c.plan.lastRunAt,
  }));
}

export function resetPublishPlanForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
