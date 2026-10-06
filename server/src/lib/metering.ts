// ── What a plan actually buys ────────────────────────────────────────────────
// A creator does not know how many characters they type — they know how much
// video they ran through the app, and how many clips came out. So those are the
// two things this counts per calendar month, per account:
//
//   • minutes of video processed — the source length for a "clip this video"
//     run, the finished length for a script-to-short run;
//   • clips produced — one per clip the app cuts and finishes.
//
// The character limit still exists, but as the fair-use guard it always was:
// it stops one account from being a whole agency on someone else's bill, it is
// not the thing on the pricing page. Characters are counted where they always
// were (routes/tts.ts), and the reset date is shared: one month boundary for
// everything.
//
// Free's clips expire (the same shape as the category: 60 minutes a month, a
// watermark, clips that go away after a week) — see pruneExpired().

import { getStore } from "./store.js";
import { effectivePlan, personalEdition } from "./edition.js";
import { PLANS, type Plan } from "./plans.js";
import { removeJobVideoFile } from "./jobFiles.js";

export interface MeterLine {
  used: number;
  /** null = no ceiling (Pro and above on clips). */
  limit: number | null;
  allowed: boolean;
}

export interface MeterSnapshot {
  plan: Plan;
  monthlyPrice: number;
  /** Minutes of video processed this month. */
  videoMinutes: MeterLine;
  /** Clips made this month. */
  clips: MeterLine;
  /** The internal fair-use guard, not the thing being sold. */
  characters: { used: number; limit: number; allowed: boolean };
  /** When all of the above starts again. */
  resetDate: string;
  /** Free exports carry Soundwave's mark. */
  watermark: boolean;
  /** Days a finished clip is kept, or null = kept. */
  retentionDays: number | null;
}

function nextReset(from = new Date()): Date {
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, 0, 0, 0, 0);
}

export function minutesOf(seconds: number): number {
  return Math.round((Math.max(0, seconds) / 60) * 10) / 10;
}

/**
 * Roll the monthly counters over when the boundary has passed. One date governs
 * all three counters, so nothing can drift into "characters reset but minutes
 * didn't".
 */
export async function rollMonthOver(userId: string, resetDate: string): Promise<void> {
  if (new Date() < new Date(resetDate)) return;
  const store = await getStore();
  await store.updateUser(userId, {
    charactersUsedThisMonth: 0,
    videoSecondsUsedThisMonth: 0,
    clipsUsedThisMonth: 0,
    characterResetDate: nextReset().toISOString(),
  } as never);
}

export async function meterFor(userId: string): Promise<MeterSnapshot> {
  const store = await getStore();
  const user = await store.findUserById(userId);
  if (!user) throw new Error("User not found.");
  await rollMonthOver(userId, user.characterResetDate);
  const fresh = (await store.findUserById(userId)) ?? user;

  const plan = effectivePlan(fresh.plan);
  const def = PLANS[plan];
  const usedMinutes = minutesOf(fresh.videoSecondsUsedThisMonth ?? 0);
  const usedClips = fresh.clipsUsedThisMonth ?? 0;
  return {
    plan,
    monthlyPrice: def.monthlyPrice,
    videoMinutes: {
      used: usedMinutes,
      limit: def.videoMinutesPerMonth,
      allowed: usedMinutes < def.videoMinutesPerMonth,
    },
    clips: {
      used: usedClips,
      limit: def.clipsPerMonth,
      allowed: def.clipsPerMonth === null || usedClips < def.clipsPerMonth,
    },
    characters: {
      used: fresh.charactersUsedThisMonth,
      limit: def.characterLimit,
      allowed: fresh.charactersUsedThisMonth < def.characterLimit,
    },
    resetDate: new Date(fresh.characterResetDate) >= new Date() ? fresh.characterResetDate : nextReset().toISOString(),
    watermark: def.watermark,
    retentionDays: def.clipRetentionDays,
  };
}

/**
 * Refuse work that the month's allowance can't cover, before it starts: a clip
 * run that renders for six minutes and *then* says "you're out" is worse than
 * one that never starts, and both cost the person the same.
 */
export async function requireRoom(userId: string, want: { videoSeconds?: number; clips?: number }): Promise<MeterSnapshot> {
  const meter = await meterFor(userId).catch(() => null);
  // "local-user"/"agent-local" (and anything before sign-in) has no account to
  // meter: the app's own work is not something to bill or block.
  if (!meter) return unmetered();
  const minutes = minutesOf(want.videoSeconds ?? 0);
  const clips = Math.max(0, want.clips ?? 0);
  const line = (label: string, used: number, limit: number | null, adding: number) =>
    `${label}: ${Math.round((used + adding) * 10) / 10} of ${limit} used this month`;

  if (minutes > 0 && meter.videoMinutes.used + minutes > (meter.videoMinutes.limit ?? Infinity)) {
    throw planLimit(
      `That video is longer than what's left this month (${line("video processed", meter.videoMinutes.used, meter.videoMinutes.limit, minutes)}). ` +
        `${PLANS[meter.plan].name} resets on ${new Date(meter.resetDate).toLocaleDateString()}, or upgrade for more minutes.`,
    );
  }
  if (clips > 0 && meter.clips.limit !== null && meter.clips.used + clips > meter.clips.limit) {
    throw planLimit(
      `${line("clips", meter.clips.used, meter.clips.limit, clips)}. ` +
        `Clips made from now on will work again on ${new Date(meter.resetDate).toLocaleDateString()}, or upgrade for unlimited clips.`,
    );
  }
  return meter;
}

/** An upgrade is a checkout away, so this is not an error — it is an offer. */
export function planLimit(message: string): Error & { code: string; status: number } {
  const err = new Error(message) as Error & { code: string; status: number };
  err.code = "PLAN_LIMIT";
  err.status = 402;
  return err;
}

/** Count it once it actually happened. */
export async function recordUsage(userId: string, usage: { videoSeconds?: number; clips?: number }): Promise<void> {
  const seconds = Math.max(0, Math.round(usage.videoSeconds ?? 0));
  const clips = Math.max(0, Math.round(usage.clips ?? 0));
  if (!seconds && !clips) return;
  const store = await getStore();
  const user = await store.findUserById(userId).catch(() => null);
  if (!user) return;
  await rollMonthOver(userId, user.characterResetDate);
  const fresh = (await store.findUserById(userId)) ?? user;
  await store.updateUser(userId, {
    videoSecondsUsedThisMonth: (fresh.videoSecondsUsedThisMonth ?? 0) + seconds,
    clipsUsedThisMonth: (fresh.clipsUsedThisMonth ?? 0) + clips,
  } as never);
}

/** What "no plan limits apply" looks like — the local agent, the owner's PC. */
export function unmetered(): MeterSnapshot {
  const def = PLANS[effectivePlan("ENTERPRISE")];
  return {
    plan: "ENTERPRISE",
    monthlyPrice: def.monthlyPrice,
    videoMinutes: { used: 0, limit: def.videoMinutesPerMonth, allowed: true },
    clips: { used: 0, limit: null, allowed: true },
    characters: { used: 0, limit: def.characterLimit, allowed: true },
    resetDate: nextReset().toISOString(),
    watermark: false,
    retentionDays: null,
  };
}

/** The plan in force for an account, or null when there is no account to ask. */
export async function planForUser(userId: string): Promise<Plan | null> {
  const store = await getStore();
  const user = await store.findUserById(userId).catch(() => null);
  return user ? effectivePlan(user.plan) : null;
}

/**
 * True when this account's exports should carry Soundwave's mark. The app's own
 * work on this PC (no account yet, or the local agent) never carries it — that
 * is the owner's own machine, and marking their own footage would be absurd.
 */
export async function watermarkFor(userId: string): Promise<boolean> {
  const plan = await planForUser(userId);
  return plan ? PLANS[plan].watermark : false;
}

// ── Clips that expire ───────────────────────────────────────────────────────
// Free clips go away after a week. Deleting is the point (that is the offer:
// render it properly, or it's gone), but it must be quiet and idempotent —
// a missing file was already deleted.

const KEEP_FOREVER = null;

/** The epoch before which a finished clip of this plan should be gone. */
export function retentionCutoff(plan: Plan, now = Date.now()): number | null {
  const days = PLANS[plan].clipRetentionDays;
  if (days === KEEP_FOREVER) return null;
  return now - days * 24 * 60 * 60 * 1000;
}

export interface PrunedClips {
  deleted: number;
  kept: number;
  /** What was removed, for the log — "clip 3 of a video from Tuesday". */
  names: string[];
}

/**
 * Settle the library for one account: jobs older than their plan's retention
 * lose their file and their output URL, but keep their row — the library is
 * also the record of what the agent made, and a hole in it would read as a bug.
 */
export async function pruneExpiredClips(userId: string, now = Date.now()): Promise<PrunedClips> {
  const result: PrunedClips = { deleted: 0, kept: 0, names: [] };
  const store = await getStore();
  // No account = clips made by the app itself on this PC (or before sign-in).
  // Expiry deletes files, so it only ever touches a real, signed-in account.
  const plan = await planForUser(userId);
  if (!plan && !personalEdition) return result;
  const cutoff = retentionCutoff(plan ?? "FREE", now);
  if (cutoff === null) return result;
  const jobs = await store.listJobs(userId).catch(() => []);
  for (const job of jobs) {
    const settings = (job.settings ?? {}) as { topic?: unknown };
    if (typeof settings.topic !== "string") continue; // not a clip
    const at = Date.parse(job.completedAt ?? job.createdAt);
    if (!Number.isFinite(at) || at >= cutoff) {
      result.kept += 1;
      continue;
    }
    if (job.outputUrl || job.status === "COMPLETED") {
      try {
        removeJobVideoFile(job);
      } catch {
        /* the file is already gone, or the job never wrote one */
      }
      await store
        .updateJob(job.id, { outputUrl: null, settings: { ...(job.settings as object), expired: true } as never })
        .catch(() => undefined);
    }
    result.deleted += 1;
    result.names.push(settings.topic);
  }
  return result;
}

/**
 * Sweep every account that has clips worth expiring — called at startup and
 * daily. A single-user desktop install with a Pro plan does one store read and
 * stops; nobody pays for a timer.
 */
export async function pruneAllExpired(): Promise<PrunedClips> {
  const store = await getStore();
  const total: PrunedClips = { deleted: 0, kept: 0, names: [] };
  const users = await store.listUsers().catch(() => []);
  const ids = [...new Set([...users.map((u) => u.id), "agent-local", "local-user"])];
  for (const id of ids) {
    const one = await pruneExpiredClips(id).catch(() => null);
    if (!one) continue;
    total.deleted += one.deleted;
    total.kept += one.kept;
    total.names.push(...one.names);
  }
  return total;
}

const DAY_MS = 24 * 60 * 60 * 1000;
let sweepTimer: NodeJS.Timeout | null = null;

/** Start the daily sweep. Safe to call twice. */
export function initMetering(): void {
  if (sweepTimer) return;
  const run = async () => {
    try {
      const pruned = await pruneAllExpired();
      if (pruned.deleted) console.log(`[metering] expired ${pruned.deleted} clip(s) past their plan's retention.`);
    } catch (err) {
      console.warn("[metering] the expiry sweep failed:", (err as Error).message);
    }
  };
  void run();
  sweepTimer = setInterval(() => void run(), DAY_MS);
  sweepTimer.unref?.();
}

export function resetMeteringForTests(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
