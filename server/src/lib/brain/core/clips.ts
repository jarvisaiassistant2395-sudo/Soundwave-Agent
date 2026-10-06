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

export interface WindowLevels {
  /** How long someone was talking in that window (ms). */
  voicedMs: number;
  /** Loudest sample in the window, dBFS. */
  peakDb: number;
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

/**
 * How promising a window sounds: how much of it is speech, and how loud it is
 * (a quiet stretch is usually an intro, a pause or a screen share).
 */
export function windowScore(window: VideoWindow, levels: WindowLevels | undefined): number {
  const lengthMs = Math.max(1, (window.end - window.start) * 1000);
  const voiced = Math.min(1, Math.max(0, (levels?.voicedMs ?? 0) / lengthMs));
  // peakDb is dBFS (0 = full scale): -40 dB or quieter counts as "hushed".
  const loudness = Math.min(1, Math.max(0, ((levels?.peakDb ?? -60) + 40) / 40));
  return voiced * 0.75 + loudness * 0.25;
}

/** Window indices, most promising first. */
export function rankWindows(windows: VideoWindow[], scores: number[]): number[] {
  return windows
    .map((_, i) => i)
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);
}

/** How long a clip should be: the window, or the longest a Short may be. */
export function clipLength(window: VideoWindow, durationSec: number): number {
  const available = Math.min(durationSec - window.start, window.end - window.start);
  return Math.max(MIN_CLIP_SECONDS, Math.min(MAX_CLIP_SECONDS, available));
}

/**
 * The picks when there's no brain to ask (no key): the most promising windows,
 * spread out so three clips don't come from the same minute.
 */
export function fallbackPicks(windows: VideoWindow[], scores: number[], durationSec: number, count: number): ClipPick[] {
  const want = clampCount(count);
  const ranked = rankWindows(windows, scores);
  const chosen: number[] = [];
  // First the promising windows that aren't next to each other (three clips
  // somewhere in a long video, not three from the same minute)…
  for (const i of ranked) {
    if (chosen.length >= want) break;
    if (chosen.some((j) => Math.abs(j - i) <= 1)) continue;
    chosen.push(i);
  }
  // …then, in a short video where that isn't enough, neighbours are fair:
  // their clips don't overlap (a window is at most as long as a clip).
  for (const i of ranked) {
    if (chosen.length >= want) break;
    if (chosen.includes(i)) continue;
    chosen.push(i);
  }
  return chosen
    .sort((a, b) => a - b)
    .map((i) => {
      const w = windows[i]!;
      const length = clipLength(w, durationSec);
      return { start: round3(w.start), end: round3(w.start + length), title: "", reason: "" };
    });
}

/**
 * What Gemini is asked: numbered windows with what is said in them, and the
 * shape of the answer (JSON, one entry per short).
 */
export function buildPickerAsk(
  windows: VideoWindow[],
  snippets: Array<string | null>,
  count: number,
  focus?: string,
): { system: string; user: string } {
  const system = [
    "You are a short-form video editor. You are given windows of a long video, in order, with what is said in each one.",
    `Pick the ${clampCount(count)} best moments to cut into vertical YouTube Shorts (each ${MIN_CLIP_SECONDS}–${MAX_CLIP_SECONDS} seconds).`,
    "Choose moments that stand on their own: a hook, a surprising fact, a strong opinion, a laugh, a clear explanation — not introductions, housekeeping or half-finished thoughts.",
    "Prefer moments where the speaker's own words make the point; the captions are burned in, so the words matter.",
    focus?.trim() ? `The person asked for: ${focus.trim()}` : "",
    'Answer with JSON only: [{"start": <seconds from the start of the video>, "end": <seconds>, "title": "<max 60 characters, no quotes>", "reason": "<one short sentence: why this moment works>"}]',
  ]
    .filter(Boolean)
    .join(" ");

  const list = windows
    .map((w, i) => {
      const said = (snippets[i] ?? "").trim();
      return `${i + 1}. ${clockRange(w)} — ${said ? `“${said.slice(0, 400)}”` : "(no speech heard — music, silence or background)"}`;
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
/** A gap this long is a pause — where one thought ends and the next begins. */
export const PAUSE_SECONDS = 0.45;
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

/** The whole video's sound as 100 ms RMS levels — the basis for everything below. */
export function audioProfile(pcm: Int16Array, sampleRate: number, frameMs = PROFILE_FRAME_MS): AudioProfile {
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const count = Math.max(1, Math.ceil(pcm.length / frameLen));
  const db: number[] = new Array(count);
  for (let f = 0; f < count; f++) {
    const from = f * frameLen;
    const to = Math.min(pcm.length, from + frameLen);
    let sum = 0;
    for (let i = from; i < to; i++) {
      const v = pcm[i]! / 32768;
      sum += v * v;
    }
    db[f] = 10 * Math.log10(sum / Math.max(1, to - from) + 1e-12);
  }
  const durationSec = pcm.length / Math.max(1, sampleRate);
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

/** Where someone is talking: frames over the floor, short gaps bridged, blips dropped. */
export function speechRuns(profile: AudioProfile): SpeechRun[] {
  const frameSec = Math.max(0.01, profile.frameMs / 1000);
  const bridge = Math.max(1, Math.round(0.32 / frameSec)); // inside-word gaps
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
 * can't space them out, neighbours are fair (clips never overlap anyway).
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
  const chosen: number[] = [];
  for (const i of ranked) {
    if (chosen.length >= want) break;
    const start = windows[i]!.start;
    if (chosen.some((j) => Math.abs(windows[j]!.start - start) < minGapSec)) continue;
    chosen.push(i);
  }
  for (const i of ranked) {
    if (chosen.length >= want) break;
    if (!chosen.includes(i)) chosen.push(i);
  }
  return chosen
    .sort((a, b) => windows[a]!.start - windows[b]!.start)
    .map((i) => {
      const w = windows[i]!;
      const length = clipLength(w, durationSec);
      return { start: round3(w.start), end: round3(w.start + length), title: "", reason: "" };
    });
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
