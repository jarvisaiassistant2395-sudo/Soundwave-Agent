// ── Watching a YouTube channel: clip it as soon as it posts ─────────────────
// "Watch @SomeCreator — cut 3 shorts out of every new video." The PC checks
// the channel every so often, and the moment something new appears the clips
// pipeline (lib/videoClips.ts) cuts it. This file is the thinking part — pure
// TypeScript, no Node APIs: what a channel reference is, how often it's
// checked, which uploads are new, and what the person is told.

/** How many channels can be watched at once. */
export const MAX_WATCHES = 10;
/** How many shorts are cut out of each new video unless the person says otherwise. */
export const DEFAULT_WATCH_CLIPS = 3;
/** The same limits as every other clips run. */
export const MIN_WATCH_CLIPS = 1;
export const MAX_WATCH_CLIPS = 5;
/** How often the channels are checked — "as soon as they post" within a few minutes. */
export const CHECK_INTERVAL_MS = 5 * 60_000;
/** A channel that was just checked isn't checked again before this (be polite to YouTube). */
export const MIN_RECHECK_MS = 4 * 60_000;
/** How many of a channel's newest uploads are looked at each check. */
export const LISTING_LIMIT = 15;
/** How many unseen videos are taken on at once (a channel with 50 unwatched
 *  uploads must not queue 50 renders). */
export const MAX_NEW_PER_CHECK = 3;
/** A queued video is tried this many times before it's given up on (out loud). */
export const MAX_QUEUE_ATTEMPTS = 3;

export interface ChannelRef {
  /** What the person said ("@MrBeast", "youtube.com/@MrBeast"). */
  input: string;
  /** The channel's /videos tab — what yt-dlp lists. */
  tabUrl: string;
  /** The handle or path this resolves from, for the id we store. */
  slug: string;
}

const HANDLE = /^[A-Za-z0-9._-]{3,30}$/;

/**
 * Turns what people actually type into a channel's videos tab:
 * "@MrBeast", "MrBeast", "youtube.com/@MrBeast", a full channel URL, or an
 * old-style /c/ or /user/ link. Null when it isn't a channel at all (a video
 * link belongs to the clips tool, not here).
 */
export function parseChannelInput(raw: string): ChannelRef | null {
  const input = (raw ?? "").trim();
  if (!input || input.length > 300) return null;
  if (/\s/.test(input)) return null; // "make shorts of mr beast" isn't a channel

  // A link (with or without the scheme).
  const link = /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(.+)$/i.exec(input) ?? /^(?:https?:\/\/)?youtu\.be\/.+$/i.exec(input);
  if (link) {
    if (/^youtu\.be\//i.test(input.replace(/^https?:\/\//i, ""))) return null; // a video, not a channel
    const path = (link[1] ?? "").split(/[?#]/)[0]!.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) return null;
    const kind = parts[0]!.toLowerCase();
    if (kind === "watch" || kind === "shorts" || kind === "playlist" || kind === "results") return null;
    // /@handle, /channel/UC…, /c/Name, /user/Name — keep the two parts, add /videos.
    const keep = kind === "channel" || kind === "c" || kind === "user" ? parts.slice(0, 2) : parts.slice(0, 1);
    if (kind === "channel" && !/^UC[A-Za-z0-9_-]{10,}$/.test(parts[1] ?? "")) return null;
    const slug = keep.join("/").toLowerCase();
    return { input, tabUrl: `https://www.youtube.com/${keep.join("/")}/videos`, slug };
  }

  if (input.startsWith("@")) {
    const handle = input.slice(1);
    if (!HANDLE.test(handle)) return null;
    return { input, tabUrl: `https://www.youtube.com/@${handle}/videos`, slug: `@${handle.toLowerCase()}` };
  }
  if (HANDLE.test(input)) {
    return { input, tabUrl: `https://www.youtube.com/@${input}/videos`, slug: `@${input.toLowerCase()}` };
  }
  return null;
}

/** The channel a stored watch points at ("" when it was stored oddly). */
export function watchSlug(watch: { slug?: string; tabUrl?: string }): string {
  if (watch.slug) return watch.slug;
  const ref = watch.tabUrl ? parseChannelInput(watch.tabUrl) : null;
  return ref?.slug ?? "";
}

/** How many clips per new video, inside the limits. */
export function clampWatchClips(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_WATCH_CLIPS;
  return Math.max(MIN_WATCH_CLIPS, Math.min(MAX_WATCH_CLIPS, n));
}

export interface WatchedVideo {
  id: string;
  title: string;
  url: string;
}

export interface WatchPlan {
  /** Videos to clip, oldest first (so a channel's uploads are cut in order). */
  take: WatchedVideo[];
  /** New uploads beyond what's taken on now — they're clipped on later checks. */
  later: number;
}

/**
 * Which of a channel's newest uploads are new to us. The listing comes newest
 * first; anything already seen, queued or clipped is dropped, and at most
 * MAX_NEW_PER_CHECK are taken at once (the rest wait for the next check).
 */
export function planWatch(
  listing: WatchedVideo[],
  known: Iterable<string>,
): WatchPlan {
  const seen = new Set(known);
  const fresh: WatchedVideo[] = [];
  for (const video of listing) {
    if (seen.has(video.id)) continue;
    seen.add(video.id);
    fresh.push(video);
  }
  const take = fresh.slice(0, MAX_NEW_PER_CHECK).reverse();
  return { take, later: Math.max(0, fresh.length - take.length) };
}

/** "2 minutes ago" — for the status the person reads in the chat. */
export function agoLabel(at: number | null, now = Date.now()): string {
  if (!at) return "never checked yet";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return "checked a moment ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `checked ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `checked ${Math.round(hours / 24)} days ago`;
}

export interface WatchStatusInput {
  channelName?: string;
  slug: string;
  clips: number;
  focus?: string;
  queued: number;
  clippedCount: number;
  lastCheckedAt: number | null;
  lastError?: string | null;
}

/** One watch, as the agent reads it out to the person. */
export function watchStatusText(w: WatchStatusInput, now = Date.now()): string {
  const name = w.channelName || w.slug;
  const bits = [
    `Watching ${name}`,
    `${w.clips} short${w.clips === 1 ? "" : "s"} per new video`,
    ...(w.focus ? [`looking for ${w.focus}`] : []),
    agoLabel(w.lastCheckedAt, now),
    ...(w.clippedCount ? [`${w.clippedCount} video${w.clippedCount === 1 ? "" : "s"} clipped so far`] : []),
  ];
  const queued = w.queued > 0 ? ` — ${w.queued} video${w.queued === 1 ? "" : "s"} waiting to be cut` : "";
  const problem = w.lastError ? ` — last check failed: ${w.lastError}` : "";
  return bits.join(", ") + queued + problem;
}

/** What the person hears when a new upload is found. */
export function newUploadText(channelName: string, video: WatchedVideo, clips: number): string {
  return `🔔 ${channelName} posted “${video.title}” — cutting ${clips} short${clips === 1 ? "" : "s"} out of it now. They'll appear in this chat as they're ready.`;
}

/** When a check found more than it took on. */
export function laterText(channelName: string, later: number): string {
  return `${channelName} has ${later} more new video${later === 1 ? "" : "s"} — I'll cut those next time I check.`;
}
