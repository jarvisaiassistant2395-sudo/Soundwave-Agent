// ── The storyboard: the plan that turns a narration into a real edit ────────
// Everything here is pure (no ffmpeg, no network, no model), which is the
// point: the timing rules — beats land on the sentences the voice speaks,
// nothing collides with the hook or the follow card, sounds are spaced — are
// checked on their own, before a single frame is rendered.
import { describe, expect, it } from "vitest";

import {
  beatWindows,
  cardLines,
  extractJsonObject,
  HOOK_HOLD,
  MAX_BEATS,
  MAX_PHOTOS,
  MIN_HOLD,
  MIN_SFX_GAP,
  normalizeStoryboard,
  parseStoryboard,
  salientWords,
  sentencesFromTimings,
  SFX_CATALOG,
  SFX_KINDS,
  snapToSentence,
  statPhrase,
  storyboardBrief,
  storyboardSummary,
  templateStoryboard,
  type Storyboard,
} from "../src/lib/brain/core/storyboard.js";

/** Word timings for a script, as the TTS gives them (words, ~2.5/s). */
function timingsFor(words: string[], secondsPerWord = 0.3, startAt = 0.1) {
  const out: Array<{ word: string; start: number; end: number }> = [];
  let t = startAt;
  for (const word of words) {
    out.push({ word, start: t, end: t + secondsPerWord * 0.85 });
    t += secondsPerWord;
  }
  return out;
}

const SCRIPT =
  "Your brain is lying to you about time. When you are scared, it takes 20 percent more snapshots per second. " +
  "That is why a crash feels like slow motion. Your memory is not a recording. It is a story you retell yourself.";
const WORDS = SCRIPT.split(" ");
const TIMINGS = timingsFor(WORDS);
const DURATION = 12;

describe("reading the narration's own sentences", () => {
  it("cuts them where the voice stops, and keeps every anchor inside the audio", () => {
    const anchors = sentencesFromTimings(TIMINGS, DURATION);
    expect(anchors.length).toBeGreaterThanOrEqual(4);
    expect(anchors[0]!.text.startsWith("Your brain is lying to you about time.")).toBe(true);
    expect(anchors[1]!.text.startsWith("When you are scared")).toBe(true);
    for (const a of anchors) {
      expect(a.start).toBeGreaterThanOrEqual(0);
      expect(a.end).toBeLessThanOrEqual(DURATION);
      expect(a.end).toBeGreaterThanOrEqual(a.start);
    }
    // In order, non-overlapping.
    for (let i = 1; i < anchors.length; i++) expect(anchors[i]!.start).toBeGreaterThanOrEqual(anchors[i - 1]!.start);
  });

  it("falls back to one anchor when the voice gave no timings", () => {
    const anchors = sentencesFromTimings([], 8);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.end).toBe(8);
  });

  it("snaps a beat onto the sentence it belongs to, and leaves a far one alone", () => {
    const anchors = sentencesFromTimings(TIMINGS, DURATION);
    const near = anchors[2]!.start + 0.05;
    expect(snapToSentence(near, anchors)).toBeCloseTo(anchors[2]!.start, 2);
    // A beat that is nowhere near a sentence start is left where it is —
    // and it snaps to whichever sentence is nearest, not to the previous one.
    expect(snapToSentence(anchors[2]!.start + 5, [anchors[2]!])).toBeCloseTo(anchors[2]!.start + 5, 2);
    expect(snapToSentence(anchors[3]!.start - 0.1, anchors)).toBeCloseTo(anchors[3]!.start, 2);
  });
});

describe("what to look a photo up by", () => {
  it("keeps the concrete words and drops the glue", () => {
    expect(salientWords("When you are scared, your brain takes more snapshots per second.")).toMatch(/scared|brain|snapshots/);
    expect(salientWords("When you are scared")).not.toMatch(/\b(when|you|are)\b/i);
    expect(salientWords("the of and")).toBe("");
  });

  it("finds the number a card could hold, and refuses a bare one", () => {
    expect(statPhrase("it takes 20 percent more snapshots per second")).toMatch(/20 percent/);
    expect(statPhrase("about 1 thing")).toBeNull();
  });

  it("breaks a hook into at most two lines", () => {
    const lines = cardLines("The reason your brain slows time down when you are terrified", 34);
    expect(lines.split("\n").length).toBeLessThanOrEqual(2);
  });
});

describe("the built-in plan (no model in the loop)", () => {
  const plan = templateStoryboard({ topic: "why time slows down", sentences: sentencesFromTimings(TIMINGS, DURATION), duration: DURATION });

  it("opens on a hook with an impact, and closes on a follow card with a ding", () => {
    expect(plan.beats[0]!.kind).toBe("hook");
    expect(plan.beats[0]!.at).toBe(0);
    expect(plan.beats[0]!.sfx).toBe("impact");
    const cta = plan.beats.at(-1)!;
    expect(cta.kind).toBe("cta");
    expect(cta.at + cta.hold).toBeLessThanOrEqual(DURATION + 0.01);
    expect(cta.sfx).toBe("ding");
  });

  it("puts a photo on a sentence, never under the hook, and labels it", () => {
    const photos = plan.beats.filter((b) => b.kind === "photo");
    expect(photos.length).toBeGreaterThan(0);
    for (const p of photos) {
      expect(p.at).toBeGreaterThanOrEqual(HOOK_HOLD);
      expect(p.imageQuery).toBeTruthy();
      expect(p.imageCaption).toBeTruthy();
      expect(p.sfx).toBe("whoosh");
    }
  });

  it("respects its own limits and leaves the timeline ordered", () => {
    expect(plan.beats.length).toBeLessThanOrEqual(MAX_BEATS);
    expect(plan.beats.filter((b) => b.kind === "photo").length).toBeLessThanOrEqual(MAX_PHOTOS);
    for (let i = 1; i < plan.beats.length; i++) expect(plan.beats[i]!.at).toBeGreaterThan(plan.beats[i - 1]!.at);
    for (const b of plan.beats) expect(b.hold ?? 0).toBeGreaterThanOrEqual(MIN_HOLD - 0.001);
  });

  it("plans cards only when photos are off", () => {
    const noPhotos = templateStoryboard({ topic: "stoicism", sentences: sentencesFromTimings(TIMINGS, DURATION), duration: DURATION, photos: false });
    expect(noPhotos.beats.some((b) => b.kind === "photo")).toBe(false);
    expect(noPhotos.beats[0]!.kind).toBe("hook");
  });

  it("summarizes itself for the job record", () => {
    const summary = storyboardSummary(plan);
    expect(summary.beats).toBe(plan.beats.length);
    expect(summary.cards).toBe(plan.beats.length - summary.photos);
    expect(summary.music).toBe("pulse");
    expect(summary.searches.length).toBe(summary.photos);
  });
});

describe("a plan written by a model", () => {
  const anchors = sentencesFromTimings(TIMINGS, DURATION);
  const opts = { duration: DURATION, anchors, fallbackHook: "Your brain is lying to you" };

  it("reads JSON out of fences and prose", () => {
    const parsed = extractJsonObject('Sure! Here is the plan:\n```json\n{"music":"none","beats":[]}\n```\nHope it helps!');
    expect(parsed).toMatchObject({ music: "none" });
    expect(extractJsonObject("no json here")).toBeNull();
  });

  it("snaps beats onto sentences, caps the text and drops unknown sounds", () => {
    const answer = JSON.stringify({
      music: "none",
      beats: [
        { kind: "hook", at: 0.2, text: "YOUR BRAIN LIES ABOUT TIME", sfx: "impact", flash: true },
        { kind: "photo", at: anchors[2]!.start + 0.5, imageQuery: "slow motion crash", imageCaption: "slow motion", sfx: "explosion" },
        { kind: "stat", at: anchors[1]!.start, text: "20 percent more snapshots per second, every single time", sfx: "pop" },
      ],
    });
    const plan = parseStoryboard(answer, opts)!;
    expect(plan).toBeTruthy();
    expect(plan.music).toBe("none");
    const photo = plan.beats.find((b) => b.kind === "photo")!;
    expect(photo.at).toBeCloseTo(anchors[2]!.start, 2);
    expect(photo.sfx).toBeUndefined();
    const stat = plan.beats.find((b) => b.kind === "stat")!;
    expect(stat.text!.length).toBeLessThanOrEqual(72);
    expect(stat.sfx).toBe("pop");
  });

  it("adds the hook and the follow card a bad plan forgot, and keeps the sounds apart", () => {
    const answer = JSON.stringify({
      beats: [
        { kind: "photo", at: 3, imageQuery: "brain scan", sfx: "whoosh" },
        { kind: "photo", at: 3.2, imageQuery: "clock face", sfx: "whoosh" },
        { kind: "photo", at: 6, imageQuery: "train window", sfx: "ding" },
      ],
    });
    const plan = parseStoryboard(answer, opts)!;
    expect(plan.beats[0]!.kind).toBe("hook");
    expect(plan.beats[0]!.text).toMatch(/brain/i);
    expect(plan.beats.at(-1)!.kind).toBe("cta");
    // The two whooshes 0.2s apart became one: nothing machine-guns the viewer.
    const sfxTimes = plan.beats.filter((b) => b.sfx).map((b) => b.at);
    for (let i = 1; i < sfxTimes.length; i++) expect(sfxTimes[i]! - sfxTimes[i - 1]!).toBeGreaterThanOrEqual(MIN_SFX_GAP - 0.001);
  });

  it("keeps nothing running under the follow card", () => {
    const answer = JSON.stringify({
      beats: [
        { kind: "hook", at: 0, text: "WAIT FOR IT" },
        { kind: "stat", at: DURATION - 0.5, text: "20 percent" },
        { kind: "cta", at: DURATION - 3, text: "Follow for more" },
      ],
    });
    const beats = parseStoryboard(answer, opts)!.beats;
    const cta = beats.find((b) => b.kind === "cta")!;
    const stat = beats.find((b) => b.kind === "stat");
    if (stat) expect(stat.at + stat.hold!).toBeLessThanOrEqual(cta.at + 0.01);
  });

  it("never trusts the model with the shape: no photos under the hook, no more than six", () => {
    const many = {
      beats: Array.from({ length: 14 }, (_, i) => ({ kind: "photo", at: 0.1 + i * 0.4, imageQuery: `subject ${i}` })),
    };
    const plan = parseStoryboard(JSON.stringify(many), opts)!;
    expect(plan.beats.filter((b) => b.kind === "photo").length).toBeLessThanOrEqual(MAX_PHOTOS);
    for (const b of plan.beats) if (b.kind === "photo") expect(b.at).toBeGreaterThanOrEqual(HOOK_HOLD);
    expect(plan.beats.length).toBeLessThanOrEqual(MAX_BEATS);
  });

  it("returns null rather than inventing a plan", () => {
    expect(parseStoryboard("I could not do that.", opts)).toBeNull();
    expect(parseStoryboard('{"beats":[]}', opts)).toBeNull();
    expect(parseStoryboard('{"beats":[{"kind":"photo"}]}', opts)).toBeNull();
    expect(parseStoryboard(null, opts)).toBeNull();
  });

  it("normalize keeps a hook even when handed only photos", () => {
    const bare: Storyboard = { beats: [{ kind: "photo", at: 4, imageQuery: "clock" }], music: "pulse", source: "gemini" };
    const plan = normalizeStoryboard(bare, { ...opts, photos: true });
    expect(plan.beats.map((b) => b.kind)).toEqual(["hook", "photo", "cta"]);
  });
});

describe("the window each beat is on screen for", () => {
  it("starts at the beat, ends before the next one, and stays inside the short", () => {
    const plan = templateStoryboard({ topic: "time", sentences: sentencesFromTimings(TIMINGS, 12), duration: 12 });
    const windows = beatWindows(plan, 12);
    expect(windows).toHaveLength(plan.beats.length);
    for (let i = 0; i < windows.length; i++) {
      expect(windows[i]!.end).toBeGreaterThan(windows[i]!.start);
      expect(windows[i]!.end).toBeLessThanOrEqual(12);
      if (i) expect(windows[i]!.start).toBeGreaterThanOrEqual(windows[i - 1]!.start);
    }
  });
});

describe("what the model is asked for", () => {
  it("hands over the sentences with their seconds, the sound menu and the shape", () => {
    const brief = storyboardBrief({
      script: SCRIPT,
      sentences: sentencesFromTimings(TIMINGS, DURATION),
      topic: "why time slows down",
      seconds: 12,
      niche: "facts",
    });
    expect(brief).toContain("why time slows down");
    expect(brief).toMatch(/\d+\.\d+–\d+\.\d+s/);
    for (const kind of SFX_KINDS) expect(brief).toContain(`"${kind}"`);
    expect(brief).toContain('"kind":"hook"|"photo"|"stat"|"cta"');
    expect(brief).toMatch(/something you can show/i);
  });

  it("says so when there are no photos to be had", () => {
    const brief = storyboardBrief({ script: SCRIPT, sentences: [], topic: "grief", seconds: 60, photos: false });
    expect(brief).toMatch(/No photos are available/i);
    expect(brief).not.toMatch(/imageQuery/);
  });
});

describe("the sound menu", () => {
  it("describes every effect and gives each a level under the voice", () => {
    expect(Object.keys(SFX_CATALOG).sort()).toEqual([...SFX_KINDS].sort());
    for (const kind of SFX_KINDS) {
      expect(SFX_CATALOG[kind].when.length).toBeGreaterThan(10);
      expect(SFX_CATALOG[kind].gain).toBeGreaterThan(0);
      expect(SFX_CATALOG[kind].gain).toBeLessThanOrEqual(1);
    }
  });
});
