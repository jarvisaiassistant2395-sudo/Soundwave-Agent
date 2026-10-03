// ── "Eyes": turning what the internet hands us into text the agent can read ──
// Pure rules, no I/O and no imports (like the rest of core/): WebVTT captions →
// flowing transcript, HTML → readable text, and the cap that keeps a tool
// result from swallowing the whole context window. The fetching lives in
// lib/eyes.ts and the yt-dlp plumbing in lib/ytdlp.ts.

/** Entity table for the handful that actually show up in captions and pages. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#039": "'",
  "#x27": "'",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name in ENTITIES) return ENTITIES[name]!;
    if (/^#x/i.test(name)) {
      const code = parseInt(name.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    if (/^#/.test(name)) {
      const code = parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** "00:01:02.500" (or "01:02.500") → seconds. */
function cueSeconds(stamp: string): number {
  const parts = stamp.trim().replace(",", ".").split(":").map((p) => parseFloat(p));
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  return parts.reduce((total, p) => total * 60 + p, 0);
}

/** The words of a caption line with markup, timings and karaoke tags gone. */
function cueText(line: string): string {
  return decodeEntities(
    line
      .replace(/<[^>]*>/g, "")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/**
 * WebVTT → plain text.
 *
 * YouTube's automatic captions are the awkward case: cues arrive as rolling
 * duplicates ("we're going" / "we're going to talk about"), so consecutive
 * lines are merged by dropping any cue the next one already starts with, and
 * exact repeats are dropped outright. Manual captions come out as sentences.
 */
export function vttToText(vtt: string): string {
  const lines = (vtt ?? "").split(/\r?\n/);
  const spoken: string[] = [];
  let lastStamp = "";
  let inNote = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line) || /^Kind:|^Language:/i.test(line)) continue;
    if (/^NOTE\b/i.test(line)) {
      inNote = true;
      continue;
    }
    if (inNote) {
      // A note ends at a blank line, which the loop already skipped — so a note
      // is a single cue-less block; treat any following timing line as a reset.
      if (!/-->/.test(line)) continue;
      inNote = false;
    }
    const timing = /^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->/.exec(line);
    if (timing) {
      lastStamp = timing[1]!;
      // Everything after the arrow is the END stamp and cue settings
      // ("align:start position:0%") — never words. Treating them as a caption
      // read the end time out loud, so they go first.
      const inline = line
        .replace(/^.*?-->/, " ")
        .replace(/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}/g, " ")
        .replace(/\b(align|line|position|size|region|vertical|kind|role):\S+/gi, " ")
        .trim();
      const text = cueText(inline);
      if (text) pushCue(spoken, text);
      continue;
    }
    if (/^\d+$/.test(line)) continue; // cue index
    void lastStamp;
    // A bare caption line, or the second half of a cue (some exports wrap).
    pushCue(spoken, cueText(line));
  }
  return mergeSpoken(spoken);
}

/** Rolling-window auto-captions repeat themselves; only keep what's new. */
function pushCue(out: string[], text: string): void {
  if (!text) return;
  const previous = out[out.length - 1];
  if (!previous) {
    out.push(text);
    return;
  }
  if (previous === text) return;
  if (previous.endsWith(text)) return;
  if (text.startsWith(previous)) {
    out[out.length - 1] = text; // the same line, a word further along
    return;
  }
  // A tail-overlap rule used to cut repeated heads here ("…into the cave" +
  // "the cave is dark" → "is dark"). It read well until a caption legitimately
  // began with words the previous one ended on, and then it silently ate them —
  // losing a few words of what someone said is worse than reading one twice.
  out.push(text);
}

function mergeSpoken(cues: string[]): string {
  const joined = cues
    .map((c) => c.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Auto captions often break mid-sentence with no punctuation — stitch short
  // fragments into readable paragraphs so a summary has something to hold on to.
  if (!joined) return "";
  const sentences = joined
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const paragraphs: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    current = current ? `${current} ${sentence}` : sentence;
    if (/[.!?]$/.test(sentence) && current.length > 320) {
      paragraphs.push(current);
      current = "";
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.join("\n\n");
}

/**
 * HTML → readable text: scripts, styles, chrome and tags removed, block-level
 * elements turned into line breaks, entities decoded, whitespace collapsed.
 */
export function htmlToText(html: string): string {
  const withoutHidden = (html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|form|aside)[\s\S]*?<\/\1>/gi, " ");
  const withBreaks = withoutHidden
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withBreaks)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

/** The page's <title>, if it has one. */
export function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html ?? "");
  return match ? decodeEntities(match[1]!).replace(/\s+/g, " ").trim() : "";
}

export interface Capped {
  text: string;
  truncated: boolean;
}

/** Keep a tool result readable: cut on a word boundary and say that it was cut. */
export function capText(text: string, max: number): Capped {
  const clean = (text ?? "").trim();
  if (clean.length <= max) return { text: clean, truncated: false };
  const cut = clean.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return { text: `${(boundary > max * 0.5 ? cut.slice(0, boundary) : cut).trim()}…`, truncated: true };
}

/** "12:34" / "1:02:03" — for saying how long a video is. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, "0");
  return hours ? `${hours}:${mm}:${String(seconds).padStart(2, "0")}` : `${mm}:${String(seconds).padStart(2, "0")}`;
}
