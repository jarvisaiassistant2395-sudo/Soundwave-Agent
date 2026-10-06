// ── Where the audience actually was (measured interest, no guessing) ────────
// The clip picker used to judge a moment by its sound and its words. That is a
// guess about what people like. This module adds the three things YouTube
// actually measures, and turns them into a per-window score and a sentence a
// person can check:
//
//  1. **The heat map.** YouTube publishes the "most replayed" curve of a video
//     (yt-dlp calls it `heatmap`: points of {start_time, end_time, value} where
//     value is a normalised intensity). It is *real viewer behaviour*: those
//     are the seconds people rewound to watch again. A window built on a heat
//     peak is where the audience already said "this is the good part".
//  2. **The comments.** People write "2:14 had me crying" — a human pointing at
//     a moment, with the like count as the weight. Parsed into anchors and
//     folded into the windows they point at.
//  3. **What is getting views this week.** The trending-shorts digest holds the
//     current popular Shorts with real view counts; the terms that appear
//     across many of them (see shortsTrends.topTopics) are what the audience is
//     watching *now*. A moment whose words match one is riding that, and the
//     sentence says which term and how many views it is worth.
//
// Everything here is pure and unit-tested: the fetching lives in ytdlp.ts and
// videoClips.ts, and a video with no signals at all scores exactly as it did
// before (that path is pinned by tests/clips.test.ts).
//
// Why the score is shaped like this: heat is the only signal that is about
// *this* video's viewers, so it carries the weight; comments are strong but
// sparse (most videos have none with timestamps); trends are about the market,
// not the video, so they only nudge; the video's own momentum amplifies the
// rest rather than adding to it — it says whether the measurements are current,
// not where in the video the good part is.

import type { VideoWindow } from "./clips.js";

/** One point of YouTube's own most-replayed curve. `value` is 0–1. */
export interface HeatPoint {
  start: number;
  end: number;
  value: number;
}

/** A comment that points at a moment ("2:14 had me crying"), with its weight. */
export interface CommentAnchor {
  atSec: number;
  likes: number;
  text: string;
}

/** A term that is earning views across this week's popular Shorts. */
export interface TrendTerm {
  term: string;
  /** Views of the popular Shorts the term appears in, added up. */
  views: number;
  /** How many different channels had it in their title — 1 channel is a fluke. */
  shorts: number;
}

export interface VideoStats {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  ageHours?: number | null;
  channelViews?: number | null;
}

/** Everything the audience-measured pass learned about one video. */
export interface ViewSignals {
  heat: HeatPoint[];
  anchors: CommentAnchor[];
  trends: TrendTerm[];
  stats: VideoStats;
  /** YouTube's chapter titles, when the uploader wrote them. */
  chapters?: Array<{ start: number; end: number; title: string }>;
  /** What could not be read, said once, so the chat can be honest about it. */
  notes?: string[];
}

/** How much of the score each measured signal can claim. */
export const INTEREST_WEIGHTS = { heat: 0.55, comments: 0.2, trends: 0.15 } as const;

/** How much the video being hot right now amplifies a measured moment (10%). */
export const MOMENTUM_BOOST = 0.1;

/** Below this, a heat value is not a "part people replayed". */
export const HEAT_PEAK_FLOOR = 0.55;

/** A term shorter than this matches too much to mean anything. */
const MIN_TERM_LENGTH = 4;

/** Two anchors closer than this are the same moment, said twice. */
const ANCHOR_MERGE_SECONDS = 4;

/** Views per hour that count as "this is hot right now" for the momentum part. */
const HOT_VIEWS_PER_HOUR = 6_000;

/** How much a window grows when it is built on a heat peak (seconds, each side). */
export const HEAT_WINDOW_PAD_SECONDS = 6;

/** "1.2M" / "18.4k" / "934" — a view count a person reads at a glance. */
export function viewsLabel(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  // One decimal until the number is big enough that the decimal is noise.
  const scaled = (value: number, unit: number, dropDecimalsAt: number) =>
    `${(value / unit).toFixed(value >= dropDecimalsAt ? 0 : 1)}`;
  if (n >= 1_000_000_000) return `${scaled(n, 1_000_000_000, 10_000_000_000)}B`;
  if (n >= 1_000_000) return `${scaled(n, 1_000_000, 10_000_000)}M`;
  if (n >= 1_000) return `${scaled(n, 1_000, 100_000)}k`;
  return String(Math.round(n));
}

/**
 * yt-dlp's `heatmap` field → our points, whatever shape it arrived in.
 * Anything malformed is dropped rather than thrown: this data decides which
 * seconds of someone's video get clipped, and a bad point is worse than none.
 */
export function parseHeatmap(raw: unknown): HeatPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: HeatPoint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const point = entry as { start_time?: unknown; end_time?: unknown; value?: unknown };
    const start = Number(point.start_time);
    const end = Number(point.end_time);
    const value = Number(point.value);
    if (!Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(value)) continue;
    const stop = Number.isFinite(end) && end > start ? end : start + 1;
    out.push({ start: round3(start), end: round3(stop), value: clamp01(value) });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** The video's own heat shape: where its ceiling is and what "normal" looks like. */
export function heatStats(heat: HeatPoint[]): { median: number; peak: number; peakAt: number } {
  if (!heat.length) return { median: 0, peak: 0, peakAt: 0 };
  const values = heat.map((p) => p.value).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)] ?? 0;
  let peak = 0;
  let peakAt = 0;
  for (const point of heat) {
    if (point.value > peak) {
      peak = point.value;
      peakAt = (point.start + point.end) / 2;
    }
  }
  return { median, peak, peakAt };
}

/**
 * The places people replayed most: local maxima above the floor, kept apart.
 * These become candidate clip windows of their own (see heatWindows) — the
 * audience already marked them, so the clipper does not have to guess.
 */
export function heatPeaks(heat: HeatPoint[], opts: { floor?: number; minGapSec?: number; max?: number } = {}): HeatPoint[] {
  const floor = opts.floor ?? HEAT_PEAK_FLOOR;
  const minGap = opts.minGapSec ?? 8;
  const max = opts.max ?? 12;
  if (!heat.length) return [];
  const sorted = [...heat].sort((a, b) => b.value - a.value);
  const picked: HeatPoint[] = [];
  for (const point of sorted) {
    if (point.value < floor) break;
    const middle = (point.start + point.end) / 2;
    if (picked.some((p) => Math.abs((p.start + p.end) / 2 - middle) < minGap)) continue;
    picked.push(point);
    if (picked.length >= max) break;
  }
  return picked.sort((a, b) => a.start - b.start);
}

/** The highest replay value inside a window (0 when there is no heat map). */
export function heatAt(heat: HeatPoint[], start: number, end: number): number {
  let best = 0;
  for (const point of heat) {
    if (point.end <= start || point.start >= end) continue;
    if (point.value > best) best = point.value;
  }
  return best;
}

/**
 * How much of the *replayed part* a window actually contains: the peak's value,
 * weighted by the share of the peak that falls inside the window.
 *
 * This is what stops a long window that merely grazes a peak (the last three
 * seconds of a ten-second replay, say) from claiming the peak's full value —
 * which is exactly how the speech window around a measured moment used to
 * outrank the moment itself.
 */
export function heatCoverage(heat: HeatPoint[], start: number, end: number): number {
  let best = 0;
  const span = Math.max(0, end - start);
  if (!heat.length || span <= 0) return 0;
  for (const point of heat) {
    const overlap = Math.min(end, point.end) - Math.max(start, point.start);
    if (overlap <= 0) continue;
    const share = Math.min(1, overlap / Math.max(0.001, point.end - point.start));
    const value = point.value * share;
    if (value > best) best = value;
  }
  return best;
}

/**
 * The video's measured peaks turned into windows, in video order: one window per
 * peak, padded to something clip-shaped and clamped to the video. Two peaks far
 * enough apart to be separate moments (heatPeaks keeps them 8 s apart) therefore
 * stay two windows — this is how a video with three replayed stretches becomes
 * three clips — while a window already covered by another is dropped rather than
 * duplicated.
 */
export function heatWindows(heat: HeatPoint[], durationSec: number, opts: { max?: number; padSec?: number } = {}): VideoWindow[] {
  const pad = opts.padSec ?? HEAT_WINDOW_PAD_SECONDS;
  const peaks = heatPeaks(heat, { max: opts.max ?? 8 });
  const windows: VideoWindow[] = [];
  for (const peak of peaks) {
    const start = Math.max(0, Math.min(peak.start, peak.end) - pad);
    const end = Math.min(durationSec, Math.max(peak.start, peak.end) + pad);
    if (end - start < 2) continue;
    const covered = windows.some((k) => k.start <= start + 0.5 && k.end >= end - 0.5);
    if (covered) continue;
    windows.push({ start: round3(start), end: round3(end) });
  }
  return windows;
}

/** "2:14" / "1:02:03" mentions in a comment. Anything over the video is ignored. */
export function parseTimecodes(text: string, durationSec = Number.POSITIVE_INFINITY): number[] {
  const said = typeof text === "string" ? text : "";
  if (!said) return [];
  const out: number[] = [];
  const pattern = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(said))) {
    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (seconds > 59) continue; // 1:99 is not a timecode
    if (!match[1] && minutes > 59) continue;
    const at = hours * 3600 + minutes * 60 + seconds;
    if (at > durationSec) continue;
    out.push(at);
  }
  return out;
}

/**
 * Comments → the moments they point at. One comment can name several times;
 * each mention becomes an anchor that inherits the comment's likes, which is
 * what makes "the top comment points here" worth more than a reply with none.
 */
export function commentAnchors(
  comments: Array<{ text?: unknown; likes?: unknown }>,
  durationSec: number,
  opts: { max?: number } = {},
): CommentAnchor[] {
  const max = opts.max ?? 40;
  const raw: CommentAnchor[] = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!comment || typeof comment !== "object") continue;
    const text = typeof comment.text === "string" ? comment.text : "";
    if (!text) continue;
    const likes = Number(comment.likes);
    const weight = Number.isFinite(likes) && likes > 0 ? likes : 0;
    for (const at of parseTimecodes(text, durationSec)) {
      raw.push({ atSec: round3(at), likes: weight, text: text.replace(/\s+/g, " ").trim().slice(0, 160) });
    }
  }
  raw.sort((a, b) => b.likes - a.likes || a.atSec - b.atSec);
  // Same moment said by several people: keep the loudest, remember how many.
  const out: CommentAnchor[] = [];
  for (const anchor of raw) {
    const near = out.find((a) => Math.abs(a.atSec - anchor.atSec) <= ANCHOR_MERGE_SECONDS);
    if (near) {
      near.likes += anchor.likes;
      continue;
    }
    out.push({ ...anchor });
    if (out.length >= max) break;
  }
  return out.sort((a, b) => a.atSec - b.atSec);
}

/**
 * This week's popular Shorts → the terms earning views, with the views they
 * carry. Same idea as shortsTrends.topTopics (a term must appear on several
 * channels to count) but the counts are kept, because "4.1M views" is what
 * makes the sentence worth reading.
 */
export function trendTerms(
  top: Array<{ title?: unknown; views?: unknown; channel?: unknown; id?: unknown }>,
  opts: { max?: number } = {},
): TrendTerm[] {
  const max = opts.max ?? 8;
  const byTerm = new Map<string, { views: number; channels: Set<string> }>();
  for (const short of Array.isArray(top) ? top : []) {
    if (!short || typeof short !== "object") continue;
    const title = typeof short.title === "string" ? short.title : "";
    if (!title) continue;
    const views = Math.max(0, Number(short.views) || 0);
    const channel = String(short.channel ?? short.id ?? "");
    const words = new Set(
      title
        .toLowerCase()
        .replace(/#[\p{L}\p{N}_]+/gu, " ")
        .split(/[^\p{L}\p{N}']+/u)
        .filter((w) => w.length >= MIN_TERM_LENGTH && !/^\d+$/.test(w)),
    );
    for (const word of words) {
      const entry = byTerm.get(word) ?? { views: 0, channels: new Set<string>() };
      entry.views += views;
      entry.channels.add(channel);
      byTerm.set(word, entry);
    }
  }
  return [...byTerm.entries()]
    .filter(([, entry]) => entry.channels.size >= 2)
    .map(([term, entry]) => ({ term, views: Math.round(entry.views), shorts: entry.channels.size }))
    .sort((a, b) => b.views - a.views)
    .slice(0, max);
}

/** Which trending terms a window's words actually contain (whole words only). */
export function matchTrendTerms(text: string | undefined, terms: TrendTerm[]): TrendTerm[] {
  const said = (text ?? "").toLowerCase();
  if (!said.trim() || !terms.length) return [];
  const words = new Set(said.split(/[^\p{L}\p{N}']+/u).filter(Boolean));
  return terms.filter((t) => words.has(t.term) || said.includes(`${t.term} `));
}

/**
 * One window's measured interest: 0–1, plus the sentences that justify it.
 * A window in a video with no heat map, no anchors and no matching terms scores
 * 0 with no evidence — the caller then ranks on the audio/words score it always
 * used, which is why this can be added without changing old behaviour.
 */
export function windowInterest(
  window: VideoWindow,
  opts: { signals: ViewSignals; text?: string },
): { score: number; parts: { heat: number; comments: number; trends: number; momentum: number }; evidence: string[] } {
  const { signals } = opts;
  const evidence: string[] = [];
  const heat = signals.heat ?? [];
  const shape = heatStats(heat);
  const windowHeat = heatCoverage(heat, window.start, window.end);
  // Normalised between "not a replay peak at all" and this video's own best:
  // a 0.62 peak in a video whose ceiling is 0.64 is the best part of *that*
  // video, so it scores as high as a 0.95 in one whose ceiling is 0.95. Flat
  // curves behave sensibly too — a video replayed evenly everywhere gives every
  // window the same score, and one that was never replayed gives none of them
  // anything, which is the honest answer.
  const heatPart = heat.length
    ? clamp01((windowHeat - HEAT_PEAK_FLOOR) / Math.max(0.05, shape.peak - HEAT_PEAK_FLOOR))
    : 0;
  if (heatPart > 0.15 && windowHeat >= HEAT_PEAK_FLOOR) {
    const at = heatAtSeconds(heat, window.start, window.end);
    evidence.push(`Viewers replayed this part: ${Math.round(windowHeat * 100)}% of the video's own peak${at ? ` (around ${clockShort(at)})` : ""}`);
  }

  const anchors = (signals.anchors ?? []).filter((a) => a.atSec >= window.start - 3 && a.atSec <= window.end + 3);
  const topAnchor = anchors.reduce<CommentAnchor | null>((best, a) => (!best || a.likes > best.likes ? a : best), null);
  const strongest = (signals.anchors ?? []).reduce((max, a) => Math.max(max, a.likes), 0);
  let commentsPart = 0;
  if (anchors.length && strongest > 0) {
    const weight = anchors.reduce((sum, a) => sum + Math.log1p(Math.max(0, a.likes)), 0);
    commentsPart = clamp01(weight / Math.log1p(strongest * Math.max(1, Math.min(3, anchors.length))));
  }
  if (topAnchor) {
    evidence.push(
      `A comment points here (${clockShort(topAnchor.atSec)})${topAnchor.likes ? `, ${viewsLabel(topAnchor.likes)} likes` : ""}: “${trimQuote(topAnchor.text)}”`,
    );
  }

  const matched = matchTrendTerms(opts.text, signals.trends ?? []);
  const bestTrend = matched.reduce<TrendTerm | null>((best, t) => (!best || t.views > best.views ? t : best), null);
  const topTrendViews = (signals.trends ?? []).reduce((max, t) => Math.max(max, t.views), 0);
  const trendsPart = bestTrend && topTrendViews > 0 ? clamp01(bestTrend.views / topTrendViews) : 0;
  if (bestTrend) {
    evidence.push(`Its words match “${bestTrend.term}”, worth ${viewsLabel(bestTrend.views)} views across ${bestTrend.shorts} popular Shorts this week`);
  }

  const velocity = (signals.stats?.views ?? 0) > 0 && (signals.stats?.ageHours ?? 0) > 0
    ? (signals.stats!.views as number) / (signals.stats!.ageHours as number)
    : 0;
  const momentumPart = velocity > 0 ? clamp01(velocity / HOT_VIEWS_PER_HOUR) : 0;

  // Momentum amplifies rather than adds: a video that is hot right now makes
  // its measured moments more trustworthy (those are current viewers, not
  // viewers from two years ago), but being hot says nothing about *where* in
  // the video people watched. A window with no measured signal of its own
  // therefore still scores zero instead of inheriting the video's popularity.
  const measured = heatPart * INTEREST_WEIGHTS.heat + commentsPart * INTEREST_WEIGHTS.comments + trendsPart * INTEREST_WEIGHTS.trends;
  const score = clamp01(measured * (1 + MOMENTUM_BOOST * momentumPart));
  return { score: round4(score), parts: { heat: round4(heatPart), comments: round4(commentsPart), trends: round4(trendsPart), momentum: round4(momentumPart) }, evidence };
}

/** The moment inside a window that the heat map likes most. */
export function heatAtSeconds(heat: HeatPoint[], start: number, end: number): number {
  let best = 0;
  let at = 0;
  for (const point of heat) {
    if (point.end <= start || point.start >= end) continue;
    if (point.value > best) {
      best = point.value;
      at = (point.start + point.end) / 2;
    }
  }
  return at;
}

/**
 * Slide a chosen window onto its strongest measured moment. The window list is
 * built from speech runs and merged peaks, so a chosen window can start far
 * before the part the audience actually replayed (two talking stretches merged
 * into one, for instance). The clip should begin where the interest is, not
 * where the nearest silence happened to be.
 *
 * The heat peak wins when it is a real one; otherwise the strongest comment
 * anchor inside the window is used (a person pointing at a moment is evidence
 * even when YouTube published no curve). With neither, the window is returned
 * untouched — a video with no measured data behaves exactly as before.
 */
export function snapToInterest(
  window: VideoWindow,
  signals: ViewSignals | null | undefined,
  opts: { minSeconds: number; maxSeconds: number; durationSec: number; padSec?: number },
): VideoWindow {
  if (!signals || !(opts.durationSec > 0)) return window;
  const pad = opts.padSec ?? HEAT_WINDOW_PAD_SECONDS;
  const inside = (signals.heat ?? []).filter((p) => p.end > window.start && p.start < window.end);
  const strongest = inside.reduce<HeatPoint | null>((best, p) => (!best || p.value > best.value ? p : best), null);
  const peak = strongest && strongest.value >= HEAT_PEAK_FLOOR ? strongest : null;
  const anchor = peak
    ? null
    : (signals.anchors ?? [])
        .filter((a) => a.atSec >= window.start && a.atSec <= window.end)
        .reduce<CommentAnchor | null>((best, a) => (!best || a.likes > best.likes ? a : best), null);
  if (!peak && !anchor) return window;

  const center = peak ? (peak.start + peak.end) / 2 : anchor!.atSec;
  const length = clampNumber((peak ? Math.max(1, peak.end - peak.start) : 0) + 2 * pad, opts.minSeconds, Math.min(opts.maxSeconds, opts.durationSec));
  const half = length / 2;
  // Centred on the moment, and deliberately *not* pushed back to keep the full
  // length when the video ends first: a peak at the end of the video must not
  // drag 10 seconds of dead air in ahead of it just to reach a round length.
  let start = clampNumber(center - half, 0, opts.durationSec);
  let end = Math.min(opts.durationSec, center + half);
  if (end - start < opts.minSeconds) {
    // Reach the minimum length by pushing the free edge out, never by moving
    // the peak out of the clip.
    if (start <= 0) end = Math.min(opts.durationSec, start + opts.minSeconds);
    else start = Math.max(0, end - opts.minSeconds);
  }
  if (end - start < 1) return window;
  return { start: round3(start), end: round3(end) };
}

export interface RankedWindow<T> {
  item: T;
  interest: number;
  evidence: string[];
}

/**
 * Rank windows by measured interest alone (highest first, ties by time). Used
 * to decide which moments are worth listening to (speech recognition is the
 * slow part, so the heat map decides who gets a slot) and, at the end, which
 * clip the person should watch first.
 */
export function rankByInterest<T extends VideoWindow>(
  windows: T[],
  signals: ViewSignals | null | undefined,
  textFor?: (window: T) => string | undefined,
): Array<RankedWindow<T>> {
  if (!signals) return windows.map((item) => ({ item, interest: 0, evidence: [] }));
  return windows
    .map((item) => {
      const { score, evidence } = windowInterest(item, { signals, text: textFor?.(item) });
      return { item, interest: score, evidence };
    })
    .sort((a, b) => b.interest - a.interest || a.item.start - b.item.start);
}

/**
 * The measured signals as lines a person reads before the clips arrive. Written
 * for the chat, not the prompt: every number is one the person can go and check
 * on YouTube themselves.
 */
export function interestBrief(signals: ViewSignals | null | undefined, opts: { name?: string } = {}): string[] {
  if (!signals) return [];
  const lines: string[] = [];
  const heat = signals.heat ?? [];
  const shadow = heatStats(heat);
  if (heat.length) {
    const peaks = heatPeaks(heat, { max: 3 });
    const spots = peaks.length
      ? peaks.map((p) => `${clockShort((p.start + p.end) / 2)} (${Math.round((p.value / Math.max(shadow.peak, 0.01)) * 100)}%)`).join(", ")
      : `peak at ${clockShort(shadow.peakAt)}`;
    lines.push(`📈 YouTube's own most-replayed data for this video: it is watched again most at ${spots}.`);
  }
  const anchors = (signals.anchors ?? []).slice().sort((a, b) => b.likes - a.likes).slice(0, 3);
  for (const anchor of anchors) {
    if (anchor.likes < 1) continue;
    lines.push(`💬 A comment points at ${clockShort(anchor.atSec)} (${viewsLabel(anchor.likes)} likes): “${trimQuote(anchor.text)}”`);
  }
  const trend = (signals.trends ?? [])[0];
  if (trend) lines.push(`🔥 Getting views this week: “${trend.term}” — ${viewsLabel(trend.views)} across ${trend.shorts} popular Shorts.`);
  const stats = signals.stats ?? {};
  const bits: string[] = [];
  if ((stats.views ?? 0) > 0) bits.push(`${viewsLabel(stats.views)} views`);
  if ((stats.likes ?? 0) > 0) bits.push(`${viewsLabel(stats.likes)} likes`);
  if ((stats.ageHours ?? 0) > 0) bits.push(`${ageLabel(stats.ageHours as number)} old`);
  if (bits.length) lines.push(`👀 This video: ${bits.join(" · ")}.`);
  for (const note of signals.notes ?? []) lines.push(`ℹ️ ${note}`);
  return lines.map((line) => (opts.name ? line : line));
}

/** "12:41" — short clock for evidence lines. */
export function clockShort(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function ageLabel(hours: number): string {
  if (hours < 36) return `${Math.max(1, Math.round(hours))} hours`;
  const days = Math.round(hours / 24);
  if (days < 45) return `${days} days`;
  return `${Math.round(days / 30)} months`;
}

function trimQuote(text: string): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > 90 ? `${clean.slice(0, 87)}…` : clean;
}

function clampNumber(n: number, low: number, high: number): number {
  if (!Number.isFinite(n)) return low;
  return Math.min(Math.max(low, high), Math.max(low, n));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
