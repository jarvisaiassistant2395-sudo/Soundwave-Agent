// ── Shorts that post themselves, and what happened afterwards ───────────────
// A finished clip can be given a time — "tomorrow at 9" — and Soundwave posts it
// to the chosen channel then. The promise is the same one the email scheduler
// makes: written now, sent later by itself, cancellable, and honest when the PC
// was off at the moment it was due.
//
// Then the second half, which no clipper can do: once a clip is up, its numbers
// are read back from YouTube and kept next to the clip. That is what makes the
// next selection better — the audience's own results, on this person's channel,
// rather than somebody else's idea of "viral".

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { appendToConversation } from "./conversation.js";
import { chatTime, newMessageId } from "./chatMessages.js";
import { accessTokenFor, channelFor, defaultChannelId, listChannels, noteChannelError, noteChannelUpload } from "./youtubeChannels.js";
import { parseWhen } from "./brain/core/reminders.js";
import { youtubeService } from "./youtube.js";

export type PostStatus = "scheduled" | "posting" | "posted" | "failed" | "missed" | "cancelled";

export interface ScheduledPost {
  id: string;
  createdAt: number;
  /** When it goes up (epoch ms). */
  at: number;
  /** The words the person used ("tomorrow at 9"). */
  when: string;
  channelId: string;
  channelName: string;
  jobId: string | null;
  /** Resolved when it was scheduled, so a missing file is known now, not at 9am. */
  videoPath: string;
  title: string;
  description: string;
  tags: string[];
  privacy: "public" | "unlisted" | "private";
  status: PostStatus;
  attempts: number;
  videoId?: string;
  youtubeUrl?: string;
  postedAt?: string;
  error?: string;
  /** Read back from YouTube: what the posted clip actually did. */
  stats?: { at: number; views: number; likes: number; comments: number };
}

export interface ScheduledPostView extends ScheduledPost {
  /** "Tue 6 Oct, 09:00" — the moment in the person's own clock. */
  atLocal: string;
  due: boolean;
  keeps: string;
}

interface ScheduleFile {
  posts: ScheduledPost[];
}

/** After this long past its moment, a post is "missed" rather than silently late. */
export const MAX_LATE_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
/** A failed post waits this long before it is tried again. */
const RETRY_BACKOFF_MS = 5 * 60_000;
/** Finished entries are kept this long, so the history can say what was posted. */
const KEEP_FINISHED_MS = 60 * 24 * 60 * 60 * 1000;
const FILE_LIMIT = 200;
/** How long a "posting" entry may sit before it is treated as interrupted by a crash. */
const POSTING_STALE_MS = 15 * 60_000;
/** Stats are read back at most this often per post. */
const STATS_REFRESH_MS = 6 * 60 * 60 * 1000;
/** Stats are only tracked this long after posting. */
const STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function fileFor(): string {
  return path.join(config.dataDir, "post-schedule.json");
}

function load(): ScheduledPost[] {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as ScheduleFile;
    return Array.isArray(raw.posts) ? raw.posts : [];
  } catch {
    return [];
  }
}

function save(posts: ScheduledPost[]): void {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  const finished = new Set<PostStatus>(["posted", "failed", "missed", "cancelled"]);
  const kept = posts
    .filter((p) => !finished.has(p.status) || Date.parse(p.postedAt ?? "") > cutoff || p.createdAt > cutoff)
    .slice(-FILE_LIMIT);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(fileFor(), JSON.stringify({ posts: kept }, null, 2));
  } catch (err) {
    console.warn("[posts] couldn't save the schedule:", (err as Error).message);
  }
}

const newId = (): string => `post_${crypto.randomBytes(4).toString("hex")}`;

const cleanLine = (value: string, max: number): string => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Where a finished export job's file lives (the same three places the export route looks). */
export function videoPathForJob(jobId: string): string | null {
  const candidates = [
    path.join(config.uploadsDir, "jobs", `${jobId}.mp4`),
    path.join(config.uploadsDir, `soundwave_short_${jobId}.mp4`),
    path.join(config.uploadsDir, `${jobId}.mp4`),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export interface SchedulePostInput {
  jobId?: string | null;
  videoPath?: string | null;
  title?: string;
  description?: string;
  tags?: string[];
  privacy?: "public" | "unlisted" | "private";
  /** "tomorrow at 9", "at 17:30", "in 2 hours". */
  when?: string;
  /** Post right now instead of at a time. */
  now?: boolean;
  channelId?: string | null;
}

export class PostError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function atLocal(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function view(entry: ScheduledPost, now: Date): ScheduledPostView {
  return {
    ...entry,
    atLocal: atLocal(entry.at),
    due: entry.status === "scheduled" && entry.at <= now.getTime(),
    keeps: new Date(entry.at + KEEP_FINISHED_MS).toISOString(),
  };
}

/**
 * "Post this clip tomorrow at 9." The file is checked now (nobody wants to hear
 * at 9am that the render was cleaned up overnight), and the words are parsed by
 * the same code the reminders use, so "at 9" means 9 everywhere in the app.
 */
export function schedulePost(input: SchedulePostInput, now: Date = new Date()): ScheduledPostView {
  const title = cleanLine(input.title ?? "", 100);
  if (!title) throw new PostError("A post needs a title — that is the first thing YouTube shows.", "NO_TITLE");

  const channel = channelFor(input.channelId) ?? channelFor(defaultChannelId());
  if (!channel) throw new PostError("No YouTube channel is connected yet, so there is nowhere to post. Connect one in Settings → YouTube first.", "NO_CHANNEL");

  const videoPath = input.videoPath ? path.resolve(input.videoPath) : input.jobId ? videoPathForJob(input.jobId) : null;
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new PostError("I couldn't find that clip's file to post it. Render it again (or pick a finished clip) and I'll schedule it.", "NO_FILE");
  }

  const createdAt = now.getTime();
  let at = createdAt;
  let when = "right now";
  if (!input.now) {
    const parsed = parseWhen(String(input.when ?? ""), now);
    if ("error" in parsed) throw new PostError(parsed.error, "BAD_WHEN");
    at = parsed.at;
    when = parsed.said;
    if (at - createdAt < 60_000) throw new PostError("That's less than a minute away — post it now instead.", "TOO_SOON");
    if (at - createdAt > 365 * 24 * 60 * 60 * 1000) throw new PostError("That's more than a year away — I can't hold a clip that long.", "TOO_FAR");
  }

  const entry: ScheduledPost = {
    id: newId(),
    createdAt,
    at,
    when,
    channelId: channel.id,
    channelName: channel.name,
    jobId: input.jobId ?? null,
    videoPath,
    title,
    description: cleanLine(input.description ?? "", 4_000),
    tags: (input.tags ?? []).map((t) => cleanLine(t, 40)).filter(Boolean).slice(0, 15),
    privacy: input.privacy ?? channel.privacy ?? "public",
    status: "scheduled",
    attempts: 0,
  };
  save([...load(), entry]);
  return view(entry, now);
}

export function listScheduledPosts(now: Date = new Date()): { scheduled: ScheduledPostView[]; history: ScheduledPostView[] } {
  const posts = load().map((p) => view(p, now));
  posts.sort((a, b) => a.at - b.at);
  return {
    scheduled: posts.filter((p) => p.status === "scheduled" || p.status === "posting"),
    history: posts.filter((p) => p.status !== "scheduled" && p.status !== "posting").sort((a, b) => b.at - a.at),
  };
}

const FILLER = new Set(["the", "a", "an", "my", "that", "this", "clip", "short", "video", "at", "on"]);

function wordsMatch(haystack: string, needle: string): boolean {
  const words = needle
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !FILLER.has(w));
  if (!words.length) return false;
  const text = haystack.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Cancel by id, title, or the words the person used ("the space facts one"). */
export function cancelScheduledPost(idOrWords: string, now: Date = new Date()): { ok: boolean; cancelled?: ScheduledPostView; error?: string } {
  const posts = load();
  const needle = String(idOrWords ?? "").trim();
  if (!needle) return { ok: false, error: "Which post? Give me the title, or say what it was about." };
  const waiting = posts.filter((p) => p.status === "scheduled" || p.status === "posting");
  const found =
    waiting.find((p) => p.id === needle) ??
    waiting.find((p) => wordsMatch(p.title, needle)) ??
    waiting.find((p) => wordsMatch(`${p.title} ${p.description}`, needle));
  if (!found) {
    const upcoming = waiting.map((p) => `“${p.title}” (${atLocal(p.at)})`).join(", ");
    return { ok: false, error: upcoming ? `Nothing waiting matches that. Waiting: ${upcoming}.` : "Nothing is waiting to be posted." };
  }
  found.status = "cancelled";
  save(posts);
  return { ok: true, cancelled: view(found, now) };
}

function announce(text: string): void {
  try {
    appendToConversation({ id: newMessageId(Date.now()), sender: "assistant", text, time: chatTime(new Date()), at: Date.now() });
  } catch (err) {
    console.warn("[posts] couldn't say it in the chat:", (err as Error).message);
  }
}

function describeMiss(entry: ScheduledPost, now: Date): string {
  const late = now.getTime() - entry.at;
  const hours = Math.round(late / (60 * 60_000));
  return hours <= 1 ? "about an hour" : `${hours} hours`;
}

function isTransient(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b(401|403|invalid_grant|quota|rate limit|429|5\d\d|econnreset|etimedout|enotfound|socket|network)\b/.test(message)) return true;
  return /timeout|temporar|try again|connection/i.test(message);
}

async function postOne(entry: ScheduledPost): Promise<{ videoId: string; youtubeUrl: string; title: string }> {
  const channel = channelFor(entry.channelId);
  if (!channel) throw new PostError(`The channel “${entry.channelName}” isn't connected any more.`, "NO_CHANNEL");
  const token = await accessTokenFor(channel);
  return youtubeService.uploadWithToken(token, {
    videoPath: entry.videoPath,
    title: entry.title,
    description: entry.description,
    tags: entry.tags,
    privacy: entry.privacy,
    defaults: { defaultPrivacy: channel.privacy },
  });
}

/** Posts that are due now. Called by the tick, and directly by the tests. */
export async function postDuePosts(now: Date = new Date()): Promise<{ posted: ScheduledPost[]; failed: ScheduledPost[]; missed: ScheduledPost[] }> {
  const posts = load();
  const posted: ScheduledPost[] = [];
  const failed: ScheduledPost[] = [];
  const missed: ScheduledPost[] = [];
  let changed = false;

  // A "posting" entry whose process died mid-upload: make it due again rather
  // than leaving it stuck forever (uploads are resumable on YouTube's side, but
  // our clock isn't — so it simply tries again).
  for (const p of posts) {
    if (p.status === "posting" && now.getTime() - (p.stats?.at ?? p.createdAt) > POSTING_STALE_MS && p.attempts < MAX_ATTEMPTS) {
      p.status = "scheduled";
      changed = true;
    }
  }

  const due = posts.filter((p) => p.status === "scheduled" && p.at <= now.getTime());
  for (const entry of due) {
    if (now.getTime() - entry.at > MAX_LATE_MS) {
      entry.status = "missed";
      entry.error = `The PC was off when this was due (${describeMiss(entry, now)} late), so it never went up.`;
      missed.push(entry);
      changed = true;
      announce(`“${entry.title}” was due ${entry.when} but this PC was off then — I didn't post it, because a Short published ${describeMiss(entry, now)} late is worse than one posted when you meant it. Say the word and I'll put it up now.`);
      continue;
    }

    entry.status = "posting";
    entry.attempts += 1;
    save(posts);
    changed = true;
    try {
      const result = await postOne(entry);
      entry.status = "posted";
      entry.videoId = result.videoId;
      entry.youtubeUrl = result.youtubeUrl;
      entry.postedAt = new Date().toISOString();
      entry.error = undefined;
      noteChannelUpload(entry.channelId, result.youtubeUrl);
      posted.push(entry);
      announce(`Posted “${entry.title}” to ${entry.channelName}: ${result.youtubeUrl}\nI'll tell you how it does — views and likes come back here, and they shape which moments I pick next.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      noteChannelError(entry.channelId, message);
      if (isTransient(err) && entry.attempts < MAX_ATTEMPTS) {
        entry.status = "scheduled";
        entry.at = now.getTime() + RETRY_BACKOFF_MS;
        entry.error = `Couldn't post it (${message}). Trying again in a few minutes.`;
      } else {
        entry.status = "failed";
        entry.error = message;
        failed.push(entry);
        announce(`I couldn't post “${entry.title}”: ${message}`);
      }
      changed = true;
    }
    save(posts);
  }

  if (changed) save(posts);
  return { posted, failed, missed };
}

/** YouTube's own numbers for one posted clip, with that channel's token. */
async function fetchStats(channelId: string, videoId: string): Promise<{ views: number; likes: number; comments: number } | null> {
  const channel = channelFor(channelId);
  if (!channel) return null;
  try {
    const token = await accessTokenFor(channel);
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(videoId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: Array<{ statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }> };
    const s = body.items?.[0]?.statistics;
    if (!s) return null;
    const n = (v?: string): number => Number(v ?? 0) || 0;
    return { views: n(s.viewCount), likes: n(s.likeCount), comments: n(s.commentCount) };
  } catch {
    return null;
  }
}

/** Read back how the posted clips are doing. Cheap: one call per clip, at most every six hours. */
export async function refreshPostedStats(now: Date = new Date()): Promise<number> {
  const posts = load();
  let updated = 0;
  for (const p of posts) {
    if (p.status !== "posted" || !p.videoId) continue;
    const postedAt = Date.parse(p.postedAt ?? "") || p.createdAt;
    if (now.getTime() - postedAt > STATS_WINDOW_MS) continue;
    if (p.stats && now.getTime() - p.stats.at < STATS_REFRESH_MS) continue;
    const stats = await fetchStats(p.channelId, p.videoId);
    if (!stats) continue;
    p.stats = { at: now.getTime(), ...stats };
    updated += 1;
  }
  if (updated) save(posts);
  return updated;
}

/**
 * What this person's own audience actually rewarded. Handed to the moment
 * picker as context, so the next clips lean towards what worked here — not
 * towards a generic idea of what goes viral.
 */
export function audienceBrief(limit = 5): string | undefined {
  const posted = load()
    .filter((p) => p.status === "posted" && p.stats)
    .sort((a, b) => (b.stats?.views ?? 0) - (a.stats?.views ?? 0))
    .slice(0, limit);
  if (posted.length < 2) return undefined;
  const lines = posted.map((p) => `“${p.title}” — ${p.stats!.views} views, ${p.stats!.likes} likes`);
  return `Clips already posted on this channel, by how they did (best first): ${lines.join("; ")}.`;
}

/** A person-readable summary for the chat / the briefing. */
export function performanceSummary(): string {
  const posted = load().filter((p) => p.status === "posted" && p.stats);
  if (!posted.length) return "Nothing has been posted from here yet.";
  const byViews = [...posted].sort((a, b) => (b.stats?.views ?? 0) - (a.stats?.views ?? 0));
  const total = posted.reduce((sum, p) => sum + (p.stats?.views ?? 0), 0);
  const best = byViews[0]!;
  return `${posted.length} posted clip(s), ${total} views together. Best: “${best.title}” with ${best.stats!.views} views and ${best.stats!.likes} likes.`;
}

/** Tests reset the file; the app calls init once. */
export function resetPostScheduleForTests(): void {
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing there */
  }
}

/**
 * Twenty seconds, like the reminders and the email schedule: close enough that
 * "at 9:00" means 9:00, cheap enough to forget about. Stats are read back on a
 * slower clock — YouTube's numbers don't move within the hour.
 */
export function initPostSchedule(): () => void {
  const tick = () => {
    postDuePosts()
      .then((r) => {
        if (r.posted.length || r.failed.length) console.log(`[posts] posted ${r.posted.length}, failed ${r.failed.length}, missed ${r.missed.length}`);
        return refreshPostedStats();
      })
      .catch((err) => console.warn("[posts] tick failed:", (err as Error).message));
  };
  const timer = setInterval(tick, 20_000);
  timer.unref?.();
  const first = setTimeout(tick, 8_000);
  first.unref?.();
  const stats = setInterval(() => void refreshPostedStats().catch(() => undefined), 60 * 60_000);
  stats.unref?.();
  return () => {
    clearInterval(timer);
    clearInterval(stats);
    clearTimeout(first);
  };
}

/** Every channel a clip could be posted to (the route shows these as choices). */
export function postableChannels(): Array<{ id: string; name: string }> {
  return listChannels().map((c) => ({ id: c.id, name: c.name }));
}
