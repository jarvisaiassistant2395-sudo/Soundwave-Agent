// ── Shorts cut out of a long video (shared by the PC's brain and its jobs) ──
// "Make shorts from this video: <link>" — the agent listens to a long video,
// finds the moments worth clipping, and turns each one into a vertical short
// with burned captions. This file is the thinking part (pure TypeScript: no
// Node APIs, no packages): where the cuts are, which ones are worth it, how
// the spoken words become captions. The server does the ffmpeg/whisper work
// (lib/videoClips.ts) and the phone can show the same rules in the guide.

export const DEFAULT_CLIPS = 3;
export const MAX_CLIPS = 5;
/** Shorter is choppy, longer isn't a Short any more (YouTube's cap is 60 s). */
export const MIN_CLIP_SECONDS = 12;
export const MAX_CLIP_SECONDS = 59;
/** The video is searched for highlights in windows this long. */
export const CLIP_WINDOW_SECONDS = 45;
/** How many of the most promising windows are listened to before picking. */
export const MAX_PICK_TRANSCRIPTS = 8;
/** Captions: at most this many words on screen at once, and this many characters. */
export const MAX_CAPTION_WORDS = 4;
export const MAX_CAPTION_CHARS = 30;
/** A caption that flashes by in less than this can't be read. */
export const MIN_CAPTION_SECONDS = 0.7;

export interface VideoWindow {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
}

export interface ClipPick {
  start: number;
  end: number;
  /** A short title for the short (used for the file name and the chat). */
  title: string;
  /** Why this moment is worth clipping (for the chat). */
  reason: string;
}

/** Everything worth clipping gets searched in windows; a stub tail is merged into the one before. */
export function planWindows(durationSec: number, windowSec = CLIP_WINDOW_SECONDS): VideoWindow[] {
  const total = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  if (total < MIN_CLIP_SECONDS) return total > 0 ? [{ start: 0, end: round3(total) }] : [];
  const out: VideoWindow[] = [];
  for (let start = 0; start < total; start += windowSec) {
    const end = Math.min(total, start + windowSec);
    if (end - start < MIN_CLIP_SECONDS) {
      // Too short to stand alone: extend the window before it.
      if (out.length) out[out.length - 1]!.end = round3(end);
      else out.push({ start: 0, end: round3(end) });
      break;
    }
    out.push({ start: round3(start), end: round3(end) });
  }
  return out;
}

/** Window indices, most promising first. */
export function rankWindows(windows: VideoWindow[], scores: number[]): number[] {
  return windows
    .map((_, i) => i)
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);
}

/** How long a clip should be: the window, or the longest a Short may be. */
export function clipLength(window: VideoWindow, durationSec: number, minSeconds = MIN_CLIP_SECONDS, maxSeconds = MAX_CLIP_SECONDS): number {
  const available = Math.min(durationSec - window.start, window.end - window.start);
  return Math.max(minSeconds, Math.min(maxSeconds, available));
}

/**
 * What Gemini is asked: numbered windows with what is said in them, and the
 * shape of the answer (JSON, one entry per short).
 *
 * `snippets[i]` is `""` when the window was listened to and nothing was said,
 * and `null` when it could not be listened to at all (the speech engine was
 * busy with the person, or too slow for that window). Those are different
 * facts and the model is told them apart: "silent" is a reason to skip a
 * window, "not listened to" is not — it just means that one has to be judged
 * on where it sits in the video. Rendering both as "no speech heard" used to
 * hand the picker a video that looked silent and let it choose blind.
 */
export function buildPickerAsk(
  windows: VideoWindow[],
  snippets: Array<string | null>,
  count: number,
  focus?: string,
  /**
   * What the audience actually did, one entry per window (see
   * brain/core/interest.ts). Optional: without it this is the same prompt it
   * has always been, which is what a video with no published replay data gets.
   */
  evidence?: Array<string[] | undefined>,
): { system: string; user: string } {
  const hasEvidence = Boolean(evidence?.some((lines) => lines && lines.length));
  const system = [
    "You are a short-form video editor. You are given windows of a long video, in order, with what is said in each one.",
    `Pick the ${clampCount(count)} best moments to cut into vertical YouTube Shorts (each ${MIN_CLIP_SECONDS}–${MAX_CLIP_SECONDS} seconds).`,
    "Choose moments that stand on their own: a hook, a surprising fact, a strong opinion, a laugh, a clear explanation — not introductions, housekeeping or half-finished thoughts.",
    "Prefer moments where the speaker's own words make the point; the captions are burned in, so the words matter.",
    hasEvidence
      ? "Where a window says MEASURED, that is real audience data — YouTube's own most-replayed curve, comments that name a timecode, or words that match what is getting views this week. It outranks your own impression of the words: prefer a window with measured interest over one without, and say which measured signal you used in the reason."
      : "",
    focus?.trim() ? `The person asked for: ${focus.trim()}` : "",
    'Answer with JSON only: [{"start": <seconds from the start of the video>, "end": <seconds>, "title": "<max 60 characters, no quotes>", "reason": "<one short sentence: why this moment works>"}]',
  ]
    .filter(Boolean)
    .join(" ");

  const list = windows
    .map((w, i) => {
      const snippet = snippets[i];
      const said = (snippet ?? "").trim();
      const tail = said
        ? `“${said.slice(0, 400)}”`
        : snippet === null
          ? "(could not be listened to — judge it on its place in the video alone)"
          : "(no speech heard — music, silence or background)";
      const measured = (evidence?.[i] ?? []).filter(Boolean);
      const measuredText = measured.length ? ` MEASURED: ${measured.join("; ")}.` : "";
      return `${i + 1}. ${clockRange(w)} — ${tail}${measuredText}`;
    })
    .join("\n");
  const user = [
    `The video is ${Math.round(windows.reduce((m, w) => Math.max(m, w.end), 0))} seconds long.`,
    "",
    list,
    "",
    `Pick ${clampCount(count)} and answer with the JSON array only.`,
  ].join("\n");
  return { system, user };
}

/** "1:05–1:50" — how a window is written for the picker and the chat. */
export function clockRange(w: VideoWindow): string {
  return `${clock(w.start)}–${clock(w.end)}`;
}

/** "1:05" / "1:02:03" — seconds as a clock. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/**
 * Reads the picker's answer. Tolerant on purpose: models wrap JSON in prose,
 * give end times outside the video, or return overlapping moments — anything
 * unusable is dropped (the caller falls back to the loudest windows).
 */
export function parsePickerReply(text: string, durationSec: number, count: number): ClipPick[] {
  const raw = typeof text === "string" ? text : "";
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const picks: ClipPick[] = [];
  for (const entry of parsed) {
    const pick = normalizePick(entry, durationSec);
    if (pick) picks.push(pick);
  }
  return withoutOverlaps(picks, count);
}

export interface ScoredWindow {
  window: VideoWindow;
  /** How much this moment is worth — measured interest, the sound, or both. */
  score: number;
}

/**
 * Turns scored candidate moments into up to `count` clip ranges that do not
 * share footage, best moment first.
 *
 * This is the step that makes "clip the parts people actually watched" work: a
 * measured peak and the talking stretch around it overlap, and the old rules
 * (drop anything that overlaps) threw one of them away. Here the better-scoring
 * candidate keeps its place and the other is *moved* past it — sharing a
 * moment's footage between two clips is what is forbidden, not cutting two
 * neighbouring moments. A candidate that cannot keep a full clip after being
 * moved is dropped, and `preset` ranges (the model's own picks, which carry
 * titles and reasons) are respected as if already chosen.
 */
export function selectClips(
  candidates: ScoredWindow[],
  durationSec: number,
  count: number,
  opts: { minSeconds?: number; maxSeconds?: number; gapSec?: number; preset?: VideoWindow[] } = {},
): VideoWindow[] {
  const minSeconds = opts.minSeconds ?? MIN_CLIP_SECONDS;
  const maxSeconds = opts.maxSeconds ?? MAX_CLIP_SECONDS;
  const gap = opts.gapSec ?? 1.5;
  const want = clampCount(count);
  const taken: VideoWindow[] = [...(opts.preset ?? [])]
    .map((w) => ({ start: round3(Math.max(0, w.start)), end: round3(Math.min(durationSec, Math.max(w.start, w.end))) }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);

  /** Does this range share footage with anything already chosen? */
  const clashes = (range: VideoWindow) => taken.some((other) => range.start < other.end + gap && range.end > other.start - gap);
  const fit = (from: number, to: number): VideoWindow | null => {
    const start = Math.max(0, Math.min(from, durationSec));
    const end = Math.min(durationSec, Math.max(to, start));
    if (end - start < minSeconds) return null;
    const range = { start: round3(start), end: round3(end) };
    return clashes(range) ? null : range;
  };

  /**
   * Where a candidate's clip goes. In order of preference: where the candidate
   * is (a clip at the end of the video is allowed to be shorter than a full
   * one rather than dragged backwards into footage another clip already uses),
   * then just after what is in the way, then just before it. Nothing that fits
   * is a dropped moment, not a fragment.
   */
  const place = (window: VideoWindow): VideoWindow | null => {
    const length = clipLength(window, durationSec, minSeconds, maxSeconds);
    const natural = fit(window.start, window.start + length);
    if (natural) return natural;
    const blocker = taken.find((other) => window.start < other.end + gap && window.start + length > other.start - gap);
    if (blocker) {
      const after = fit(blocker.end + gap, blocker.end + gap + length);
      if (after) return after;
      // End just short of what is in the way: the clip keeps the moment it can
      // and gives up the overlap, rather than the moment being dropped.
      const beforeEnd = blocker.start - gap;
      const before = fit(beforeEnd - length, beforeEnd);
      if (before) return before;
    }
    return null;
  };

  const chosen: Array<{ window: VideoWindow; score: number }> = [];
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.window.start - b.window.start);
  for (const candidate of ranked) {
    // `taken` holds the preset ranges and every clip chosen so far — the number
    // of clips already decided is exactly its length.
    if (taken.length >= want) break;
    const clip = place(candidate.window);
    if (!clip) continue;
    chosen.push({ window: clip, score: candidate.score });
    taken.push(clip);
    taken.sort((a, b) => a.start - b.start);
  }
  return chosen.map((entry) => entry.window);
}

/**
 * Nudges overlapping picks apart instead of dropping them: the later one starts
 * just after the earlier one ends, so two clips taken from neighbouring moments
 * (a measured peak and the talking that overlaps it) both survive with no
 * shared footage. A pick that cannot keep a full clip after being moved is
 * dropped — a truncated fragment is worse than one fewer short.
 *
 * This exists because candidate windows are allowed to overlap once measured
 * peaks join them (see mergeWindows), while a finished clip must not.
 */
export function trimOverlaps(picks: ClipPick[], durationSec: number, minSeconds = MIN_CLIP_SECONDS, gapSec = 1.5): ClipPick[] {
  const sorted = [...picks].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: ClipPick[] = [];
  for (const pick of sorted) {
    const previous = out[out.length - 1];
    let start = Math.max(0, pick.start);
    if (previous && start < previous.end + gapSec) start = previous.end + gapSec;
    let end = Math.max(start, pick.end);
    // Keep the pick's own length where the video allows it.
    const wanted = Math.max(minSeconds, Math.min(MAX_CLIP_SECONDS, pick.end - pick.start));
    if (end - start < wanted) end = Math.min(durationSec, start + wanted);
    if (end - start < minSeconds) continue;
    out.push({ ...pick, start: round3(start), end: round3(end) });
  }
  return out;
}

/**
 * Drops picks that share words with one already kept (the model sometimes
 * returns the same moment twice), then caps the list. The first pick wins —
 * the model puts its favourites first.
 */
export function withoutOverlaps(picks: ClipPick[], count?: number): ClipPick[] {
  const out: ClipPick[] = [];
  for (const pick of picks) {
    if (count !== undefined && out.length >= clampCount(count)) break;
    if (out.some((kept) => overlaps(kept, pick))) continue;
    out.push(pick);
  }
  return out;
}

/** One entry from the model, made safe: inside the video, 12–59 s, title trimmed. */
export function normalizePick(entry: unknown, durationSec: number): ClipPick | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { start?: unknown; end?: unknown; title?: unknown; reason?: unknown };
  const rawStart = Number(e.start);
  if (!Number.isFinite(rawStart)) return null;
  const total = Math.max(0, durationSec);
  if (total < MIN_CLIP_SECONDS) return null;
  const rawEnd = Number(e.end);
  const hasEnd = Number.isFinite(rawEnd) && rawEnd > rawStart;
  // A "moment" the model itself calls shorter than a clip is a misread, not a
  // clip: stretching it to 12 s would be padding. No end at all is fine.
  if (hasEnd && rawEnd - rawStart < MIN_CLIP_SECONDS) return null;
  // Keep the start inside the video; when no end was given, slide it back so a
  // full clip still fits at the very end.
  const startAt = Math.max(0, Math.min(rawStart, Math.max(0, total - MIN_CLIP_SECONDS)));
  const wanted = hasEnd ? rawEnd - rawStart : MAX_CLIP_SECONDS;
  const length = Math.max(MIN_CLIP_SECONDS, Math.min(MAX_CLIP_SECONDS, Math.min(wanted, total - startAt)));
  const title = typeof e.title === "string" ? e.title.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  const reason = typeof e.reason === "string" ? e.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return { start: round3(startAt), end: round3(startAt + length), title, reason };
}

function overlaps(a: ClipPick, b: ClipPick): boolean {
  const gap = 1.5; // two seconds of air between clips is fine, sharing words isn't
  return a.start < b.end + gap && b.start < a.end + gap;
}

/** Picks in the order they happen in the video (the chat reads better that way). */
export function inVideoOrder(picks: ClipPick[]): ClipPick[] {
  return [...picks].sort((a, b) => a.start - b.start);
}

/**
 * The spoken words as caption cues. Whisper gives one block of text per window,
 * so the words are grouped into short lines and the window's time is shared out
 * by how much there is to read — the standard way burned captions are timed
 * without word-level timings.
 */
export function captionCues(
  text: string,
  startSec: number,
  endSec: number,
  maxWords = MAX_CAPTION_WORDS,
): Array<{ start: number; end: number; text: string }> {
  const words = (typeof text === "string" ? text : "").split(/\s+/).filter(Boolean);
  const total = Math.max(0, endSec - startSec);
  if (!words.length || total <= 0) return [];

  // A line may run a couple of words past the cap to finish its sentence —
  // chopping "Coffee is the best." into "Coffee is the" / "best." reads badly.
  const hardWords = maxWords + 2;
  const hardChars = MAX_CAPTION_CHARS + 8;
  const lines: string[] = [];
  let line: string[] = [];
  for (const word of words) {
    const next = [...line, word];
    const chars = next.join(" ").length;
    const sentenceEnd = /[.!?…]$/.test(word) && next.length <= hardWords && chars <= hardChars;
    if (line.length && (next.length > maxWords || chars > MAX_CAPTION_CHARS || sentenceEnd)) {
      if (sentenceEnd) {
        line = next; // a sentence that ends here belongs on this line
        lines.push(line.join(" "));
        line = [];
        continue;
      }
      lines.push(line.join(" "));
      line = [word];
      continue;
    }
    line = next;
    if (sentenceEnd) {
      lines.push(line.join(" "));
      line = [];
    }
  }
  if (line.length) lines.push(line.join(" "));

  const totalChars = lines.reduce((n, l) => n + l.length, 0) || 1;
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let at = startSec;
  lines.forEach((l, i) => {
    const share = (l.length / totalChars) * total;
    const isLast = i === lines.length - 1;
    const end = isLast ? endSec : Math.min(endSec, Math.max(at + MIN_CAPTION_SECONDS, at + share));
    cues.push({ start: round3(at), end: round3(Math.max(end, at + 0.2)), text: l });
    at = end;
  });
  return cues;
}

/** The file name a rendered clip gets (safe on every OS). */
export function clipFileName(index: number, title: string, jobId?: string): string {
  const slug = (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = jobId ? `_${jobId}` : "";
  return `soundwave_clip_${index + 1}${slug ? `_${slug}` : ""}${suffix}.mp4`;
}

function clampCount(n: number): number {
  const value = Number.isFinite(n) ? Math.round(n) : DEFAULT_CLIPS;
  return Math.max(1, Math.min(MAX_CLIPS, value));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Finding the moments worth clipping (no model involved) ──────────────────
// A fixed grid cuts wherever 45 seconds happen to end — often mid-sentence,
// sometimes on a pause, once on a quiet stretch of nothing. What actually
// makes a moment clippable is audible: someone is talking, they finish a
// thought, it is livelier than the rest of the video, and (with a transcript)
// they make a promise, ask a question or tell a story instead of doing
// housekeeping. All of that is local signal, so the highlight search costs
// nothing and still beats clipping by wall-clock. The pipeline reads the whole
// video's sound into an energy profile once (lib/videoClips.ts) and this file
// turns it into candidate moments, scores them, and snaps a model's picks onto
// the same speech boundaries.

/** The energy profile's resolution: fine enough for a sentence end, cheap over hours. */
export const PROFILE_FRAME_MS = 100;
/**
 * A gap shorter than this is inside a sentence — a breath, a word boundary —
 * so speechRuns bridges it rather than ending the run. A gap longer than it is
 * a pause: where one thought ends and the next begins, and where a clip cuts.
 */
export const SPEECH_BRIDGE_SECONDS = 0.32;
/** Shorter than this isn't speech, it's a cough or a door. */
export const MIN_SPEECH_SECONDS = 0.7;
/** Frames 9 dB over the video's own noise floor are someone talking. */
export const SPEECH_RISE_DB = 9;
/** Most videos don't need more candidates than this; a long one gets the busiest. */
export const MAX_CANDIDATES = 60;
/** Fallback picks come from different parts of the video at least this far apart. */
export const PICK_MIN_GAP_SECONDS = 12;

export interface AudioProfile {
  durationSec: number;
  frameMs: number;
  /** RMS level per frame, dBFS. */
  db: number[];
  /** The video's own noise floor (10th percentile). */
  floorDb: number;
  /** Above this is speech. */
  thresholdDb: number;
  /** The level talking usually happens at (median of the speech frames). */
  speechDb: number;
}

export interface SpeechRun {
  start: number;
  end: number;
}

export interface MomentFeatures {
  /** Share of the window someone is talking (0–1). */
  speechRatio: number;
  /** How loud against this video's own talking level (0–1, 0.5 = usual). */
  loudness: number;
  /** How much the level moves — laughter, applause, excitement (0–1). */
  dynamics: number;
  /** Whether the words in it were heard and can be judged. */
  heard: boolean;
  /** Promise/question/story signals in the words ("how", "never", "I tried"). */
  hooks: number;
  /** Housekeeping and throat-clearing in the words ("welcome back", "um"). */
  fillers: number;
}

/** Words that tend to open a moment people keep watching. */
const HOOK_PATTERNS: RegExp[] = [
  /\bhow (i|we|you|to)\b/,
  /\bwhy\b/,
  /\bwhat (if|most|nobody|happens)\b/,
  /\bthe (one|only|best|worst|biggest|fastest|easiest|hardest|real|truth|secret|problem|reason|trick|mistake)\b/,
  /\b(nobody|everyone|most people|no one)\b/,
  /\bhere'?s (the|what|how|why)\b/,
  /\bthis is (the|why|how|what)\b/,
  /\byou (can|should|need|won'?t|will|don'?t|have to|probably)\b/,
  /\b(never|always|stop|listen|imagine|watch this)\b/,
  /\b(i (learned|tried|tested|spent|made|built|lost|found|discovered)|we (tried|tested|found|learned))\b/,
  /\b(proven|studies show|research shows|turns out|the truth is)\b/,
  /\d+\s*(percent|%)/,
  /\$\s?\d/,
];

/** Words that open a moment nobody keeps watching. */
const FILLER_PATTERNS: RegExp[] = [
  /\b(welcome back|in this video|before we (get )?start|let me (just )?(say|explain|show)|as i (said|mentioned)|anyway)\b/,
  /\b(um+|uh+|erm+)\b/,
  /\byou know\b/,
  /\b(like and subscribe|hit the bell|link in the (description|bio)|sponsor(s|ed)?)\b/,
];

/** How many promise-signals and filler-signals a line of speech carries. */
export function highlightSignals(text: string): { hooks: number; fillers: number } {
  const said = (typeof text === "string" ? text : "").toLowerCase();
  if (!said.trim()) return { hooks: 0, fillers: 0 };
  let hooks = 0;
  for (const pattern of HOOK_PATTERNS) if (pattern.test(said)) hooks++;
  if (/\?/.test(said)) hooks++; // a question is a hook
  const words = said.split(/\s+/).filter(Boolean).length;
  if (words < 6) hooks = Math.max(0, hooks - 1); // a two-word line can't stand alone
  let fillers = 0;
  for (const pattern of FILLER_PATTERNS) if (pattern.test(said)) fillers++;
  return { hooks, fillers };
}

/** The frames' distribution turned into the video's own floor, threshold and talking level. */
function summarizeFrames(db: number[], durationSec: number, frameMs: number): AudioProfile {
  const sorted = [...db].sort((a, b) => a - b);
  const floorDb = sorted[Math.floor(sorted.length * 0.1)] ?? -70;
  const thresholdDb = Math.max(floorDb + SPEECH_RISE_DB, -52);
  const voiced = db.filter((d) => d > thresholdDb).sort((a, b) => a - b);
  const speechDb = voiced.length ? voiced[Math.floor(voiced.length * 0.5)]! : thresholdDb;
  return {
    durationSec: round3(durationSec),
    frameMs,
    db,
    floorDb: round3(floorDb),
    thresholdDb: round3(thresholdDb),
    speechDb: round3(speechDb),
  };
}

export interface ProfileAccumulator {
  /** Feed the next chunk of 16-bit mono PCM, in order. */
  push(chunk: Int16Array): void;
  /** Samples fed so far. */
  samples(): number;
  /** The finished profile. Call once, after the last chunk. */
  finish(): AudioProfile;
}

/**
 * The energy profile, built one chunk at a time.
 *
 * A video's PCM is the largest thing this pipeline touches — 16 kHz mono
 * 16-bit is 32 kB per second, so an hour is 115 MB and the four hours
 * lib/videoClips.ts will read is 460 MB. Holding all of it (and a copy of it,
 * and an Int16Array of it) to work out a hundred floats a second is what made
 * clipping a long video a gigabyte of RAM on a machine that is also rendering.
 * The frames are all that's needed to find the moments, so they are computed
 * as the sound arrives and the samples themselves go to a temporary file to be
 * read back one window at a time (lib/videoClips.ts).
 */
export function createProfileAccumulator(sampleRate: number, frameMs = PROFILE_FRAME_MS): ProfileAccumulator {
  const rate = Math.max(1, sampleRate);
  const frameLen = Math.max(1, Math.round((rate * frameMs) / 1000));
  const db: number[] = [];
  let pending = 0;
  let pendingSum = 0;
  let total = 0;

  const closeFrame = () => {
    db.push(10 * Math.log10(pendingSum / Math.max(1, pending) + 1e-12));
    pending = 0;
    pendingSum = 0;
  };

  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const v = chunk[i]! / 32768;
        pendingSum += v * v;
        if (++pending === frameLen) closeFrame();
      }
      total += chunk.length;
    },
    samples: () => total,
    finish() {
      // A partial frame at the end still says something; nothing at all (an
      // empty or silent read) is one hushed frame, as a whole-video read was.
      if (pending > 0) closeFrame();
      if (!db.length) db.push(10 * Math.log10(1e-12));
      return summarizeFrames(db, total / rate, frameMs);
    },
  };
}

/** The whole video's sound as 100 ms RMS levels — the basis for everything below. */
export function audioProfile(pcm: Int16Array, sampleRate: number, frameMs = PROFILE_FRAME_MS): AudioProfile {
  const accumulator = createProfileAccumulator(sampleRate, frameMs);
  accumulator.push(pcm);
  return accumulator.finish();
}

/** Where someone is talking: frames over the floor, short gaps bridged, blips dropped. */
export function speechRuns(profile: AudioProfile): SpeechRun[] {
  const frameSec = Math.max(0.01, profile.frameMs / 1000);
  const bridge = Math.max(1, Math.round(SPEECH_BRIDGE_SECONDS / frameSec)); // inside-word gaps
  const runs: SpeechRun[] = [];
  let from = -1;
  let last = -1;
  const close = () => {
    if (from >= 0 && last >= from) {
      const run = { start: round3(from * frameSec), end: round3((last + 1) * frameSec) };
      if (run.end - run.start >= MIN_SPEECH_SECONDS) runs.push(run);
    }
    from = -1;
    last = -1;
  };
  for (let i = 0; i < profile.db.length; i++) {
    if (profile.db[i]! > profile.thresholdDb) {
      if (from === -1) from = i;
      last = i;
    } else if (from !== -1 && i - last > bridge) {
      close();
    }
  }
  close();
  return runs;
}

/**
 * Moments to consider clipping, built from speech instead of a grid: a
 * candidate opens on a speech onset and closes on the pause furthest along
 * that still fits a Short — so a cut lands where a thought starts and ends,
 * not wherever 45 seconds happened to run out. Falls back to the grid when
 * nobody measured above the floor (music, nature footage).
 */
export function momentsFor(profile: AudioProfile): VideoWindow[] {
  const runs = speechRuns(profile);
  const found = candidateWindows(runs, profile.durationSec);
  return found.length ? found : planWindows(profile.durationSec);
}

/** See momentsFor: the candidates themselves, given the speech runs. */
export function candidateWindows(runs: SpeechRun[], durationSec: number, opts: { maxCandidates?: number } = {}): VideoWindow[] {
  const total = Math.max(0, durationSec);
  if (total < MIN_CLIP_SECONDS || !runs.length) return [];
  const cap = Math.max(1, opts.maxCandidates ?? MAX_CANDIDATES);
  const out: VideoWindow[] = [];
  for (let i = 0; i < runs.length; i++) {
    const rawStart = runs[i]!.start;
    // A speech burst nearer the end than a Short is long: slide the moment
    // back so a full clip still fits, rather than dropping the video's tail.
    const start = Math.min(rawStart, total - MIN_CLIP_SECONDS);
    // The furthest pause that still fits: long enough to be a Short, short
    // enough to be one, and ending where the speaker stopped for a breath.
    let end = start + MIN_CLIP_SECONDS;
    for (let j = i; j < runs.length; j++) {
      const stop = Math.min(total, runs[j]!.end);
      if (stop - start < MIN_CLIP_SECONDS) {
        end = Math.max(end, stop);
        continue;
      }
      if (stop - start > MAX_CLIP_SECONDS) break;
      end = stop;
    }
    end = Math.min(total, Math.max(end, start + MIN_CLIP_SECONDS));
    if (end - start > MAX_CLIP_SECONDS) end = start + MAX_CLIP_SECONDS;
    const previous = out[out.length - 1];
    if (previous && start - previous.start < 1.5) continue; // the same moment again
    out.push({ start: round3(start), end: round3(end) });
  }
  if (out.length <= cap) return out;
  // More candidates than worth measuring: keep the busiest (most speech), in order.
  const speechSeconds = (w: VideoWindow) =>
    runs.reduce((ms, r) => ms + Math.max(0, Math.min(w.end, r.end) - Math.max(w.start, r.start)), 0);
  return out
    .map((w) => ({ w, speech: speechSeconds(w) }))
    .sort((a, b) => b.speech - a.speech)
    .slice(0, cap)
    .map((x) => x.w)
    .sort((a, b) => a.start - b.start);
}

/**
 * Speech windows and the audience's own peaks in one candidate list, in video
 * order. Only *the same moment twice* is collapsed: a window whose middle sits
 * within a couple of seconds of another's is a duplicate (the heat peak inside
 * a talking stretch), while overlapping but different moments are both kept —
 * two peaks twenty seconds apart are two clips, even when the talking around
 * them overlaps. Clips are pulled apart later, in trimOverlaps.
 *
 * This is how a measured peak becomes a candidate even when nobody talks over
 * it: the audio used to be the only thing that could nominate a moment.
 */
export function mergeWindows(windows: VideoWindow[], durationSec: number, max = MAX_CANDIDATES): VideoWindow[] {
  const clean = windows
    .map((w) => ({ start: Math.max(0, Math.min(w.start, w.end)), end: Math.min(durationSec, Math.max(w.start, w.end)) }))
    .filter((w) => w.end - w.start >= 1)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: VideoWindow[] = [];
  for (const w of clean) {
    // A window inside another is the same moment, described less precisely
    // (candidateWindows already returns a wide window and one of its halves).
    const contained = merged.find((k) => k.start <= w.start + 1 && k.end >= w.end - 1);
    if (contained) {
      contained.start = round3(Math.min(contained.start, w.start));
      contained.end = round3(Math.max(contained.end, w.end));
      continue;
    }
    // It may also *contain* earlier windows, which then say nothing extra.
    for (let i = merged.length - 1; i >= 0; i--) {
      const k = merged[i]!;
      if (w.start <= k.start + 1 && w.end >= k.end - 1) merged.splice(i, 1);
    }
    merged.push({ start: round3(w.start), end: round3(w.end) });
  }
  if (merged.length <= max) return merged;
  // Over the cap: the widest windows carry the most material, keep those.
  const keep = new Set(
    [...merged]
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, max)
      .map((w) => w.start),
  );
  return merged.filter((w) => keep.has(w.start)).sort((a, b) => a.start - b.start);
}

/** What the profile (and the words, when they were heard) says about a window. */
export function momentFeatures(window: VideoWindow, profile: AudioProfile, text?: string): MomentFeatures {
  const frameSec = Math.max(0.01, profile.frameMs / 1000);
  const from = Math.max(0, Math.floor(window.start / frameSec));
  const to = Math.min(profile.db.length, Math.ceil(window.end / frameSec));
  const frames = profile.db.slice(from, Math.max(from, to));
  const voiced = frames.filter((d) => d > profile.thresholdDb);
  const speechRatio = frames.length ? voiced.length / frames.length : 0;
  const mean = voiced.length ? voiced.reduce((a, b) => a + b, 0) / voiced.length : profile.floorDb;
  // 24 dB around this video's own talking level: quiet talk and shouts both count.
  const loudness = clamp01(0.5 + (mean - profile.speechDb) / 24);
  const dynamics = voiced.length ? clamp01(stdDev(voiced) / 4) : 0;
  const signals = highlightSignals(text ?? "");
  return {
    speechRatio: clamp01(speechRatio),
    loudness,
    dynamics,
    heard: Boolean(text && text.trim()),
    hooks: signals.hooks,
    fillers: signals.fillers,
  };
}

/**
 * How good a moment is. Audio alone can already tell a wall of talking from a
 * quiet intro; the words raise the ceiling, because a promise, a question or a
 * story beats a loud patch of nothing-saying every time.
 */
export function momentScore(f: MomentFeatures): number {
  const audio = clamp01(f.speechRatio) * 0.3 + clamp01(f.loudness) * 0.12 + clamp01(f.dynamics) * 0.18;
  if (!f.heard) return round3(clamp01(audio)); // 0–0.6: never beats a heard moment that says something
  const hooks = Math.min(1, f.hooks / 3);
  const fillers = Math.min(1, f.fillers / 2);
  // 0.2 for a complete thought with no filler, and 0.2 more for promises.
  return round3(clamp01(audio + 0.2 * hooks + 0.2 * (1 - fillers)));
}

/** Why a locally-picked moment was picked (shown in the chat next to the clip). */
export function momentReason(f: MomentFeatures): string {
  const bits: string[] = [];
  if (f.speechRatio >= 0.8) bits.push("talking almost the whole time");
  else if (f.speechRatio >= 0.5) bits.push("plenty of talking");
  if (f.loudness >= 0.65) bits.push("louder than the rest of the video");
  if (f.dynamics >= 0.6) bits.push("a lively stretch");
  if (f.heard && f.hooks >= 2) bits.push("opens with a promise or a question");
  if (f.heard && f.fillers === 0) bits.push("no filler");
  return bits.length ? `picked on this PC: ${bits.join(", ")}` : "picked on this PC: a clear stretch of talking between pauses";
}

/**
 * The picks without asking a model: the best moments, from parts of the video
 * far enough apart that the shorts don't repeat each other; when a short video
 * can't space them out, neighbours are fair as long as the clips themselves
 * don't share footage.
 *
 * Both rules are judged on the clip a window actually becomes, not on where the
 * window starts: a window shorter than a clip is padded out to one, so two
 * neighbours can overlap however far apart their starts looked.
 */
export function pickMoments(
  windows: VideoWindow[],
  scores: number[],
  durationSec: number,
  count: number,
  minGapSec = PICK_MIN_GAP_SECONDS,
): ClipPick[] {
  const want = clampCount(count);
  const ranked = rankWindows(windows, scores);
  const clipOf = (i: number): ClipPick => {
    const w = windows[i]!;
    const length = clipLength(w, durationSec);
    return { start: round3(w.start), end: round3(w.start + length), title: "", reason: "" };
  };
  const chosen: ClipPick[] = [];
  const same = (pick: ClipPick) => chosen.some((kept) => kept.start === pick.start && kept.end === pick.end);
  const apart = (pick: ClipPick) =>
    chosen.every((kept) => pick.start >= kept.end + minGapSec || kept.start >= pick.end + minGapSec);
  const disjoint = (pick: ClipPick) => chosen.every((kept) => pick.end <= kept.start || pick.start >= kept.end);

  for (const i of ranked) {
    if (chosen.length >= want) break;
    const pick = clipOf(i);
    if (apart(pick)) chosen.push(pick);
  }
  for (const i of ranked) {
    if (chosen.length >= want) break;
    const pick = clipOf(i);
    if (!same(pick) && disjoint(pick)) chosen.push(pick);
  }
  return inVideoOrder(chosen);
}

/**
 * Moves a moment's edges onto the nearest speech boundaries within a couple of
 * seconds — how a model's pick stops starting mid-word. Never changes the
 * length limits, and leaves the moment alone when no boundary is near.
 */
export function snapToSpeech(window: VideoWindow, runs: SpeechRun[], toleranceSec = 2.5, durationSec = Number.POSITIVE_INFINITY): VideoWindow {
  const tol = Math.max(0, toleranceSec);
  const total = Number.isFinite(durationSec) ? Math.max(0, durationSec) : Number.POSITIVE_INFINITY;
  if (!runs.length) return window;
  const nearest = (values: number[], to: number): number | null => {
    let best: number | null = null;
    for (const value of values) {
      if (Math.abs(value - to) > tol) continue;
      if (best === null || Math.abs(value - to) < Math.abs(best - to)) best = value;
    }
    return best;
  };
  let start = nearest(runs.map((r) => r.start), window.start) ?? window.start;
  let end = nearest(runs.map((r) => r.end), window.end) ?? window.end;
  start = Math.max(0, Math.min(start, total));
  end = Math.min(total, end);
  if (end - start < MIN_CLIP_SECONDS) end = start + MIN_CLIP_SECONDS;
  if (end - start > MAX_CLIP_SECONDS) end = start + MAX_CLIP_SECONDS;
  return { start: round3(start), end: round3(end) };
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(variance);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
