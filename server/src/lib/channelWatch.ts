// Watching YouTube channels: "@MrBeast posts → clip it". The pure rules —
// what a channel reference is, what's new, how often things are checked — live
// in brain/core/watch.ts; this file is the store, the timer and the wiring into
// the clips pipeline (lib/videoClips.ts).
//
// The check runs while Soundwave AI is on (every CHECK_INTERVAL_MS, and once
// shortly after start — a video posted while the PC was off is caught then,
// because "seen" is what matters, not when we looked). Clipping one video is
// still one-at-a-time with normal shorts: a busy renderer just means the
// queued video waits for the next tick, and is announced when it really starts.

import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { appendToConversation } from "./conversation.js";
import { chatTime, newMessageId } from "./chatMessages.js";
import { listChannelVideos, type YtChannelVideo } from "./ytdlp.js";
import { clipsBusy, startClipsJob } from "./videoClips.js";
import {
  CHECK_INTERVAL_MS,
  DEFAULT_WATCH_CLIPS,
  LISTING_LIMIT,
  MAX_QUEUE_ATTEMPTS,
  MAX_WATCHES,
  MIN_RECHECK_MS,
  clampWatchClips,
  laterText,
  newUploadText,
  parseChannelInput,
  planWatch,
  watchStatusText,
  watchSlug,
  type WatchedVideo,
} from "./brain/core/watch.js";

export interface QueuedVideo {
  id: string;
  title: string;
  url: string;
  /** A check found it — announce when the render really starts. */
  announce: boolean;
  attempts: number;
}

export interface ChannelWatch {
  id: string;
  /** What the person said, and the resolved channel. */
  input: string;
  slug: string;
  tabUrl: string;
  channelId?: string;
  channelName?: string;
  clips: number;
  focus?: string;
  resolution?: "720p" | "1080p";
  userId?: string;
  /** Videos already clipped or given up on (so a restart doesn't redo them). */
  seen: string[];
  queue: QueuedVideo[];
  clipped: Array<{ id: string; title: string; at: number }>;
  addedAt: number;
  lastCheckedAt: number | null;
  lastError: string | null;
  /** The seeding video when a watch is added: never re-clipped, only remembered. */
  seededAt?: number;
}

interface WatchState {
  watches: ChannelWatch[];
}

function fileFor(): string {
  return path.join(config.dataDir, "channel-watches.json");
}

function load(): WatchState {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as Partial<WatchState>;
    return { watches: Array.isArray(raw.watches) ? raw.watches.filter((w) => w && typeof w.id === "string") : [] };
  } catch {
    return { watches: [] };
  }
}

function save(state: WatchState): void {
  try {
    fs.mkdirSync(path.dirname(fileFor()), { recursive: true });
    fs.writeFileSync(fileFor(), JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn(`[watch] could not save: ${(err as Error).message}`);
  }
}

/** The video ids already handled (or no longer to be handled). */
function knownIds(watch: ChannelWatch): string[] {
  return [...watch.seen, ...watch.queue.map((q) => q.id)];
}

export function listWatches(): ChannelWatch[] {
  return load().watches;
}

export function watchStatuses(now = Date.now()): string[] {
  return listWatches().map((w) =>
    watchStatusText(
      {
        ...(w.channelName !== undefined ? { channelName: w.channelName } : {}),
        slug: watchSlug(w),
        clips: w.clips,
        ...(w.focus !== undefined ? { focus: w.focus } : {}),
        queued: w.queue.length,
        clippedCount: w.clipped.length,
        lastCheckedAt: w.lastCheckedAt,
        lastError: w.lastError,
      },
      now,
    ),
  );
}

const say = (text: string): void => {
  const at = Date.now();
  appendToConversation({ id: newMessageId(at), sender: "assistant", text, time: chatTime(new Date(at)), at, tag: "SYS" });
};

export interface AddWatchOptions {
  channel: string;
  clips?: number;
  focus?: string;
  resolution?: "720p" | "1080p";
  /** Also clip the newest video that's already up (off by default: only new uploads). */
  latest?: boolean;
  userId?: string;
}

/** Starts watching a channel. Throws with something the person can act on. */
export async function addWatch(opts: AddWatchOptions): Promise<ChannelWatch> {
  const ref = parseChannelInput(opts.channel ?? "");
  if (!ref) {
    throw new Error(
      "That isn't a channel I can watch — give me the channel's link or its @handle, e.g. \"@MrBeast\" or \"youtube.com/@MrBeast\".",
    );
  }
  const state = load();
  const existing = state.watches.find((w) => watchSlug(w) === ref.slug);
  if (existing) {
    // Asking again updates what it does, it doesn't add a second watch.
    existing.clips = clampWatchClips(opts.clips ?? existing.clips);
    if (opts.focus !== undefined) existing.focus = opts.focus.slice(0, 300) || undefined;
    if (opts.resolution) existing.resolution = opts.resolution;
    if (opts.latest) existing.lastCheckedAt = null; // check it right away
    save(state);
    return existing;
  }
  if (state.watches.length >= MAX_WATCHES) {
    throw new Error(`I'm already watching ${state.watches.length} channels — that's my limit. Ask me to stop watching one first.`);
  }

  // Resolve it for real now: the name is used in everything the person reads,
  // and a typo must be answered here, not fifteen minutes later.
  const listing = await listChannelVideos(ref.tabUrl, { limit: LISTING_LIMIT }).catch((err) => {
    throw new Error(`I couldn't read that channel (${(err as Error).message}). Double-check the link or the @handle.`);
  });
  const videos = listing.videos ?? [];
  if (!videos.length && !listing.channelName) {
    throw new Error("That channel has no videos I can see — check the link, or that it isn't an empty or members-only channel.");
  }

  const now = Date.now();
  // Everything that's already up is "seen": a new watch clips new uploads,
  // unless the person asked for the newest one as well.
  const newest = videos[0];
  const seen = videos.map((v) => v.id);
  const queue: QueuedVideo[] = [];
  if (opts.latest && newest) {
    queue.push({ id: newest.id, title: newest.title, url: newest.url, announce: false, attempts: 0 });
    seen.splice(seen.indexOf(newest.id), 1);
  }
  const watch: ChannelWatch = {
    id: `w_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    input: ref.input,
    slug: ref.slug,
    tabUrl: ref.tabUrl,
    ...(listing.channelId ? { channelId: listing.channelId } : {}),
    ...(listing.channelName ? { channelName: listing.channelName } : {}),
    clips: clampWatchClips(opts.clips),
    ...(opts.focus?.trim() ? { focus: opts.focus.trim().slice(0, 300) } : {}),
    ...(opts.resolution ? { resolution: opts.resolution } : {}),
    ...(opts.userId ? { userId: opts.userId } : {}),
    seen,
    queue,
    clipped: [],
    addedAt: now,
    lastCheckedAt: now,
    lastError: null,
  };
  state.watches.push(watch);
  save(state);
  return watch;
}

/** Stops watching one channel ("@MrBeast"), or all of them ("all"). */
export function removeWatch(channel: string): { removed: string[] } {
  const wanted = (channel ?? "").trim();
  const state = load();
  if (/^(all|every(channel)?|everything)$/i.test(wanted)) {
    const names = state.watches.map((w) => w.channelName || watchSlug(w));
    state.watches = [];
    save(state);
    return { removed: names };
  }
  const ref = parseChannelInput(wanted);
  const slug = ref?.slug ?? watchSlug({ tabUrl: wanted });
  const hit = state.watches.find((w) => watchSlug(w) === slug || (w.channelName ?? "").toLowerCase() === wanted.toLowerCase());
  if (!hit) return { removed: [] };
  const name = hit.channelName || watchSlug(hit);
  state.watches = state.watches.filter((w) => w.id !== hit.id);
  save(state);
  return { removed: [name] };
}

/** Turns a listing entry into what the queue holds. */
const asWatched = (v: YtChannelVideo): WatchedVideo => ({ id: v.id, title: v.title, url: v.url });

/** One look at one channel: is there something new? */
async function checkWatch(watch: ChannelWatch): Promise<void> {
  const listing = await listChannelVideos(watch.tabUrl, { limit: LISTING_LIMIT });
  if (listing.channelName && listing.channelName !== watch.channelName) watch.channelName = listing.channelName;
  if (listing.channelId && listing.channelId !== watch.channelId) watch.channelId = listing.channelId;

  const plan = planWatch((listing.videos ?? []).map(asWatched), knownIds(watch));
  for (const video of plan.take) {
    watch.queue.push({ id: video.id, title: video.title, url: video.url, announce: true, attempts: 0 });
  }
  if (plan.later > 0) say(laterText(watch.channelName || watchSlug(watch), plan.later));
}

/** Clips the next queued video, if the machine is free. */
async function processQueue(watch: ChannelWatch): Promise<void> {
  const next = watch.queue[0];
  if (!next) return;
  if (clipsBusy().busy) return; // the next tick picks it up

  if (next.announce) {
    say(newUploadText(watch.channelName || watchSlug(watch), { id: next.id, title: next.title, url: next.url }, watch.clips));
  }
  watch.queue.shift();
  try {
    await startClipsJob({
      video: next.url,
      count: watch.clips,
      ...(watch.focus ? { focus: watch.focus } : {}),
      ...(watch.resolution ? { resolution: watch.resolution } : {}),
      ...(watch.userId ? { userId: watch.userId } : {}),
    });
    watch.clipped = [...watch.clipped, { id: next.id, title: next.title, at: Date.now() }].slice(-50);
    watch.seen = [...watch.seen, next.id].slice(-200);
  } catch (err) {
    const message = (err as Error).message || "unknown error";
    next.attempts += 1;
    if (next.attempts >= MAX_QUEUE_ATTEMPTS) {
      watch.seen = [...watch.seen, next.id].slice(-200);
      say(`🔔 I couldn't cut “${next.title}”: ${message} — I'll leave that one alone.`);
    } else {
      // Put it back at the front: busy renderers and lost connections are temporary.
      watch.queue.unshift(next);
      watch.lastError = message;
    }
  }
}

let running = false;

/** One full pass over every watch. Exported for the tests. */
export async function tickWatches(now = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  const state = load();
  try {
    for (const watch of state.watches) {
      const due = !watch.lastCheckedAt || now - watch.lastCheckedAt >= MIN_RECHECK_MS;
      if (due) {
        try {
          await checkWatch(watch);
          watch.lastCheckedAt = Date.now();
          watch.lastError = null;
        } catch (err) {
          watch.lastCheckedAt = Date.now();
          watch.lastError = (err as Error).message.slice(0, 200);
        }
      }
      await processQueue(watch);
    }
  } finally {
    save(state);
    running = false;
  }
}

/** Desktop app: check the watched channels while Soundwave AI runs. */
export function initChannelWatch(): () => void {
  if (!listWatches().length) {
    // Nothing watched yet — but a watch can be added at any time, so the timer
    // is still worth having: it starts checking as soon as one exists.
  }
  const timer = setInterval(() => {
    if (clipsBusy().busy) return;
    void tickWatches().catch((err) => console.warn("[watch] tick failed:", (err as Error).message));
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  const first = setTimeout(() => {
    void tickWatches().catch((err) => console.warn("[watch] first check failed:", (err as Error).message));
  }, 20_000);
  first.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}

/** Runs the checks now instead of waiting for the timer (the tool uses this). */
export function kickChannelWatch(): void {
  void tickWatches().catch((err) => console.warn("[watch] check failed:", (err as Error).message));
}

/** Tests: forget everything (the data dir is wiped between tests). */
export function resetChannelWatchForTests(): void {
  running = false;
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}

export { watchStatusText };
