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
