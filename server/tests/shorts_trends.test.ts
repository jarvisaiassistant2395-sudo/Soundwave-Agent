// The free Shorts trend tracker (lib/shortsTrends.ts): YouTube's own search,
// read through YouTube.js, turned into findings without any AI. The network is
// replaced with fixtures shaped like YouTube.js's result nodes (Video,
// ShortsLockupView, and a ReelShelf that nests them), so this checks the
// parsing, merging and analysis — and that the scout then needs no Gemini.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { config } = await import("../src/config.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const { startFakeGoogle, useFakeGoogle } = await import("./helpers/fakeGoogle.js");
const settings = await import("../src/lib/brain/settings.js");
const trends = await import("../src/lib/trends.js");
const st = await import("../src/lib/shortsTrends.js");

type Fake = Awaited<ReturnType<typeof startFakeGoogle>>;
let fake: Fake;

const id = (n: number) => `vid${String(n).padStart(8, "0")}`; // 11 characters, like a real id

function video(n: number, title: string, views: string, published: string, length: string, channel: string) {
  return {
    type: "Video",
    video_id: id(n),
    title: { text: title },
    author: { name: channel },
    view_count: { text: views },
    published: { text: published },
    length_text: { text: length },
  };
}

function shortCard(n: number, title: string, views: string) {
  return {
    type: "ShortsLockupView",
    entity_id: `shorts-shelf-item-${id(n)}`,
    on_tap_endpoint: { payload: { videoId: id(n) } },
    overlay_metadata: { primary_text: { text: title }, secondary_text: { text: views } },
    accessibility_text: `${title}, ${views} - play Short`,
  };
}

/** A believable week: POV and question hooks doing well, a #psychology wave, mostly short lengths. */
function fixtureFor(query: string, kind: "shorts" | "video"): unknown[] {
  const base = query.length * 100;
  if (kind === "video") {
    return [
      video(base + 1, `POV: you finally notice the ${query} trick #psychology`, "4,200,000 views", "2 days ago", "0:24", "MindLab"),
      video(base + 2, `Why does nobody talk about this ${query} fact?`, "2.1M views", "3 days ago", "0:31", "FactPulse"),
      video(base + 3, `POV: the dark side of ${query} #psychology`, "1.8M views", "1 day ago", "0:19", "DeepThink"),
      video(base + 4, `3 signs of ${query} people miss`, "950K views", "4 days ago", "0:45", "SignalShorts"),
      video(base + 5, `How ${query} quietly changes your brain? #psychology`, "1.2M views", "5 days ago", "0:28", "BrainBits"),
      video(base + 6, `A 25 minute deep dive on ${query}`, "3M views", "2 days ago", "25:10", "LongForm"), // not a Short
      video(base + 7, `POV: your brain on ${query} #mindset`, "780K views", "6 hours ago", "0:15", "QuickMind"),
    ];
  }
  return [
    { type: "ReelShelf", items: [shortCard(base + 1, `POV: you finally notice the ${query} trick #psychology`, "4.3M views"), shortCard(base + 8, `Wait for it… ${query}`, "640K views")] },
    shortCard(base + 9, `Is ${query} real? #mindset`, "1.1M views"),
  ];
}

beforeAll(async () => {
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  fake = await startFakeGoogle();
  useFakeGoogle(config as unknown as Record<string, unknown>, fake);
});

afterAll(async () => {
  st.setShortsSearchForTests(null);
  trends.resetTrendsForTests();
  await fake.close();
});

beforeEach(() => {
  fake.reset();
  trends.resetTrendsForTests();
  settings.resetBrainSettingsForTests();
  st.setShortsSearchForTests(async (q, kind) => fixtureFor(q, kind));
});

describe("reading YouTube's display text", () => {
  it("parses view counts in every shape YouTube shows", () => {
    expect(st.parseViews("1,234,567 views")).toBe(1_234_567);
    expect(st.parseViews("1.2M views")).toBe(1_200_000);
    expect(st.parseViews("950K views")).toBe(950_000);
    expect(st.parseViews("3.4 million views")).toBe(3_400_000);
    expect(st.parseViews("1B views")).toBe(1_000_000_000);
    expect(st.parseViews("No views")).toBe(0);
    expect(st.parseViews("")).toBe(0);
  });

  it("parses upload age and length", () => {
    expect(st.parseAgeHours("3 days ago")).toBe(72);
    expect(st.parseAgeHours("6 hours ago")).toBe(6);
    expect(st.parseAgeHours("1 week ago")).toBe(168);
    expect(st.parseAgeHours("yesterday-ish")).toBeUndefined();
    expect(st.parseLength("0:58")).toBe(58);
    expect(st.parseLength("1:02:03")).toBe(3723);
    expect(st.parseLength("LIVE")).toBeUndefined();
  });

  it("turns result nodes into Shorts, and drops long videos and junk", () => {
    const v = st.normalizeNode(video(1, "POV: test", "2.1M views", "2 days ago", "0:30", "Chan"), "facts")!;
    expect(v).toMatchObject({ id: id(1), views: 2_100_000, ageHours: 48, seconds: 30, channel: "Chan", url: `https://www.youtube.com/shorts/${id(1)}` });
    expect(st.normalizeNode(shortCard(2, "A Short", "640K views"), "facts")).toMatchObject({ id: id(2), title: "A Short", views: 640_000 });
    expect(st.normalizeNode(video(3, "Long one", "3M views", "2 days ago", "25:10", "X"), "facts")).toBeNull();
    expect(st.normalizeNode({ type: "Channel", id: "UC123" }, "facts")).toBeNull();
    expect(st.normalizeNode({ type: "Video", video_id: "bad id", title: { text: "x" } }, "facts")).toBeNull();
  });
});

describe("a scan", () => {
  it("searches every query both ways, merges duplicates and keeps the best data", async () => {
    const seen: string[] = [];
    st.setShortsSearchForTests(async (q, kind) => {
      seen.push(`${kind}:${q}`);
      return fixtureFor(q, kind);
    });
    const { shorts, failures } = await st.collectTrendingShorts({ queries: [{ query: "habits", label: "Psychology & Mind Tricks" }] });
    expect(seen).toEqual(["video:habits", "shorts:habits"]);
    expect(failures).toBe(0);
    const merged = shorts.find((s) => s.id === id(601))!; // in both the video results and the shelf
    expect(merged.views).toBe(4_300_000); // the higher count
    expect(merged.channel).toBe("MindLab"); // from the video result
    expect(merged.ageHours).toBe(48);
    expect(merged.velocity).toBe(Math.round(4_300_000 / 48));
    expect(shorts.some((s) => s.title.includes("25 minute"))).toBe(false);
  });

  it("finds hooks, hashtags, topics and length without any model", async () => {
    const scan = await st.scanTrendingShorts();
    expect(scan.findings.length).toBeGreaterThanOrEqual(3);
    const all = scan.findings.join("\n");
    expect(all).toMatch(/Fastest climber: “/);
    expect(all).toMatch(/POV/);
    expect(all).toMatch(/#psychology/);
    expect(all).toMatch(/Typical length of this week's top Shorts: \d+ seconds/);
    expect(scan.shorts[0]!.views).toBeGreaterThanOrEqual(scan.shorts[1]!.views);
    for (const f of scan.findings) expect(f.length).toBeLessThanOrEqual(240);
  });

  it("gives up quickly when YouTube can't be reached", async () => {
    let calls = 0;
    st.setShortsSearchForTests(async () => {
      calls++;
      throw new Error("getaddrinfo ENOTFOUND www.youtube.com");
    });
    await expect(st.scanTrendingShorts()).rejects.toThrow(/could not be reached/);
    expect(calls).toBeLessThanOrEqual(4);
  });

  it("still works when some searches fail", async () => {
    let n = 0;
    st.setShortsSearchForTests(async (q, kind) => {
      if (n++ % 4 === 1) throw new Error("HTTP 429");
      return fixtureFor(q, kind);
    });
    const scan = await st.scanTrendingShorts();
    expect(scan.failures).toBeGreaterThan(0);
    expect(scan.findings.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the trend scout uses it first, for free", () => {
  it("refreshes from YouTube with zero Gemini calls, even with a key saved", async () => {
    settings.saveBrainSettings({ apiKey: "AIzaSyTREND-test-key-000wxyz" });
    const result = await trends.refreshTrends({ reason: "schedule" });
    expect(result.ok).toBe(true);
    expect(fake.generateCalls()).toHaveLength(0);

    const status = trends.trendsStatus();
    expect(status).toMatchObject({ available: true, via: "youtube", needsKey: false, due: false });
    expect(status.findings.length).toBeGreaterThanOrEqual(3);
    expect(status.top.length).toBeGreaterThan(5);
    expect(status.top[0]).toMatchObject({ url: expect.stringMatching(/^https:\/\/www\.youtube\.com\/shorts\//) });
    expect(status.sources[0]).toMatch(/YouTube search/);
  });

  it("works with no Gemini key at all", async () => {
    const result = await trends.refreshTrends({ reason: "startup" });
    expect(result.ok).toBe(true);
    expect(trends.trendsStatus().via).toBe("youtube");
  });
});
