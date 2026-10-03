// ── The publishing plan: what goes on which channel, by itself ──────────────
// Every channel can carry one instruction — "demos of the app every 3 days",
// "space facts daily" — and the planner turns it into real videos: it writes
// the script, narrates it, records the app window when the instruction is a
// demo, renders, and posts to THAT channel, then says so in the conversation.
//
// It only runs while Soundwave AI is on (the PC is the studio), it needs a
// Gemini key so the script is really about the channel's subject, and it never
// runs two videos at once. Anything it can't do, it says plainly in the chat
// and in the channel's own record instead of pretending.

import { getActiveShortJobs, startShortJob } from "../routes/agentShort.js";
import { appendToConversation } from "./conversation.js";
import { chatTime, newMessageId, type ChatMessage } from "./chatMessages.js";
import { activeBrain } from "./brain/settings.js";
import { channelFor, channelViews, listChannels, noteChannelError, notePlanRun, planDue, type ChannelRecord } from "./youtubeChannels.js";

/** How often the running app looks for a plan that's due. */
const CHECK_INTERVAL_MS = 10 * 60_000;
/** Wait this long after boot before the first check (let the app settle). */
const FIRST_CHECK_MS = 90_000;
/** At most one planned video per check — one video renders at a time anyway. */
export const PLAN_ASPECT_DEMO = "16:9" as const;

export interface PlanStatus {
  /** Channels with an active plan. */
  active: Array<{
    channelId: string;
    channelName: string;
    what: string;
    kind: "short" | "demo";
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
    kind: c.plan.kind,
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

/** The video a channel's plan asks for — its own subject, its own kind. */
export function planRequest(channel: ChannelRecord): {
  topic: string;
  promo: boolean;
  selfRecord: boolean;
  aspect: "9:16" | "16:9";
  autoPublishYouTube: boolean;
  youtubeChannelId: string;
} {
  const what = channel.plan.what.trim();
  const demo = channel.plan.kind === "demo";
  return {
    topic: what,
    promo: demo,
    selfRecord: demo,
    aspect: demo ? PLAN_ASPECT_DEMO : "9:16",
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
    const before = getActiveShortJobs().length;
    try {
      const request = planRequest(channel);
      const { jobId } = await startShortJob({ ...request, userId: "agent-local" });
      notePlanRun(channel.id, now.getTime());
      const label = channel.name || "that channel";
      say(
        request.selfRecord
          ? `🎬 Recording a demo for “${label}”: ${request.topic}. I'll film my own window while I work, add the narration, and post it to that channel when it's done.`
          : `🎬 Making the next video for “${label}”: ${request.topic}. It will be posted to that channel when it's done.`,
      );
      out.push({ channelId: channel.id, channelName: label, jobId });
      // One planned video per tick, then let the pipeline breathe.
      void before;
      break;
    } catch (err) {
      const reason = (err as Error).message || "unknown error";
      noteChannelError(channel.id, reason);
      say(`I couldn't start the planned video for “${channel.name}”: ${reason}. I'll try again on the next check.`);
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
export function planSummary(): Array<{ id: string; name: string; auto: boolean; what: string; kind: "short" | "demo"; due: boolean; runs: number; lastRunAt: number | null }> {
  return channelViews().map((c) => ({
    id: c.id,
    name: c.name,
    auto: c.plan.auto,
    what: c.plan.what,
    kind: c.plan.kind,
    due: c.plan.due,
    runs: c.plan.runs,
    lastRunAt: c.plan.lastRunAt,
  }));
}

/** A one-off demo recording (the "Record a demo" button / the agent's tool). */
export async function startDemo(opts: { channelId?: string; what?: string; userId?: string } = {}): Promise<{ jobId: string; channelId: string | null; channelName: string | null }> {
  const channel = opts.channelId ? channelFor(opts.channelId) : (channelFor(null) ?? null);
  const what = (opts.what ?? channel?.plan.what ?? "").trim() || "Show how Soundwave AI makes a short, start to finish, in one press";
  const { jobId } = await startShortJob({
    topic: what,
    promo: true,
    selfRecord: true,
    aspect: PLAN_ASPECT_DEMO,
    autoPublishYouTube: Boolean(channel),
    ...(channel ? { youtubeChannelId: channel.id } : {}),
    userId: opts.userId ?? "agent-local",
  });
  return { jobId, channelId: channel?.id ?? null, channelName: channel?.name ?? null };
}

export function resetPublishPlanForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
