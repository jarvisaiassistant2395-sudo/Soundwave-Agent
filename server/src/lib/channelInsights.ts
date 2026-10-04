// ── How the videos are doing: real view numbers ─────────────────────────────
// "Brief me on the views" has to come back with numbers YouTube itself reports,
// for every channel the person connected (Settings → YouTube & Shorts), not just
// the one legacy account `youtubeService.channelStats()` knows. For each channel
// this reads the channel's own totals (views, subscribers, video count) and its
// latest uploads with each video's view count, through that channel's sign-in.
//
// Every look is remembered (DATA_DIR/youtube/view-history.json, per channel,
// capped), so the next briefing can say what changed: "+412 views since I last
// looked, yesterday". That delta is the part a person actually wants.
//
// Nothing here invents a number: a channel whose sign-in stopped working is
// reported as an error for that channel while the others still count, and when
// there is no earlier look the delta is simply absent.
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { accessTokenFor, channelFor, listChannels, type ChannelRecord } from "./youtubeChannels.js";
import { youtubeService } from "./youtube.js";

export interface VideoInsight {
  id: string;
  title: string;
  views: number | null;
  publishedAt: string | null;
  /** Watch on YouTube. */
  url: string;
}

export interface ChannelInsight {
  id: string;
  name: string;
  channelTitle: string;
  subscribers: number | null;
  views: number | null;
  videos: number | null;
  recent: VideoInsight[];
  /** Views gained since the previous look at this channel, if there was one. */
  gainedViews: number | null;
  lastCheckedAt: string | null;
}

export interface InsightsResult {
  channels: ChannelInsight[];
  /** One honest line per channel that couldn't be read (its sign-in, its quota…). */
  errors: string[];
  checkedAt: string;
}

interface Snapshot {
  at: string;
  views: number | null;
  subscribers: number | null;
  videos: number | null;
}

type History = Record<string, Snapshot[]>;

const MAX_SNAPSHOTS = 120;
/** Don't record a new look within this window — a person asking twice in five minutes shouldn't see "+0". */
const MIN_SNAPSHOT_GAP_MS = 10 * 60 * 1000;

function historyFile(): string {
  return path.join(config.dataDir, "youtube", "view-history.json");
}

function readHistory(): History {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(), "utf8")) as History;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeHistory(history: History): void {
  try {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    const tmp = `${historyFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, historyFile());
  } catch (err) {
    console.warn(`[views] could not save ${historyFile()}: ${(err as Error).message}`);
  }
}

/** The last look worth comparing against: old enough to be a real gap, else the previous one. */
function baselineFor(snapshots: Snapshot[]): Snapshot | null {
  if (!snapshots.length) return null;
  const cutoff = Date.now() - MIN_SNAPSHOT_GAP_MS;
  const old = [...snapshots].reverse().find((s) => Date.parse(s.at) <= cutoff);
  return old ?? snapshots[snapshots.length - 1]!;
}

/** Remember this look (skipping near-duplicates), so the next briefing has a baseline. */
function recordSnapshot(history: History, channelId: string, insight: ChannelInsight, now: Date): void {
  const list = history[channelId] ?? [];
  const last = list[list.length - 1];
  const unchanged =
    last && last.views === insight.views && last.subscribers === insight.subscribers && last.videos === insight.videos;
  if (!unchanged || !last || Date.parse(last.at) < now.getTime() - MIN_SNAPSHOT_GAP_MS) {
    list.push({ at: now.toISOString(), views: insight.views, subscribers: insight.subscribers, videos: insight.videos });
    history[channelId] = list.slice(-MAX_SNAPSHOTS);
  }
}

const num = (v: unknown): number | null => (v === undefined || v === null || v === "" ? null : Number(v));

export interface InsightsOptions {
  /** Only this channel (name or id), when the user asked about one. */
  channel?: string;
  /** How many latest uploads per channel to read (1–10, default 5). */
  recent?: number;
  now?: Date;
}

/**
 * Read every connected channel (or one named channel) and remember the numbers.
 * Never throws for one channel's problem — that channel is named in `errors`.
 */
export async function channelInsights(opts: InsightsOptions = {}): Promise<InsightsResult> {
  const now = opts.now ?? new Date();
  const recent = Math.min(10, Math.max(1, Math.round(opts.recent ?? 5)));
  const all = listChannels();
  const wanted: ChannelRecord[] = opts.channel
    ? ([channelFor(opts.channel)].filter(Boolean) as ChannelRecord[])
    : all;

  if (!wanted.length) {
    return {
      channels: [],
      errors: [
        all.length
          ? `No channel called “${opts.channel}”. Connected: ${all.map((c) => c.name).join(", ")}.`
          : "No YouTube channel is connected yet — press “Connect YouTube” in Settings → YouTube & Shorts.",
      ],
      checkedAt: now.toISOString(),
    };
  }

  const history = readHistory();
  const channels: ChannelInsight[] = [];
  const errors: string[] = [];

  for (const channel of wanted) {
    try {
      const stats = await readChannel(channel, recent);
      const baseline = baselineFor(history[channel.id] ?? []);
      const gained =
        baseline && typeof baseline.views === "number" && typeof stats.views === "number"
          ? stats.views - baseline.views
          : null;
      const insight: ChannelInsight = {
        id: channel.id,
        name: channel.name,
        channelTitle: stats.channelTitle,
        subscribers: stats.subscribers,
        views: stats.views,
        videos: stats.videos,
        recent: stats.recent,
        gainedViews: gained,
        lastCheckedAt: baseline?.at ?? null,
      };
      recordSnapshot(history, channel.id, insight, now);
      channels.push(insight);
    } catch (err) {
      errors.push(`${channel.name}: ${(err as Error).message.split("\n")[0]!.slice(0, 200)}`);
    }
  }

  writeHistory(history);
  return { channels, errors, checkedAt: now.toISOString() };
}

interface ReadStats {
  channelTitle: string;
  subscribers: number | null;
  views: number | null;
  videos: number | null;
  recent: VideoInsight[];
}

async function readChannel(channel: ChannelRecord, recent: number): Promise<ReadStats> {
  const token = await accessTokenFor(channel);
  const get = async (pathAndQuery: string): Promise<any> => {
    const res = await fetch(`${config.youtubeApiBase}/youtube/v3/${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`YouTube API error (${res.status}): ${(await res.text()).slice(0, 160)}`);
    return res.json();
  };

  const ch = await get("channels?part=snippet,statistics,contentDetails&mine=true");
  const c = ch.items?.[0];
  if (!c) throw new Error("that sign-in has no YouTube channel on it any more — reconnect it in Settings → YouTube & Shorts");

  const stats: ReadStats = {
    channelTitle: String(c.snippet?.title ?? channel.name),
    subscribers: c.statistics?.hiddenSubscriberCount ? null : num(c.statistics?.subscriberCount),
    views: num(c.statistics?.viewCount),
    videos: num(c.statistics?.videoCount),
    recent: [],
  };

  const uploads = c.contentDetails?.relatedPlaylists?.uploads as string | undefined;
  if (uploads) {
    try {
      const list = await get(`playlistItems?part=contentDetails&maxResults=${recent}&playlistId=${encodeURIComponent(uploads)}`);
      const ids = (list.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean) as string[];
      if (ids.length) {
        const vids = await get(`videos?part=snippet,statistics&id=${ids.join(",")}`);
        const items = (vids.items ?? []) as any[];
        // YouTube answers in the order asked, so a missing id still lines up by
        // position (everything else would silently drop a video's numbers).
        const byId = new Map<string, any>(items.map((v: any) => [String(v.id ?? ""), v]));
        stats.recent = ids
          .map((id, i) => byId.get(id) ?? items[i])
          .filter(Boolean)
          .map((v: any) => ({
            id: String(v.id),
            title: String(v.snippet?.title ?? ""),
            views: num(v.statistics?.viewCount),
            publishedAt: v.snippet?.publishedAt ?? null,
            url: `https://www.youtube.com/watch?v=${v.id}`,
          }));
      }
    } catch {
      /* the totals without the per-video numbers still help */
    }
  }
  return stats;
}

/**
 * The one channel `youtubeService` (the legacy single "Connect YouTube account")
 * knows about, in the same shape — so a machine that connected before channels
 * existed still gets a views briefing.
 */
export async function legacyChannelInsight(opts: { recent?: number; now?: Date } = {}): Promise<ChannelInsight | null> {
  const cfg = youtubeService.getConfig();
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) return null;
  const now = opts.now ?? new Date();
  const recent = Math.min(10, Math.max(1, Math.round(opts.recent ?? 5)));
  try {
    const stats = await youtubeService.channelStats();
    if (!stats) return null;
    const history = readHistory();
    const key = `legacy:${stats.channelTitle}`;
    const baseline = baselineFor(history[key] ?? []);
    const gained =
      baseline && typeof baseline.views === "number" && typeof stats.views === "number" ? stats.views - baseline.views : null;
    const insight: ChannelInsight = {
      id: key,
      name: stats.channelTitle,
      channelTitle: stats.channelTitle,
      subscribers: stats.subscribers,
      views: stats.views,
      videos: stats.videos,
      recent: stats.latest.slice(0, recent).map((v) => ({
        id: "",
        title: v.title,
        views: v.views,
        publishedAt: v.publishedAt,
        url: "",
      })),
      gainedViews: gained,
      lastCheckedAt: baseline?.at ?? null,
    };
    recordSnapshot(history, key, insight, now);
    writeHistory(history);
    return insight;
  } catch (err) {
    console.warn(`[views] legacy channel numbers unavailable: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}
