// ── From a written script to the pictures, sounds and cards on screen ───────
// The storyboard itself (which beats, when, what they say) is brain/core/
// storyboard.ts — pure, shared, model-agnostic. This is the part that has to
// touch the world: it asks Gemini to plan the beats around the narration's own
// sentences, looks the photos up on Wikimedia Commons, builds the sound effects
// with ffmpeg, lays the cards out in pixels for the resolution being rendered,
// and hands the lot to the renderer as one MediaInput.
//
// Every single step is allowed to fail without failing the short. No Gemini
// key → the template storyboard. No photo found → that beat is a card instead.
// No ffmpeg for the effects → the short renders silent-but-voiced. A render
// that produces a video is worth more than a plan that was perfect.
//
// The person can turn pieces of it off (the "Viral edit" switch in the
// generator, or `enhance: false` through the API/tool): photos, sound effects
// and the camera move are each optional, and with all of them off the render is
// byte-for-byte what Soundwave made before this existed.

import { generateContent, isGemini3, visibleText } from "./gemini.js";
import { activeBrain, FALLBACK_MODEL } from "./settings.js";
import {
  beatWindows,
  parseStoryboard,
  PHOTO_BOX,
  sentencesFromTimings,
  SFX_CATALOG,
  storyboardBrief,
  storyboardSummary,
  templateStoryboard,
  type SentenceAnchor,
  type Storyboard,
  type StoryboardSummary,
} from "./core/storyboard.js";
import { ensurePulse, ensureSfx } from "../sfx.js";
import { resolvePhotoPlan, type PhotoProvider } from "../photos.js";
import type { CardInput, MediaInput, SoundEventInput } from "../ffmpeg.js";

export interface ShortMediaOptions {
  script: string;
  timings: Array<{ word: string; start: number; end: number }>;
  duration: number;
  topic: string;
  nicheId?: string;
  seconds?: number;
  /** The frame being rendered — the layout is worked out in these pixels. */
  width: number;
  height: number;
  /** The trend findings the script was written to, when the scout had any. */
  trends?: string[];
  /** What the person asked for. All default to on. */
  photos?: boolean;
  sounds?: boolean;
  motion?: boolean;
  music?: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Test seams: where the photos/effects are cached, and who supplies them. */
  photoDir?: string;
  sfxDir?: string;
  provider?: PhotoProvider;
  fetchImpl?: typeof fetch;
}

export interface ShortMediaPlan {
  storyboard: Storyboard;
  summary: StoryboardSummary;
  media: MediaInput;
  /** The photo credits, for the description of the published short. */
  credits: string[];
  /** One line per decision, for the job record — what the edit actually did. */
  notes: string[];
  /** Where the storyboard came from. */
  source: "gemini" | "template";
}

async function writeStoryboard(opts: ShortMediaOptions, anchors: SentenceAnchor[]): Promise<string | null> {
  const brain = activeBrain();
  if (!brain) return null;
  const instruction = storyboardBrief({
    script: opts.script,
    sentences: anchors,
    topic: opts.topic,
    ...(opts.nicheId ? { niche: opts.nicheId } : {}),
    seconds: Math.round(opts.seconds ?? opts.duration),
    photos: opts.photos !== false,
    ...(opts.trends?.length ? { trends: opts.trends } : {}),
  });
  const models = [...new Set([brain.model, FALLBACK_MODEL])];
  for (const model of models) {
    try {
      const resp = await generateContent({
        apiKey: brain.apiKey,
        model,
        purpose: "storyboard",
        // The same script, topic and trends want the same storyboard: a retry
        // after a crash doesn't re-plan a different video (and a second click is free).
        cache: true,
        signal: opts.signal,
        timeoutMs: 45_000,
        request: {
          contents: [
            {
              role: "user",
              parts: [{ text: `Topic: ${opts.topic}\n\nNarration:\n${opts.script}` }],
            },
          ],
          systemInstruction: { role: "user", parts: [{ text: instruction }] },
          generationConfig: {
            maxOutputTokens: 2048,
            ...(isGemini3(model) ? { thinkingConfig: { thinkingLevel: "LOW" as const } } : {}),
          },
        },
      });
      const text = visibleText(resp.candidates?.[0]?.content?.parts);
      if (text.trim()) return text;
    } catch (err) {
      // Quota, network, a blocked answer: the template plan is a good short too.
      opts.log?.(`storyboard via ${model} failed: ${(err as Error).message}`);
    }
  }
  return null;
}

/** The pixel box a photo card gets, from the picture's own proportions. */
export function photoCardBox(
  width: number,
  height: number,
  photo: { width: number; height: number },
): { width: number; x: number; y: number } {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const boxW = width * PHOTO_BOX.widthFrac;
  const boxH = height * PHOTO_BOX.heightFrac;
  // An unknown (0×0) size is treated as 16:9 — the commonest shape a photo
  // library returns, and the one that stays clear of the captions.
  const aspect = photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 16 / 9;
  const cardWidth = even(Math.min(boxW, boxH * aspect));
  return { width: cardWidth, x: Math.round((width - cardWidth) / 2), y: Math.round(height * PHOTO_BOX.topFrac) };
}

/**
 * Everything a storyboard render needs, or as much of it as could be had.
 * Never throws: a plan with no pictures and no sounds is still a plan, and the
 * renderer is happy to draw just the captions and cards.
 */
export async function planShortMedia(opts: ShortMediaOptions): Promise<ShortMediaPlan> {
  const wantPhotos = opts.photos !== false;
  const wantSounds = opts.sounds !== false;
  const wantMusic = opts.music !== false && wantSounds;
  const notes: string[] = [];

  // 1. The narration's own sentences, with the seconds the voice says them.
  const anchors = sentencesFromTimings(opts.timings, opts.duration);
  const normalizeOpts = {
    duration: opts.duration,
    anchors,
    photos: wantPhotos,
    fallbackHook: opts.topic,
  };

  // 2. The beats: written by Gemini for this script, else built from it.
  let storyboard: Storyboard | null = null;
  let source: "gemini" | "template" = "template";
  const raw = await writeStoryboard(opts, anchors);
  if (raw) {
    storyboard = parseStoryboard(raw, normalizeOpts);
    if (storyboard) source = "gemini";
    else notes.push("the written storyboard wasn't usable — planned from the script instead");
  }
  if (!storyboard) {
    storyboard = templateStoryboard({
      topic: opts.topic,
      sentences: anchors,
      duration: opts.duration,
      photos: wantPhotos,
      music: wantMusic ? "pulse" : "none",
    });
  }
  const windows = beatWindows(storyboard, opts.duration);

  // 3. The pictures. One search per photo beat, resolved in beat order.
  const photoRequests = windows
    .map((w, index) => ({ beatIndex: index, query: w.beat.kind === "photo" ? (w.beat.imageQuery ?? "") : "" }))
    .filter((r) => r.query);
  const resolved = wantPhotos
    ? await resolvePhotoPlan({
        requests: photoRequests,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.photoDir ? { dir: opts.photoDir } : {}),
        log: opts.log,
      })
    : { images: [], credits: [], notes: [] };
  notes.push(...resolved.notes);

  const images: MediaInput["images"] = resolved.images.map((image) => {
    const window = windows[image.beatIndex]!;
    const box = photoCardBox(opts.width, opts.height, image.photo);
    return { path: image.filePath, start: window.start, end: window.end, ...box };
  });

  // 4. The sounds: one per beat that asked for one, plus the opening riser.
  const sounds: SoundEventInput[] = [];
  if (wantSounds) {
    for (const window of windows) {
      const kind = window.beat.sfx;
      if (!kind) continue;
      const path = await ensureSfx(kind, opts.sfxDir);
      if (path) sounds.push({ path, at: window.start, gain: SFX_CATALOG[kind].gain });
      else notes.push(`the ${kind} effect couldn't be built here — rendering without it`);
    }
    // Every energetic edit opens on a riser: it is what makes the first second
    // feel like a lift rather than a start.
    if (storyboard.music === "pulse" && !windows.some((w) => w.beat.sfx === "riser")) {
      const path = await ensureSfx("riser", opts.sfxDir);
      if (path) sounds.unshift({ path, at: 0, gain: SFX_CATALOG.riser.gain });
    }
  }
  const musicPath = wantMusic && storyboard.music === "pulse" ? await ensurePulse(opts.sfxDir) : null;

  // 5. The words on the cards, in the layout each kind gets (lib/ffmpeg.ts).
  const cards: CardInput[] = [];
  for (const window of windows) {
    const { beat, start, end } = window;
    const held = Math.max(start + 0.4, end);
    if (beat.kind === "hook") cards.push({ kind: "hook", start, end: held, text: (beat.text ?? "").toUpperCase() });
    else if (beat.kind === "cta") cards.push({ kind: "cta", start, end: held, text: beat.text ?? "Follow for more", accent: "#22D3EE" });
    else if (beat.kind === "stat") cards.push({ kind: "stat", start, end: held, text: beat.text ?? "", accent: "#22D3EE" });
    // A photo keeps its label only when the picture actually made it in —
    // a caption under an empty frame is worse than no caption.
    else if (images.some((img) => img.start === start) && beat.imageCaption)
      cards.push({ kind: "photo", start, end: held, text: beat.imageCaption });
  }

  // 6. The camera move: a punch-in on each beat when the edit is energetic,
  //    a slow drift when it is calm, nothing when the person turned it off.
  const motionKind: MediaInput["motion"] =
    opts.motion === false
      ? { kind: "none" }
      : storyboard.music === "pulse"
        ? { kind: "pulse", pulses: windows.filter((w) => w.beat.kind === "photo" || w.beat.kind === "stat").map((w) => w.start) }
        : { kind: "drift" };

  const flashes = windows.filter((w) => w.beat.flash).map((w) => (w.start <= 0 ? 0.04 : w.start)).slice(0, 2);

  const media: MediaInput = {
    ...(images.length ? { images } : {}),
    ...(sounds.length ? { sounds } : {}),
    ...(musicPath ? { music: { path: musicPath, gain: 0.07, duck: true } } : {}),
    ...(cards.length ? { cards } : {}),
    motion: motionKind,
    ...(flashes.length ? { flashes } : {}),
  };

  const summary = storyboardSummary(storyboard);
  notes.unshift(
    `${source === "gemini" ? "storyboard" : "storyboard (from the script)"}: ${summary.beats} beats, ${summary.photos} photos, ${summary.sounds + (musicPath ? 1 : 0)} sounds`,
  );
  return { storyboard, summary, media, credits: resolved.credits, notes, source };
}
