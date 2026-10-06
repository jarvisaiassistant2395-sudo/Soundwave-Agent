// ── The storyboard: the plan that turns a narration into a real short ───────
// Until now a Soundwave short was three layers: gameplay, a voice, and burned
// captions — nothing ever *changed* on screen, and nothing punctuated what the
// voice was saying. A short that holds a viewer cuts on the beat of the words:
// a hook card in the first second, a photo that pops in exactly when the
// narrator says the thing it shows, a whoosh under the cut, an impact under the
// hook, a beat under all of it, and a card at the end that asks for the follow.
//
// This module is that plan and nothing else: no filesystem, no network, no
// Gemini. It is the shared vocabulary between the model that writes the plan
// (brain/shortMedia.ts), the renderer that draws it (lib/ffmpeg.ts) and the
// phone/desktop UI that shows the person what a short is made of. Pure
// TypeScript, so both apps and the tests can use it.
//
// Timing is the whole game. Every beat is anchored to a *sentence* of the
// script — the same sentences the voiceover's own word timings produce — so a
// photo lands on the sentence it illustrates instead of on a guessed second.
// When the plan comes from Gemini it is normalized against those anchors
// (snapped, clamped, de-duplicated, capped); when there is no key, the
// template below builds a plan that is already correct by construction.

export type SfxKind = "riser" | "whoosh" | "impact" | "pop" | "ding" | "hit" | "sub";

/** Every sound the renderer can mix. The recipes live in lib/sfx.ts. */
export const SFX_KINDS: SfxKind[] = ["riser", "whoosh", "impact", "pop", "ding", "hit", "sub"];

export function isSfxKind(value: unknown): value is SfxKind {
  return typeof value === "string" && (SFX_KINDS as string[]).includes(value);
}

export interface SfxInfo {
  label: string;
  /** When to reach for it — this is what the model is told. */
  when: string;
  /** The level it is mixed at (the narration is 1.0). */
  gain: number;
}

export const SFX_CATALOG: Record<SfxKind, SfxInfo> = {
  riser: { label: "Riser", when: "under the first second, lifting into the hook", gain: 0.5 },
  whoosh: { label: "Whoosh", when: "the moment a photo or card cuts in", gain: 0.55 },
  impact: { label: "Impact", when: "on the hook itself — the loudest punctuation in the short", gain: 0.8 },
  pop: { label: "Pop", when: "a small card, number or sticker appears", gain: 0.5 },
  ding: { label: "Ding", when: "the callback at the end, under the follow card", gain: 0.65 },
  hit: { label: "Hit", when: "the turn of the story — the sentence that changes everything", gain: 0.55 },
  sub: { label: "Sub drop", when: "a low swell under a reveal; use it twice at most", gain: 0.45 },
};

export type BeatKind = "hook" | "photo" | "stat" | "cta";

export interface StoryboardBeat {
  kind: BeatKind;
  /** Seconds into the short. Snapped to a sentence start (see above). */
  at: number;
  /** How long it stays on screen; the next beat ends it when absent. */
  hold?: number;
  /** The words on the card (hook / stat / cta) or the label under a photo. */
  text?: string;
  /** What to look a photo up by (photo beats). */
  imageQuery?: string;
  /** The burned-on label under the photo, when it differs from the beat text. */
  imageCaption?: string;
  sfx?: SfxKind;
  /** A white flash cut on the frame it appears (a hard cut, not a fade). */
  flash?: boolean;
}

export interface Storyboard {
  beats: StoryboardBeat[];
  /** A generated percussion bed under the narration ("none" for calm subjects). */
  music: "none" | "pulse";
  source: "gemini" | "template";
}

// ── Shape and limits ────────────────────────────────────────────────────────
export const MAX_BEATS = 10;
export const MAX_PHOTOS = 6;
export const MAX_SFX = 8;
/** Two sounds closer than this read as one broken noise. */
export const MIN_SFX_GAP = 0.9;
export const HOOK_HOLD = 1.9;
export const PHOTO_HOLD = 2.4;
export const CTA_HOLD = 2.6;
/** The shortest a card may be up: below this it flashes rather than reads. */
export const MIN_HOLD = 1.2;
/** How far a beat may be dragged to land on a sentence start. */
export const SNAP_WINDOW = 0.9;

/** Where a photo card sits in the frame (fractions of the frame). */
export const PHOTO_BOX = { widthFrac: 0.72, heightFrac: 0.44, topFrac: 0.09 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const clean = (raw: unknown, max: number): string =>
  typeof raw === "string"
    ? raw
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

export interface SentenceAnchor {
  text: string;
  start: number;
  end: number;
}

/**
 * The sentences of the narration with the times the voice says them, read out
 * of the voiceover's own word timings. A sentence ends after a word that ends
 * in closing punctuation, or at a clear pause (a longer gap than the voice
 * takes between words inside a sentence) — the same pauses a person hears.
 */
export function sentencesFromTimings(
  timings: Array<{ word: string; start: number; end: number }>,
  duration: number,
  opts: { pauseGap?: number; maxWords?: number } = {},
): SentenceAnchor[] {
  const pauseGap = opts.pauseGap ?? 0.42;
  const maxWords = opts.maxWords ?? 42;
  const out: SentenceAnchor[] = [];
  let text: string[] = [];
  let start = 0;
  let end = 0;
  const flush = () => {
    const joined = text.join(" ").trim();
    if (joined) out.push({ text: joined, start, end });
    text = [];
  };
  for (let i = 0; i < timings.length; i++) {
    const word = timings[i]!;
    if (!text.length) start = Math.max(0, word.start);
    text.push(word.word);
    end = word.end;
    const next = timings[i + 1];
    const endsSentence = /[.!?…]["'”’)\]]?$/.test(word.word.trim());
    const longPause = Boolean(next) && next!.start - word.end > pauseGap;
    if (endsSentence || longPause || text.length >= maxWords) flush();
  }
  flush();
  if (!out.length) {
    // No timings (a silent or oddly-timed voiceover): one sentence, the whole
    // timeline. A plan built on this still renders — it just has one anchor.
    return [{ text: "", start: 0, end: Math.max(0.5, duration) }];
  }
  // The last sentence can run past the audio by a hair (TTS rounds); the
  // timeline is the audio's, so keep every anchor inside it.
  return out.map((s) => ({
    ...s,
    start: clamp(s.start, 0, Math.max(0, duration)),
    end: clamp(s.end, 0, Math.max(0, duration)),
  }));
}

/** The sentence whose start is closest to `at`, when one is close enough. */
export function snapToSentence(at: number, anchors: SentenceAnchor[], window = SNAP_WINDOW): number {
  let best = at;
  let bestGap = window;
  for (const a of anchors) {
    const gap = Math.abs(a.start - at);
    if (gap < bestGap) {
      bestGap = gap;
      best = a.start;
    }
  }
  return Math.max(0, Math.round(best * 100) / 100);
}

// ── The deterministic plan (no Gemini needed) ───────────────────────────────
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those", "it", "its", "is",
  "are", "was", "were", "be", "been", "being", "am", "as", "at", "by", "for", "from", "in", "into", "of", "on",
  "onto", "to", "with", "without", "you", "your", "yours", "they", "them", "their", "theirs", "he", "she", "his",
  "her", "hers", "we", "us", "our", "i", "me", "my", "mine", "not", "no", "so", "do", "does", "did", "done",
  "can", "could", "will", "would", "just", "about", "because", "when", "where", "while", "what", "which", "who",
  "how", "why", "there", "here", "every", "each", "most", "more", "much", "many", "some", "any", "all", "one",
  "two", "still", "even", "only", "also", "very", "really", "actually", "get", "got", "gets", "make", "makes",
  "made", "have", "has", "had", "keep", "keeps", "kept", "go", "goes", "went", "come", "comes", "came", "see",
  "sees", "saw", "say", "says", "said", "tell", "tells", "told", "know", "knows", "knew", "think", "thinks",
]);

/**
 * What to search a photo for, out of a sentence: the concrete words first
 * ("brain scans" beats "the"), longest first — they are the ones a photo
 * library answers. Three words is the sweet spot: a Commons search with more
 * returns nothing.
 */
export function salientWords(sentence: string, max = 3): string {
  const words = sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const scored = words.map((w, i) => ({ w, score: w.length + (i < 8 ? 2 : 0) }));
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => words.indexOf(a.w) - words.indexOf(b.w))
    .map((s) => s.w)
    .join(" ");
}

/** The number in a sentence, with the words around it — a card worth popping. */
export function statPhrase(sentence: string): string | null {
  const m = /(\$?\d[\d.,]*\s?(?:%|percent|million|billion|thousand|k|x)?(?:\s(?:times|years|people|degrees|seconds|hours|days))?)/i.exec(sentence);
  if (!m) return null;
  const hit = m[1]!.trim();
  // "1" alone is not interesting; a card needs something a viewer can hold.
  if (hit.replace(/\D/g, "").length < 2 && !/[%$]/.test(hit)) return null;
  const words = sentence.split(/\s+/);
  const idx = words.findIndex((w) => w.includes(hit.split(" ")[0]!));
  const around = words.slice(Math.max(0, idx - 3), idx + 4).join(" ").replace(/[.,!?]+$/, "");
  return clean(around, 64) || hit;
}

/** Two lines of at most ~34 characters, which is what fits a hook card. */
export function cardLines(text: string, maxChars = 68): string {
  const cleanText = clean(text, maxChars * 2);
  if (cleanText.length <= maxChars) return cleanText;
  const words = cleanText.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > 34 && line) {
      lines.push(line.trim());
      line = w;
    } else {
      line = `${line} ${w}`.trim();
    }
  }
  if (line) lines.push(line.trim());
  return lines.slice(0, 2).join("\n");
}

export interface TemplateStoryboardInput {
  topic: string;
  sentences: SentenceAnchor[];
  duration: number;
  /** Whether photos can be sourced at all (the person may have turned them off). */
  photos?: boolean;
  music?: "none" | "pulse";
}

/**
 * A storyboard built from the narration itself, with no model in the loop —
 * what renders when there is no Gemini key (and the fallback when a written
 * storyboard comes back unusable). It is deliberately conservative: a hook
 * card, a photo every other sentence, a number card when a sentence has one,
 * a callback at the end, and the sounds that go with them.
 */
export function templateStoryboard(input: TemplateStoryboardInput): Storyboard {
  const { topic, sentences, duration } = input;
  const photos = input.photos !== false;
  const beats: StoryboardBeat[] = [];

  const first = sentences[0];
  const hookText = first && first.text.length > 12 ? first.text : `The truth about ${topic.trim() || "this"}`;
  beats.push({ kind: "hook", at: 0, hold: HOOK_HOLD, text: cardLines(hookText, 64), sfx: "impact", flash: true });

  if (photos) {
    // Every other sentence after the hook: enough movement without a slideshow.
    for (let i = 1; i < sentences.length; i += 2) {
      const s = sentences[i]!;
      const query = salientWords(s.text);
      if (!query) continue;
      const stat = i > 1 ? statPhrase(s.text) : null;
      if (stat && i % 4 === 1) {
        beats.push({ kind: "stat", at: s.start, hold: PHOTO_HOLD, text: cardLines(stat, 64), sfx: "pop", flash: false });
      } else {
        beats.push({
          kind: "photo",
          at: s.start,
          hold: PHOTO_HOLD,
          imageQuery: query,
          imageCaption: cardLines(s.text, 70),
          sfx: "whoosh",
          flash: false,
        });
      }
    }
  }

  const ctaAt = Math.max(HOOK_HOLD, duration - CTA_HOLD);
  beats.push({ kind: "cta", at: ctaAt, hold: CTA_HOLD, text: "Follow for more", sfx: "ding" });

  return normalizeStoryboard({ beats, music: input.music ?? "pulse", source: "template" }, { duration, photos });
}

// ── Normalizing a written plan ──────────────────────────────────────────────
export interface NormalizeOptions {
  duration: number;
  anchors?: SentenceAnchor[];
  photos?: boolean;
  /** The card to fall back on when the plan has no hook (usually the topic). */
  fallbackHook?: string;
  ctaText?: string;
  maxBeats?: number;
}

function normalizeBeat(raw: StoryboardBeat, opts: NormalizeOptions): StoryboardBeat | null {
  const kind: BeatKind = (["hook", "photo", "stat", "cta"] as BeatKind[]).includes(raw.kind) ? raw.kind : "photo";
  if (kind === "photo" && !clean(raw.imageQuery, 80)) return null;
  if (kind !== "photo" && !clean(raw.text, 120)) return null;
  const maxAt = Math.max(0, opts.duration - MIN_HOLD);
  const snapped = opts.anchors?.length ? snapToSentence(raw.at, opts.anchors) : raw.at;
  // Nothing appears under the hook card: it owns the first two seconds (and
  // with it the top of the frame), so a photo or stat waiting there would
  // either hide it or land on it.
  const floor = kind === "hook" ? 0 : HOOK_HOLD;
  const at = clamp(Number.isFinite(snapped) ? snapped : floor, floor, Math.max(floor, maxAt));
  const hold = clamp(typeof raw.hold === "number" && raw.hold > 0 ? raw.hold : kind === "hook" ? HOOK_HOLD : kind === "cta" ? CTA_HOLD : PHOTO_HOLD, MIN_HOLD, Math.max(MIN_HOLD, opts.duration));
  return {
    kind,
    at: Math.round(at * 100) / 100,
    hold: Math.round(hold * 100) / 100,
    ...(kind === "photo"
      ? {
          imageQuery: clean(raw.imageQuery, 80),
          ...(clean(raw.imageCaption ?? raw.text, 70) ? { imageCaption: cardLines(clean(raw.imageCaption ?? raw.text, 70), 70) } : {}),
        }
      : { text: cardLines(clean(raw.text, 120), kind === "hook" ? 64 : 72) }),
    ...(isSfxKind(raw.sfx) ? { sfx: raw.sfx } : {}),
    ...(raw.flash === true ? { flash: true } : {}),
  };
}

/**
 * A plan that will actually render: inside the timeline, on the sentences,
 * no more than a handful of beats, photos capped, sounds spaced, a hook at the
 * start and a follow card before the end. Everything downstream (the renderer,
 * the UI, the job record) can assume a normalized storyboard.
 */
export function normalizeStoryboard(sb: Storyboard, opts: NormalizeOptions): Storyboard {
  const photos = opts.photos !== false;
  const maxBeats = opts.maxBeats ?? MAX_BEATS;
  let beats = (Array.isArray(sb.beats) ? sb.beats : [])
    .map((b) => normalizeBeat(b, opts))
    .filter((b): b is StoryboardBeat => Boolean(b))
    .filter((b) => photos || b.kind !== "photo")
    .sort((a, b) => a.at - b.at);

  // One hook, at the start. A written plan that forgot it gets the fallback.
  const hookText = beats.find((b) => b.kind === "hook")?.text ?? cardLines(opts.fallbackHook ?? "Wait for it", 64);
  const hook: StoryboardBeat = { kind: "hook", at: 0, hold: HOOK_HOLD, text: hookText, sfx: "impact" };
  beats = [hook, ...beats.filter((b) => b.kind !== "hook")];

  // One follow card, at the end.
  const cta: StoryboardBeat = { kind: "cta", at: Math.max(HOOK_HOLD, opts.duration - CTA_HOLD), hold: CTA_HOLD, text: opts.ctaText ?? beats.find((b) => b.kind === "cta")?.text ?? "Follow for more", sfx: "ding" };
  beats = [...beats.filter((b) => b.kind !== "cta"), cta];

  // Photos: keep the ones spread widest, so dropping never bunches the rest up.
  const photoBeats = beats.filter((b) => b.kind === "photo");
  if (photoBeats.length > MAX_PHOTOS) {
    const keep = new Set(
      [...photoBeats]
        .sort((a, b) => a.at - b.at)
        .filter((_, i) => i % Math.ceil(photoBeats.length / MAX_PHOTOS) === 0)
        .slice(0, MAX_PHOTOS)
        .map((b) => `${b.at}:${b.imageQuery}`),
    );
    beats = beats.filter((b) => b.kind !== "photo" || keep.has(`${b.at}:${b.imageQuery}`));
  }

  // Too many beats reads as a slide deck: drop from the middle, never the hook
  // or the follow card, and never a beat the sounds below depend on.
  if (beats.length > maxBeats) {
    const keepFirst = beats.slice(0, 2);
    const keepLast = beats.slice(-2);
    const middle = beats
      .slice(2, -2)
      .filter((_, i, arr) => i % Math.ceil(arr.length / Math.max(1, maxBeats - 4 + 1)) === 0)
      .slice(0, Math.max(0, maxBeats - 4));
    beats = [...keepFirst, ...middle, ...keepLast].sort((a, b) => a.at - b.at);
  }

  // The follow card is the last word — a stat or a photo label running under it
  // is two texts fighting for the same band of the frame, so those beats are
  // trimmed to end before it (and dropped when there is no room left). This
  // happens *before* the sounds are placed: a whoosh on a beat that is about to
  // be dropped used to eat the follow card's own ding.
  const ordered = [...beats].sort((a, b) => a.at - b.at);
  const ctaStart = ordered.find((b) => b.kind === "cta")?.at ?? opts.duration;
  beats = ordered.filter((b) => b.kind === "hook" || b.kind === "cta" || b.at + MIN_HOLD <= ctaStart);

  // Sounds: one at a time, spaced, capped. The hook keeps its own.
  const used: number[] = [];
  beats = beats.map((b) => {
    if (!b.sfx) return b;
    if (used.length >= MAX_SFX) return { ...b, sfx: undefined };
    const clash = used.some((t) => Math.abs(t - b.at) < MIN_SFX_GAP);
    if (clash && b.kind !== "hook") return { ...b, sfx: undefined };
    used.push(b.at);
    return b;
  });

  // Holds: a beat stays up until the next one, but never less than MIN_HOLD.
  const windows = beats.map((b, i) => {
    const next = beats[i + 1];
    const natural = next ? next.at - b.at : opts.duration - b.at;
    const untilCta = b.kind === "cta" ? opts.duration : ctaStart - b.at;
    const hold = clamp(Math.min(b.hold ?? PHOTO_HOLD, natural || MIN_HOLD, Math.max(MIN_HOLD, untilCta)), MIN_HOLD, opts.duration);
    return { ...b, hold: Math.round(hold * 100) / 100 };
  });

  const music = sb.music === "none" ? "none" : "pulse";
  return { beats: windows, music, source: sb.source };
}

export interface BeatWindow {
  beat: StoryboardBeat;
  start: number;
  end: number;
}

/** Each beat with the window it is on screen for (the renderer's timeline). */
export function beatWindows(sb: Storyboard, duration: number, fadeOut = 0.25): BeatWindow[] {
  return sb.beats.map((beat) => {
    const start = clamp(beat.at, 0, Math.max(0, duration));
    const hold = beat.hold ?? PHOTO_HOLD;
    const end = clamp(start + hold, start + MIN_HOLD, duration);
    return { beat, start: Math.round(start * 100) / 100, end: Math.round(Math.max(start + 0.2, end - fadeOut) * 100) / 100 };
  });
}

export interface StoryboardSummary {
  beats: number;
  photos: number;
  cards: number;
  sounds: number;
  music: "none" | "pulse";
  /** The photo searches, in the order they appear (for the job record / UI). */
  searches: string[];
}

export function storyboardSummary(sb: Storyboard): StoryboardSummary {
  const photos = sb.beats.filter((b) => b.kind === "photo");
  return {
    beats: sb.beats.length,
    photos: photos.length,
    cards: sb.beats.filter((b) => b.kind !== "photo").length,
    sounds: sb.beats.filter((b) => b.sfx).length,
    music: sb.music,
    searches: photos.map((b) => b.imageQuery ?? "").filter(Boolean),
  };
}

/**
 * What the model is asked for. It gets the narration, the sentences with the
 * exact seconds the voice says them, and the sound menu — and returns JSON and
 * nothing else (parseStoryboard below is deliberately forgiving about fences
 * and prose around it, because models add both).
 */
export function storyboardBrief(input: {
  script: string;
  sentences: SentenceAnchor[];
  topic: string;
  niche?: string;
  seconds: number;
  photos?: boolean;
  /** The trend findings the script was written to, when there were any. */
  trends?: string[];
}): string {
  const photos = input.photos !== false;
  const timeline = input.sentences.map((s) => `  ${s.start.toFixed(2)}–${s.end.toFixed(2)}s  ${s.text}`).join("\n");
  const sounds = SFX_KINDS.map((k) => `- "${k}" — ${SFX_CATALOG[k].when}`).join("\n");
  return [
    "You are the editor of a vertical Short (1080×1920) that is already written and narrated. Your job is the STORYBOARD: what is on screen besides the gameplay, and when.",
    "",
    `Topic: ${input.topic}`,
    ...(input.niche ? [`Niche: ${input.niche}`] : []),
    `Length: about ${input.seconds} seconds. The narration (do not change a word of it):`,
    '"""',
    input.script,
    '"""',
    "",
    "The sentences and the exact seconds the voice says them:",
    timeline,
    "",
    "Rules — a viewer decides in the first second and leaves when the screen stops moving:",
    ...(photos
      ? [
          "- Open with a `hook` card: the promise of the short in at most 6 words, uppercase-friendly, no hashtags. It covers the first two seconds, with an impact.",
          "- A `photo` beat wherever the narration names something you can show. Its `imageQuery` is 2–3 concrete, literal English words a stock-photo search answers (\"brain scan\", \"molten lava\", \"cardboard box\") — never an abstract phrase, never the topic repeated. `imageCaption` is at most 8 words, in the narrator's voice.",
          "- A `stat` beat instead of a photo when a sentence carries a number that is the point of the sentence (text: the number and what it counts, at most 8 words).",
        ]
      : ["- No photos are available for this render: use `hook`, `stat` and `cta` cards only."]),
    "- Put a beat on a sentence start from the list above, never between them, and give each beat 2–3 seconds — a photo that changes every second is a strobe.",
    `- At most ${MAX_BEATS} beats in total, at most ${MAX_PHOTOS} of them photos. Fewer, better beats win.`,
    "- Close with a `cta` card: at most 4 words, a reason to follow (\"Part 2 tomorrow\", \"Follow for more\").",
    "- Sounds: at most one per beat, from this menu, and only where they land:",
    sounds,
    '- `music`: "pulse" for energy, "none" for a calm or sad subject.',
    '- `flash`: true on at most two beats — the hard cut is a spice, not the dish.',
    "",
    "Answer with JSON only, exactly this shape:",
    photos
      ? '{"music":"pulse"|"none","beats":[{"kind":"hook"|"photo"|"stat"|"cta","at":<seconds>,"hold":<seconds>,"text":"<card words>","imageQuery":"<2-3 words, photo beats>","imageCaption":"<label under the photo>","sfx":"<kind>","flash":<true|false>}]}'
      : '{"music":"pulse"|"none","beats":[{"kind":"hook"|"stat"|"cta","at":<seconds>,"hold":<seconds>,"text":"<card words>","sfx":"<kind>","flash":<true|false>}]}',
  ].join("\n");
}

/** The JSON inside a model's answer, fences and prose included. */
export function extractJsonObject(raw: string): unknown {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1]?.trim() || text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * A model's answer as a plan, or null when there is nothing usable in it. Every
 * field is treated as hostile: kinds are whitelisted, timings clamped to the
 * audio and snapped to the narration's own sentences, text length-capped, and
 * the result is normalized (hook, follow card, caps, spacing) before it is
 * handed on. A bad answer costs a storyboard, never a render.
 */
export function parseStoryboard(raw: unknown, opts: NormalizeOptions & { music?: unknown }): Storyboard | null {
  const data = typeof raw === "string" ? extractJsonObject(raw) : raw;
  if (!data || typeof data !== "object") return null;
  const body = data as { beats?: unknown; music?: unknown };
  if (!Array.isArray(body.beats) || !body.beats.length) return null;
  const beats: StoryboardBeat[] = [];
  for (const entry of body.beats.slice(0, MAX_BEATS * 2)) {
    if (!entry || typeof entry !== "object") continue;
    const b = entry as Record<string, unknown>;
    const kind = typeof b.kind === "string" ? (b.kind.toLowerCase() as BeatKind) : "photo";
    if (!(["hook", "photo", "stat", "cta"] as string[]).includes(kind)) continue;
    beats.push({
      kind,
      at: typeof b.at === "number" && Number.isFinite(b.at) ? b.at : 0,
      ...(typeof b.hold === "number" && Number.isFinite(b.hold) ? { hold: b.hold } : {}),
      ...(typeof b.text === "string" ? { text: b.text } : {}),
      ...(typeof b.imageQuery === "string" ? { imageQuery: b.imageQuery } : {}),
      ...(typeof b.imageCaption === "string" ? { imageCaption: b.imageCaption } : {}),
      ...(isSfxKind(b.sfx) ? { sfx: b.sfx } : {}),
      ...(b.flash === true ? { flash: true } : {}),
    });
  }
  if (!beats.length) return null;
  // A plan whose every beat was unusable is not a plan: the caller falls back
  // to the built-in one instead of rendering an empty timeline with a hook on it.
  const usable = beats
    .map((b) => normalizeBeat(b, opts))
    .filter((b): b is StoryboardBeat => Boolean(b));
  if (!usable.length) return null;
  const music = body.music === "none" ? "none" : "pulse";
  return normalizeStoryboard({ beats: usable, music, source: "gemini" }, opts);
}
