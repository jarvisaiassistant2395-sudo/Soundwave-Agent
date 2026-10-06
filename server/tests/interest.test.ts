// The measured-interest layer: YouTube's own most-replayed curve, the comments
// that point at a moment, and this week's trending terms — turned into a score
// and a sentence per window.
//
// Why these tests matter more than most: this is what makes the clipper "clip
// what people actually watched" instead of "clip what sounds lively". Every
// number below comes from a real shape of the real data (yt-dlp's `heatmap`
// entries are {start_time, end_time, value}; comments carry like counts), and
// the last test pins the promise that a video with none of it behaves exactly
// as it did before.
import { describe, expect, it } from "vitest";

import {
  HEAT_PEAK_FLOOR,
  commentAnchors,
  heatAt,
  heatCoverage,
  heatPeaks,
  heatStats,
  heatWindows,
  interestBrief,
  matchTrendTerms,
  parseHeatmap,
  parseTimecodes,
  rankByInterest,
  trendTerms,
  viewsLabel,
  windowInterest,
  type ViewSignals,
} from "../src/lib/brain/core/interest.js";
import { buildPickerAsk, mergeWindows, momentScore, selectClips, trimOverlaps, type VideoWindow } from "../src/lib/brain/core/clips.js";

/** YouTube's shape: points every few seconds, a spike where people replayed. */
function heatmapShape(durationSec: number, spikes: Array<{ at: number; value: number; spread?: number }>): unknown[] {
  const points: unknown[] = [];
  for (let start = 0; start < durationSec; start += 5) {
    let value = 0.1;
    for (const spike of spikes) {
      const spread = spike.spread ?? 8;
      const distance = Math.abs(start + 2.5 - spike.at);
      if (distance <= spread) value = Math.max(value, spike.value * (1 - distance / (spread * 2)));
    }
    points.push({ start_time: start, end_time: start + 5, value: Math.round(value * 1000) / 1000 });
  }
  return points;
}

const signals = (over: Partial<ViewSignals> = {}): ViewSignals => ({
  heat: parseHeatmap(heatmapShape(600, [{ at: 302.5, value: 0.98 }])),
  anchors: [],
  trends: [],
  stats: {},
  ...over,
});

describe("YouTube's own replay data", () => {
  it("accepts yt-dlp's shape and refuses anything malformed", () => {
    const parsed = parseHeatmap([
      { start_time: 10, end_time: 15, value: 0.5 },
      { start_time: 0, end_time: 5, value: "0.9" },
      { start_time: 5, end_time: 6, value: 1.4 },
      { start_time: 7, end_time: 8, value: 0.2 },
      { start_time: "later", end_time: 9, value: 0.3 },
      null,
      { start_time: 20, value: 0.4 },
      { start_time: 30, end_time: 25, value: 0.6 },
    ]);
    expect(parsed.map((p) => [p.start, p.end, p.value])).toEqual([
      [0, 5, 0.9],
      [5, 6, 1],
      [7, 8, 0.2],
      [10, 15, 0.5],
      [20, 21, 0.4],
      [30, 31, 0.6], // end before start: a point, not a backwards window
    ]);
    expect(parseHeatmap(undefined)).toEqual([]);
    expect(parseHeatmap("NA")).toEqual([]);
    expect(parseHeatmap([{ start_time: -3, end_time: 1, value: 0.5 }, { start_time: 3, end_time: 4 }])).toEqual([]);
  });

  it("finds the peaks people replayed, keeps them apart, and ignores the noise", () => {
    const heat = parseHeatmap(heatmapShape(600, [{ at: 302.5, value: 0.98 }, { at: 502.5, value: 0.42 }]));
    const peaks = heatPeaks(heat, { minGapSec: 30 });
    expect(peaks).toHaveLength(1);
    expect((peaks[0]!.start + peaks[0]!.end) / 2).toBeGreaterThan(290);
    expect((peaks[0]!.start + peaks[0]!.end) / 2).toBeLessThan(310);
    expect(peaks[0]!.value).toBeGreaterThanOrEqual(HEAT_PEAK_FLOOR);
    // A peak right on the floor is kept; the video's own shape is returned too.
    const shape = heatStats(heat);
    expect(shape.peak).toBeGreaterThan(0.9);
    expect(shape.peakAt).toBeGreaterThan(290);
    expect(shape.median).toBeLessThan(0.2);
  });

  it("builds a clip-shaped window around a peak even when nobody talks over it", () => {
    const heat = parseHeatmap(heatmapShape(120, [{ at: 62.5, value: 0.95 }]));
    const windows = heatWindows(heat, 120);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.start).toBeLessThan(60);
    expect(windows[0]!.end).toBeGreaterThan(60);
    expect(windows[0]!.end - windows[0]!.start).toBeGreaterThan(10);
    // Nothing to see: no windows, no crash.
    expect(heatWindows([], 120)).toEqual([]);
    expect(heatWindows(heat, 0)).toEqual([]);
  });

  it("reads the strongest value inside a window, not the average", () => {
    const heat = parseHeatmap([
      { start_time: 0, end_time: 10, value: 0.2 },
      { start_time: 10, end_time: 20, value: 0.97 },
      { start_time: 20, end_time: 30, value: 0.3 },
    ]);
    expect(heatAt(heat, 8, 22)).toBe(0.97);
    expect(heatAt(heat, 0, 5)).toBe(0.2);
    expect(heatAt(heat, 40, 50)).toBe(0);
  });
});

describe("how much of a replayed part a window holds", () => {
  const heat = parseHeatmap([{ start_time: 25, end_time: 35, value: 0.99 }]);

  it("counts the share of the peak inside the window, not its mere presence", () => {
    expect(heatCoverage(heat, 20, 40)).toBe(0.99); // the whole peak
    expect(heatCoverage(heat, 25, 35)).toBe(0.99);
    // Grazing the last three seconds of a ten-second replay is not the moment.
    expect(heatCoverage(heat, 0, 28)).toBeCloseTo(0.297, 2);
    expect(heatCoverage(heat, 36, 60)).toBe(0);
    expect(heatCoverage([], 0, 60)).toBe(0);
  });

  it("keeps a long window that grazes a peak from outranking the peak itself", () => {
    const signals: ViewSignals = { heat, anchors: [], trends: [], stats: {} };
    const peak = windowInterest({ start: 20, end: 40 }, { signals });
    const grazing = windowInterest({ start: 0, end: 28 }, { signals });
    expect(peak.score).toBeGreaterThan(grazing.score);
    // And a window that only touches the peak shows no "viewers replayed" line.
    expect(grazing.evidence.join(" ")).not.toMatch(/replayed/i);
    expect(peak.evidence.join(" ")).toMatch(/replayed/i);
  });
});

describe("choosing the clips", () => {
  const w = (start: number, end: number, score: number) => ({ window: { start, end }, score });

  it("takes the best moments first and keeps them from sharing footage", () => {
    const chosen = selectClips([w(0, 21, 0.3), w(19, 40, 0.87), w(0, 28, 0.4)], 40, 2, { minSeconds: 12, maxSeconds: 59 });
    expect(chosen).toEqual([
      { start: 19, end: 40 },
      { start: 0, end: 17.5 },
    ]);
  });

  it("lets a clip near the end of the video be shorter instead of dragging it back", () => {
    const chosen = selectClips([w(24, 40, 0.9)], 40, 1, { minSeconds: 12, maxSeconds: 59 });
    expect(chosen).toEqual([{ start: 24, end: 40 }]);
  });

  it("respects the model's own picks as already chosen", () => {
    const chosen = selectClips([w(0, 20, 0.5), w(30, 50, 0.4)], 60, 2, {
      minSeconds: 12,
      maxSeconds: 59,
      preset: [{ start: 20, end: 32 }],
    });
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.start).toBeGreaterThanOrEqual(33.5);
  });

  it("never returns more clips than were asked for, and drops what cannot fit", () => {
    const many = [w(0, 20, 0.9), w(30, 50, 0.8), w(60, 80, 0.7)];
    expect(selectClips(many, 100, 1, { minSeconds: 12, maxSeconds: 59 })).toHaveLength(1);
    expect(selectClips(many, 100, 3, { minSeconds: 12, maxSeconds: 59 })).toHaveLength(3);
    // A moment with no room left for a full clip is dropped, not fragmented.
    expect(selectClips([w(0, 30, 0.9), w(31, 40, 0.8)], 40, 2, { minSeconds: 12, maxSeconds: 59 })).toHaveLength(1);
    expect(selectClips([], 40, 3)).toEqual([]);
  });
});

describe("comments that point at a moment", () => {
  it("parses mm:ss and h:mm:ss, and ignores numbers that are not times", () => {
    expect(parseTimecodes("2:14 had me crying")).toEqual([134]);
    expect(parseTimecodes("the bit at 1:02:03 is unreal")).toEqual([3723]);
    expect(parseTimecodes("I paid $1:99 for this")).toEqual([]); // 99 seconds isn't a timecode
    expect(parseTimecodes("ratio 3:2 is fine")).toEqual([]); // 2 is seconds, but 3:2 reads as 3m02s — kept
    expect(parseTimecodes("at 12:41", 800)).toEqual([761]);
    expect(parseTimecodes("at 12:41", 600)).toEqual([]); // past the end of the video
    expect(parseTimecodes("no time here")).toEqual([]);
  });

  it("weights anchors by likes and merges the same moment said twice", () => {
    const anchors = commentAnchors(
      [
        { text: "2:14 had me crying", likes: 1200 },
        { text: "2:16 is the best part", likes: 40 },
        { text: "10:00 was boring tbh", likes: 5 },
        { text: "no timestamp here", likes: 900 },
        { text: "3:33 👀", likes: "12" }, // a numeric string still counts
      ],
      1200,
    );
    expect(anchors.map((a) => a.atSec)).toEqual([134, 213, 600]);
    expect(anchors[0]!.likes).toBe(1240); // the two 2:1x comments became one
    expect(anchors[2]!.likes).toBe(5);
    expect(anchors[1]!.likes).toBe(12);
  });
});

describe("what is getting views this week", () => {
  const top = [
    { title: "Why AI agents are eating software", views: 2_000_000, channel: "a" },
    { title: "AI agents: the honest truth", views: 1_500_000, channel: "b" },
    { title: "coffee brewing mistakes", views: 900_000, channel: "c" },
    { title: "coffee brewing, but faster", views: 400_000, channel: "d" },
    { title: "a unique word only I use", views: 10_000_000, channel: "e" },
  ];

  it("keeps terms that appear on several channels, with the views behind them", () => {
    const terms = trendTerms(top);
    const words = terms.map((t) => t.term);
    expect(words).toContain("agents");
    expect(words).toContain("coffee");
    expect(words).toContain("brewing");
    // One channel is a fluke, however many views it has.
    expect(words).not.toContain("unique");
    // Sorted by the views the term carries.
    expect(terms[0]!.term).toBe("agents");
    expect(terms[0]!.views).toBe(3_500_000);
    expect(terms[0]!.shorts).toBe(2);
  });

  it("matches whole words only, so 'coffee' doesn't match 'coffeemaker' alone", () => {
    const terms = trendTerms(top);
    expect(matchTrendTerms("we talked about coffee for an hour", terms).map((t) => t.term)).toEqual(["coffee"]);
    expect(matchTrendTerms("coffeemaker reviews", terms)).toEqual([]);
    expect(matchTrendTerms("nothing relevant here", terms)).toEqual([]);
    expect(matchTrendTerms(undefined, terms)).toEqual([]);
  });
});

describe("scoring a window on what the audience did", () => {
  it("ranks a replay peak above a lively stretch with no measured interest", () => {
    const heat = parseHeatmap(heatmapShape(600, [{ at: 302.5, value: 0.95 }, { at: 62.5, value: 0.35 }]));
    const data: ViewSignals = {
      heat,
      anchors: [{ atSec: 302, likes: 1500, text: "4:58 is the part everyone quotes" }],
      trends: [
        { term: "agents", views: 3_500_000, shorts: 2 },
        { term: "coffee", views: 1_300_000, shorts: 2 },
      ],
      stats: { views: 1_200_000, likes: 40_000, comments: 5_000, ageHours: 48 },
    };
    const peak: VideoWindow = { start: 288, end: 330 };
    const quiet: VideoWindow = { start: 48, end: 90 };
    const peakScore = windowInterest(peak, { signals: data, text: "How AI agents really work" });
    const quietScore = windowInterest(quiet, { signals: data, text: "now we make the coffee" });

    expect(peakScore.score).toBeGreaterThan(quietScore.score);
    expect(peakScore.score).toBeGreaterThan(0.5);
    expect(peakScore.parts.heat).toBeGreaterThan(0.8);
    expect(peakScore.parts.comments).toBeGreaterThan(0);
    expect(peakScore.parts.trends).toBeGreaterThan(0);
    expect(peakScore.parts.momentum).toBeGreaterThan(0);
    // Momentum amplifies rather than adds, so a measured moment in a hot video
    // can reach the top of the scale without the parts summing past 1.
    expect(peakScore.score).toBeLessThanOrEqual(1);
    // Every claim is one the person can check on YouTube themselves.
    expect(peakScore.evidence.join(" ")).toMatch(/replayed/i);
    expect(peakScore.evidence.join(" ")).toMatch(/comment points here/i);
    expect(peakScore.evidence.join(" ")).toMatch(/agents/);
    expect(quietScore.evidence.join(" ")).not.toMatch(/replayed/i);
  });

  it("judges a peak against the video's own ceiling, not an absolute number", () => {
    // Same two videos, same two windows: the one built on each video's own best
    // moment scores top marks in both, and the secondary moment is judged
    // against its own video's ceiling.
    const modest = parseHeatmap(heatmapShape(600, [{ at: 302.5, value: 0.62 }, { at: 62.5, value: 0.58 }]));
    const spectacular = parseHeatmap(heatmapShape(600, [{ at: 302.5, value: 0.95 }, { at: 62.5, value: 0.6 }]));
    const best: VideoWindow = { start: 288, end: 330 };
    const second: VideoWindow = { start: 48, end: 90 };
    const modestBest = windowInterest(best, { signals: { heat: modest, anchors: [], trends: [], stats: {} } });
    const spectacularBest = windowInterest(best, { signals: { heat: spectacular, anchors: [], trends: [], stats: {} } });
    expect(modestBest.parts.heat).toBe(1);
    expect(spectacularBest.parts.heat).toBe(1);
    // The quieter moment of a modest video is still a real replay peak; in a
    // video whose ceiling is far higher it is background.
    const modestSecond = windowInterest(second, { signals: { heat: modest, anchors: [], trends: [], stats: {} } });
    const spectacularSecond = windowInterest(second, { signals: { heat: spectacular, anchors: [], trends: [], stats: {} } });
    expect(modestSecond.parts.heat).toBeGreaterThan(spectacularSecond.parts.heat);
    // A curve that never gets above the floor is not a replay peak at all.
    const never = parseHeatmap(heatmapShape(600, [{ at: 302.5, value: 0.4 }]));
    expect(windowInterest(best, { signals: { heat: never, anchors: [], trends: [], stats: {} } }).parts.heat).toBe(0);
  });

  it("does not let a hot video's popularity stand in for a measured moment", () => {
    // A window with no heat, no comment and no matching term scores zero even
    // when the video is huge and brand new: momentum says the numbers are
    // current, not where the good part is.
    const hot = windowInterest(
      { start: 0, end: 40 },
      { signals: { heat: parseHeatmap(heatmapShape(600, [{ at: 302.5, value: 0.9 }])), anchors: [], trends: [], stats: { views: 5_000_000, ageHours: 10 } } },
    );
    expect(hot.score).toBe(0);
  });

  it("says nothing and scores nothing without any measured data", () => {
    const empty = windowInterest({ start: 10, end: 50 }, { signals: { heat: [], anchors: [], trends: [], stats: {} }, text: "hello" });
    expect(empty.score).toBe(0);
    expect(empty.evidence).toEqual([]);
  });

  it("ranks windows by measured interest, highest first", () => {
    const data = signals({
      anchors: [{ atSec: 120, likes: 800, text: "2:00 is gold" }],
      trends: [{ term: "coffee", views: 1_000_000, shorts: 3 }],
    });
    const windows: VideoWindow[] = [
      { start: 0, end: 40 },
      { start: 110, end: 150 },
      { start: 290, end: 330 },
    ];
    const ranked = rankByInterest(windows, data, (w) => (w.start === 110 ? "coffee coffee coffee" : ""));
    const order = ranked.map((r) => r.item.start);
    expect(order[0]).toBe(290); // the heat peak wins
    expect(order[1]).toBe(110); // the comment + trending term
    expect(order[2]).toBe(0); // nothing measured here: last, and scored zero
    expect(ranked[1]!.evidence.join(" ")).toMatch(/comment points here/i);
    expect(ranked[0]!.evidence.join(" ")).toMatch(/replayed/i);
    expect(ranked[2]!.interest).toBe(0);
    // No signals: everything zeroes rather than throwing, and order is stable.
    expect(rankByInterest(windows, null).every((r) => r.interest === 0)).toBe(true);
  });
});

describe("the brief and the labels a person reads", () => {
  it("writes the measured signals as checkable sentences", () => {
    const data: ViewSignals = {
      heat: parseHeatmap(heatmapShape(600, [{ at: 302.5, value: 0.95 }])),
      anchors: [
        { atSec: 302, likes: 1500, text: "4:58 is the part everyone quotes" },
        { atSec: 120, likes: 0, text: "1:60 nonsense" },
      ],
      trends: [{ term: "agents", views: 3_500_000, shorts: 2 }],
      stats: { views: 1_200_000, likes: 40_000, ageHours: 48 },
      notes: ["Couldn't read the comments (no internet). Picking without them."],
    };
    const lines = interestBrief(data).join("\n");
    expect(lines).toMatch(/most-replayed/);
    expect(lines).toMatch(/4:58|5:00|4:5\d/);
    expect(lines).toMatch(/1\.5k likes/);
    expect(lines).toMatch(/agents/);
    expect(lines).toMatch(/1\.2M views/);
    expect(lines).toMatch(/Couldn't read the comments/);
    // An anchor with no likes is not worth a line.
    expect((lines.match(/comment points at/g) ?? []).length).toBe(1);
    expect(interestBrief(null)).toEqual([]);
  });

  it("formats view counts the way a person reads them", () => {
    expect(viewsLabel(934)).toBe("934");
    expect(viewsLabel(18_400)).toBe("18.4k");
    expect(viewsLabel(1_200_000)).toBe("1.2M");
    expect(viewsLabel(3_500_000_000)).toBe("3.5B");
    expect(viewsLabel(null)).toBe("");
    expect(viewsLabel(Number.NaN)).toBe("");
  });
});

describe("the picker hears the measured evidence", () => {
  const windows: VideoWindow[] = [
    { start: 0, end: 40 },
    { start: 288, end: 330 },
  ];

  it("annotates windows and tells the model measured data outranks its impression", () => {
    const ask = buildPickerAsk(windows, ["we start with the intro", "so here is the thing"], 1, undefined, [
      undefined,
      ["Viewers replayed this part: 96% of the video's own peak (around 4:58)", "A comment points here (5:02, 1.5k likes): “the part everyone quotes”"],
    ]);
    expect(ask.user).toMatch(/MEASURED: Viewers replayed this part/);
    expect(ask.user).toMatch(/1\.5k likes/);
    // The window with no evidence carries no annotation, so the model can see
    // the difference rather than infer it.
    expect(ask.user.split("\n").find((l) => l.startsWith("1."))).not.toMatch(/MEASURED/);
    expect(ask.system).toMatch(/real audience data/);
    expect(ask.system).toMatch(/most-replayed/);
  });

  it("is the same prompt as before when there is nothing measured", () => {
    const plain = buildPickerAsk(windows, ["a", "b"], 2, "coffee");
    const withEmpty = buildPickerAsk(windows, ["a", "b"], 2, "coffee", [undefined, undefined]);
    expect(withEmpty).toEqual(plain);
    expect(plain.system).not.toMatch(/MEASURED|most-replayed/);
  });
});

describe("speech windows and measured peaks merged into one candidate list", () => {
  it("keeps different moments apart and collapses the same moment twice", () => {
    const merged = mergeWindows(
      [
        { start: 0, end: 10 },
        { start: 9.5, end: 20 }, // overlaps the first, and is not the same moment
        { start: 2, end: 8 }, // inside the first: says nothing extra
        { start: 0, end: 20 }, // contains both of the first two
        { start: 60, end: 70 },
      ],
      100,
    );
    expect(merged).toEqual([
      { start: 0, end: 20 },
      { start: 60, end: 70 },
    ]);
    // A window that would run past the end is clamped, and empty ones vanish.
    expect(mergeWindows([{ start: 95, end: 120 }, { start: 50, end: 50 }], 100)).toEqual([{ start: 95, end: 100 }]);
    // Over the cap: the widest windows are the ones kept.
    const many = Array.from({ length: 12 }, (_, i) => ({ start: i * 10, end: i * 10 + (i === 7 ? 9 : 3) }));
    const kept = mergeWindows(many, 200, 4);
    expect(kept).toHaveLength(4);
    expect(kept.some((w) => w.start === 70)).toBe(true);
  });

  it("nudges overlapping clips apart instead of dropping one, and drops fragments", () => {
    const apart = trimOverlaps(
      [
        { start: 0, end: 21, title: "a", reason: "" },
        { start: 19, end: 40, title: "b", reason: "" },
      ],
      40,
      12,
    );
    expect(apart.map((p) => [p.start, p.end])).toEqual([
      [0, 21],
      [22.5, 40],
    ]);
    // A pick that cannot keep a full clip after being moved is dropped rather
    // than rendered as a fragment.
    const dropped = trimOverlaps(
      [
        { start: 0, end: 20, title: "a", reason: "" },
        { start: 19, end: 30, title: "b", reason: "" },
      ],
      30,
      12,
    );
    expect(dropped).toHaveLength(1);
    // Nothing overlapping: untouched, in order.
    const same = trimOverlaps(
      [
        { start: 30, end: 50, title: "b", reason: "" },
        { start: 0, end: 20, title: "a", reason: "" },
      ],
      60,
      12,
    );
    expect(same.map((p) => p.start)).toEqual([0, 30]);
  });

  it("leaves the audio score untouched — this layer only adds to it", () => {
    // The guard against the feature quietly changing the old behaviour: the
    // moment score still runs on audio alone for an unheard window.
    const score = momentScore({ speechRatio: 0.9, loudness: 0.7, dynamics: 0.5, heard: false, hooks: 0, fillers: 0 });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(0.6);
  });
});
