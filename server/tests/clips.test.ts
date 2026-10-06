// "Make shorts from this video": the pure rules behind it — where the cuts go,
// which windows are worth clipping (with and without a Gemini key), how the
// picker's answer is read, and how spoken words become burned captions.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIPS,
  MAX_CLIPS,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  audioProfile,
  buildPickerAsk,
  candidateWindows,
  captionCues,
  clipFileName,
  clipLength,
  clock,
  clockRange,
  fallbackPicks,
  highlightSignals,
  inVideoOrder,
  momentScore,
  momentsFor,
  normalizePick,
  parsePickerReply,
  pickMoments,
  planWindows,
  rankWindows,
  snapToSpeech,
  speechRuns,
  windowScore,
  withoutOverlaps,
} from "../src/lib/brain/core/clips.js";

const levels = (voicedSec: number, peakDb: number) => ({ voicedMs: voicedSec * 1000, peakDb });

describe("where a long video is searched", () => {
  it("chops it into 45-second windows, merging a stub tail into the one before", () => {
    expect(planWindows(0)).toEqual([]);
    expect(planWindows(5)).toEqual([{ start: 0, end: 5 }]); // a tiny video is one window
    // 100 s: the 10 s tail is under a clip, so it joins the window before it.
    expect(planWindows(100)).toEqual([
      { start: 0, end: 45 },
      { start: 45, end: 100 },
    ]);
    // 96 s: the 6 s tail is merged, so nothing short of a real clip is planned.
    expect(planWindows(96)).toEqual([
      { start: 0, end: 45 },
      { start: 45, end: 96 },
    ]);
    expect(planWindows(45)).toEqual([{ start: 0, end: 45 }]);
  });

  it("scores speech and loudness, and ranks the windows", () => {
    const w = (start: number, end: number) => ({ start, end });
    const windows = [w(0, 45), w(45, 90), w(90, 135)];
    // Window 2 is mostly talking; 1 is half silent; 3 is quiet background.
    const scores = [windowScore(windows[0]!, levels(22, -6)), windowScore(windows[1]!, levels(41, -4)), windowScore(windows[2]!, levels(5, -45))];
    expect(scores[1]).toBeGreaterThan(scores[0]!);
    expect(scores[0]).toBeGreaterThan(scores[2]!);
    expect(rankWindows(windows, scores)).toEqual([1, 0, 2]);
    // A window with no levels at all is the least promising, not a crash.
    expect(windowScore(windows[0]!, undefined)).toBeLessThan(scores[2]!);
  });

  it("cuts at most the longest a Short may be", () => {
    expect(clipLength({ start: 0, end: 45 }, 600)).toBe(45);
    expect(clipLength({ start: 0, end: 45 }, 600)).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
    expect(clipLength({ start: 590, end: 600 }, 600)).toBe(MIN_CLIP_SECONDS);
  });
});

describe("picking without a key", () => {
  const windows = planWindows(200); // 5 windows: 0-45, 45-90, 90-135, 135-180, 180-200
  const scores = [0.9, 0.4, 0.8, 0.3, 0.2];

  it("takes the most promising windows, spread out, in video order", () => {
    const picks = fallbackPicks(windows, scores, 200, 3);
    expect(picks).toHaveLength(3);
    // Window 0 wins, 1 is its neighbour (same moment) and 2 is next; with those
    // two the count isn't full yet, so the most promising one left is 4 — three
    // clips spread over the video, not three from the opening minute.
    expect(picks.map((p) => p.start)).toEqual([0, 90, 180]);
    expect(picks.every((p) => p.end - p.start >= MIN_CLIP_SECONDS)).toBe(true);
  });

  it("gives fewer clips when the video is short, and honours the count", () => {
    // A 70 s video has two windows and could hold two clips: neighbours are
    // allowed once the spread-out rule can't fill the count.
    expect(fallbackPicks(planWindows(70), [0.5, 0.9], 70, 3).map((p) => p.start)).toEqual([0, 45]);
    expect(fallbackPicks(windows, scores, 200, 1)).toHaveLength(1);
    expect(fallbackPicks(windows, scores, 200, 99)).toHaveLength(MAX_CLIPS);
    expect(fallbackPicks(windows, scores, 200, Number.NaN)).toHaveLength(DEFAULT_CLIPS);
  });
});

describe("the picker's answer", () => {
  it("is asked for numbered windows with what is said", () => {
    const windows = planWindows(100);
    const ask = buildPickerAsk(windows, ["a hook about coffee", null], 3, "funny bits");
    expect(ask.user).toContain("1. 0:00–0:45 — “a hook about coffee”");
    expect(ask.user).toContain("2. 0:45–1:40 — (no speech heard");
    expect(ask.system).toContain("3 best moments");
    expect(ask.system).toContain("funny bits");
    expect(ask.system).toContain("JSON");
  });

  it("reads JSON out of prose, and says nothing when there's no JSON", () => {
    const picks = parsePickerReply('Sure! Here you go:\n[{"start": 10, "end": 50, "title": "Coffee", "reason": "a real hook"}]\nEnjoy.', 300, 3);
    expect(picks).toEqual([{ start: 10, end: 50, title: "Coffee", reason: "a real hook" }]);
    expect(parsePickerReply("I couldn't find anything.", 300, 3)).toEqual([]);
    expect(parsePickerReply("[not json]", 300, 3)).toEqual([]);
  });

  it("keeps the picks inside the video, the length limits and away from each other", () => {
    // End past the video, a too-short one, an overlapping one, and one beyond the count.
    const picks = parsePickerReply(
      JSON.stringify([
        { start: 290, end: 400, title: "End", reason: "" },
        { start: 5, end: 8, title: "Too short" },
        { start: 292, end: 320, title: "Overlaps the first" },
        { start: 120, end: 170, title: "Second", reason: "good" },
        { start: 200, end: 240, title: "Third" },
        { start: 60, end: 100, title: "Past the count" },
      ]),
      300,
      3,
    );
    expect(picks).toHaveLength(3);
    expect(picks[0]!.end).toBe(300); // clamped to the video's end
    expect(picks[0]!.end - picks[0]!.start).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
    expect(picks.some((p) => p.title === "Too short")).toBe(false);
    expect(picks.some((p) => p.title === "Overlaps the first")).toBe(false);
    expect(picks.some((p) => p.title === "Past the count")).toBe(false);
  });

  it("reads one entry on its own, and trims what a model might pad", () => {
    expect(normalizePick({ start: 3, end: 20, title: "  A   lot\nof space ", reason: "why" }, 100)).toEqual({
      start: 3,
      end: 20,
      title: "A lot of space",
      reason: "why",
    });
    expect(normalizePick({ title: "no start" }, 100)).toBeNull();
    expect(normalizePick(null, 100)).toBeNull();
    // No end given: the longest a Short may be — and the start slides back so a
    // full clip still fits at the very end of the video.
    expect(normalizePick({ start: 90 }, 100)).toMatchObject({ start: 88, end: 100 });
    expect(inVideoOrder([{ start: 90, end: 120, title: "", reason: "" }, { start: 10, end: 40, title: "", reason: "" }]).map((p) => p.start)).toEqual([10, 90]);
  });

  it("tops a short list up with the loudest windows, never overlapping what it has", () => {
    const model = [{ start: 100, end: 140, title: "Chosen", reason: "" }];
    const fallback = [
      { start: 20, end: 60, title: "Loud 1", reason: "" },
      { start: 130, end: 160, title: "Shares words with Chosen", reason: "" },
      { start: 200, end: 240, title: "Loud 2", reason: "" },
    ];
    const merged = withoutOverlaps([...model, ...fallback], 3);
    expect(merged.map((p) => p.title)).toEqual(["Chosen", "Loud 1", "Loud 2"]);
    expect(withoutOverlaps([...model, ...fallback], 1)).toHaveLength(1);
  });
});

describe("captions from words without word timings", () => {
  it("groups words into short lines, never ending a line mid-sentence", () => {
    const cues = captionCues("Coffee is the best. It wakes you up and it tastes good too.", 0, 12);
    expect(cues.map((c) => c.text)).toEqual(["Coffee is the best.", "It wakes you up", "and it tastes good too."]);
    expect(cues[0]!.start).toBe(0);
    expect(cues.at(-1)!.end).toBe(12);
    // Every line is short enough to read at a glance — sentences may run a
    // couple of words past the cap, never more.
    for (const c of cues) {
      expect(c.text.split(" ").length).toBeLessThanOrEqual(6);
      expect(c.text.length).toBeLessThanOrEqual(38);
    }
    expect(cues.map((c) => c.text).join(" ")).toBe("Coffee is the best. It wakes you up and it tastes good too.");
  });

  it("shares the time out by how much there is to read", () => {
    const cues = captionCues("one two three four five six seven eight", 10, 18);
    expect(cues[0]!.start).toBe(10);
    expect(cues.at(-1)!.end).toBe(18);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeCloseTo(cues[i - 1]!.end, 3);
    for (const c of cues) expect(c.end - c.start).toBeGreaterThanOrEqual(0.2);
  });

  it("says nothing when there's nothing to caption", () => {
    expect(captionCues("", 0, 10)).toEqual([]);
    expect(captionCues("   ", 0, 10)).toEqual([]);
    expect(captionCues("words", 5, 5)).toEqual([]);
  });

  it("writes clocks and file names people can read", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65)).toBe("1:05");
    expect(clock(3725)).toBe("1:02:05");
    expect(clockRange({ start: 65, end: 110 })).toBe("1:05–1:50");
    expect(clipFileName(0, "Coffee Is King!")).toBe("soundwave_clip_1_coffee-is-king.mp4");
    expect(clipFileName(2, "")).toBe("soundwave_clip_3.mp4");
    expect(clipFileName(1, "x".repeat(80), "job9")).toBe(`soundwave_clip_2_${"x".repeat(40)}_job9.mp4`);
  });
});

// ── Finding the moments (local, no model) ───────────────────────────────────
// The heart of "don't clip randomly": the video's own sound says where someone
// talks, where a thought ends, and which stretches are livelier than the rest;
// the words, when they were heard, say whether a moment says something.
describe("finding the moments worth clipping (no model)", () => {
  const RATE = 16_000;
  /** A deterministic tone (220 Hz) at `level` × full scale, in seconds. */
  const parts = (spec: Array<[number, number]>): Int16Array => {
    const samples: number[] = [];
    for (const [seconds, level] of spec) {
      const n = Math.round(seconds * RATE);
      for (let i = 0; i < n; i++) {
        // A sine plus a little frame-to-frame variation, so dynamics see life.
        const wobble = 1 + 0.35 * Math.sin((2 * Math.PI * 7 * i) / RATE);
        samples.push(Math.round(level * 32767 * wobble * Math.sin((2 * Math.PI * 220 * i) / RATE)));
      }
    }
    return Int16Array.from(samples);
  };

  it("hears talking over room tone, and keeps word gaps inside one run", () => {
    const pcm = parts([
      [2, 0.002], // room tone
      [3, 0.3], // talking
      [0.6, 0.002], // a pause long enough to be a thought boundary
      [2, 0.3],
      [4, 0.002],
    ]);
    const profile = audioProfile(pcm, RATE);
    // The floor is the room tone; the speech sits ~50 dB over it.
    expect(profile.thresholdDb).toBeGreaterThanOrEqual(profile.floorDb + 9);
    const runs = speechRuns(profile);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.start).toBeGreaterThan(1.8);
    expect(runs[0]!.start).toBeLessThan(2.3);
    expect(runs[0]!.end).toBeGreaterThan(4.7);
    expect(runs[0]!.end).toBeLessThan(5.3);
    expect(runs[1]!.start).toBeGreaterThan(5.4);
    expect(runs[1]!.end).toBeGreaterThan(7.4);
  });

  it("opens a candidate on an onset and closes it on the furthest pause that fits", () => {
    const runs = [
      { start: 3.2, end: 20.5 },
      { start: 21.0, end: 33.0 },
      { start: 34.0, end: 70.0 },
    ];
    const windows = candidateWindows(runs, 90);
    expect(windows[0]).toEqual({ start: 3.2, end: 33 });
    for (const w of windows) {
      expect(w.end - w.start).toBeGreaterThanOrEqual(MIN_CLIP_SECONDS);
      expect(w.end - w.start).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
    }
  });

  it("slides a candidate back so a full Short still fits at the very end", () => {
    const windows = candidateWindows([{ start: 88, end: 89 }], 90);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.end - windows[0]!.start).toBeGreaterThanOrEqual(MIN_CLIP_SECONDS);
    expect(windows[0]!.end).toBeLessThanOrEqual(90);
  });

  it("falls back to even windows when nobody speaks (music, ambience)", () => {
    const profile = audioProfile(parts([[70, 0.02]]), RATE);
    const found = momentsFor(profile);
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(planWindows(70));
  });

  it("scores a promise — and a clean, heard moment — over a loud patch of nothing", () => {
    const heard = (hooks: number, fillers: number) => ({ speechRatio: 0.9, loudness: 0.6, dynamics: 0.5, heard: true, hooks, fillers });
    const loudestUnheard = { speechRatio: 1, loudness: 1, dynamics: 1, heard: false, hooks: 0, fillers: 0 };
    expect(momentScore(heard(3, 0))).toBeGreaterThan(momentScore(heard(0, 0)));
    expect(momentScore(heard(2, 2))).toBeLessThan(momentScore(heard(2, 0)));
    expect(momentScore(heard(0, 0))).toBeGreaterThan(momentScore(loudestUnheard));
  });

  it("reads promises and housekeeping out of the words themselves", () => {
    expect(highlightSignals("How I made $10,000 in 30 days").hooks).toBeGreaterThanOrEqual(2);
    expect(highlightSignals("Why does everyone get this wrong?").hooks).toBeGreaterThanOrEqual(2);
    expect(highlightSignals("Welcome back! In this video, um, let me explain the sponsor deal.").fillers).toBeGreaterThanOrEqual(3);
    expect(highlightSignals("").hooks).toBe(0);
  });

  it("snaps a model's pick onto the nearest speech boundary", () => {
    const runs = [
      { start: 9.8, end: 15.0 },
      { start: 15.4, end: 31.2 },
    ];
    expect(snapToSpeech({ start: 10.4, end: 30.9 }, runs, 2.5, 60)).toEqual({ start: 9.8, end: 31.2 });
    // Nothing near: the moment is left where it was.
    expect(snapToSpeech({ start: 40, end: 55 }, runs, 2.5, 60)).toEqual({ start: 40, end: 55 });
  });

  it("picks the best moments from different parts of the video", () => {
    const windows = [0, 45, 90, 135].map((start) => ({ start, end: start + 40 }));
    const scores = [0.9, 0.2, 0.4, 0.3];
    expect(pickMoments(windows, scores, 180, 2).map((p) => p.start)).toEqual([0, 90]);
  });
});
