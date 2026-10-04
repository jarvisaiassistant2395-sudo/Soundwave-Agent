// "Brief me on the views": lib/channelInsights.ts reads each connected
// channel's real numbers from YouTube (per-channel sign-in), remembers every
// look so the next briefing can say what changed, and the agent's youtube_views
// tool turns that into a report. The stand-in answers per account, so a channel
// with a dead sign-in can't hide behind a working one.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeGoogle, useFakeGoogle, type FakeGoogle } from "./helpers/fakeGoogle.js";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
});

const { config } = await import("../src/config.js");
const { youtubeService } = await import("../src/lib/youtube.js");
const { channelInsights, legacyChannelInsight } = await import("../src/lib/channelInsights.js");
const channels = await import("../src/lib/youtubeChannels.js");
const { viewsBriefing, viewsSummary, formatCount, describeGap } = await import("../src/lib/brain/core/insights.js");
const { AGENT_TOOLS } = await import("../src/lib/brain/tools.js");

let fake: FakeGoogle;

const historyFile = () => path.join(config.dataDir, "youtube", "view-history.json");

const TWO_CHANNELS: FakeGoogle["accounts"] = [
  {
    refreshToken: "1//orbit-refresh",
    id: "UCorbit",
    title: "Orbit Facts",
    subscribers: "1234",
    views: "98765",
    videos: "42",
    uploads: [
      { id: "vidA", title: "Black holes in 60 seconds", views: "4321", publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      { id: "vidB", title: "Why the sky is dark", views: "980", publishedAt: new Date(Date.now() - 5 * 86_400_000).toISOString() },
    ],
  },
  {
    refreshToken: "1//demos-refresh",
    id: "UCdemos",
    title: "Soundwave Demos",
    subscribers: "77",
    views: "1500",
    videos: "6",
    uploads: [{ id: "vidC", title: "Soundwave makes a short in one press", views: "640", publishedAt: new Date(Date.now() - 86_400_000).toISOString() }],
  },
];

beforeAll(async () => {
  fake = await startFakeGoogle();
  useFakeGoogle(config as unknown as Record<string, unknown>, fake);
});

afterAll(async () => {
  await fake.close();
  // The data dir is shared with every other test file: leave no connected
  // channel (or view history) behind for the next one.
  fs.rmSync(path.join(config.dataDir, "youtube"), { recursive: true, force: true });
});

beforeEach(() => {
  fake.reset();
  fs.rmSync(path.join(config.dataDir, "youtube"), { recursive: true, force: true });
  fs.rmSync(path.join(config.dataDir, "agent-conversation.json"), { force: true });
  channels.resetChannelsForTests();
  // A build with Soundwave's own Google client (what a release ships): the
  // channels' sign-ins refresh against the stand-in. No legacy account is left
  // behind, so tests that want one save it themselves.
  youtubeService.saveConfig({
    clientId: "cid.apps.googleusercontent.com",
    clientSecret: "s3cret",
    refreshToken: "",
    channelTitle: undefined,
    channelId: undefined,
    autoPublish: false,
  });
});

const connectBoth = () => {
  fake.accounts = TWO_CHANNELS.map((a) => ({ ...a, uploads: a.uploads.map((u) => ({ ...u })) }));
  channels.registerChannel({ refreshToken: TWO_CHANNELS[0]!.refreshToken, channelTitle: "Orbit Facts" });
  channels.registerChannel({ refreshToken: TWO_CHANNELS[1]!.refreshToken, channelTitle: "Soundwave Demos" });
};

const viewsTool = AGENT_TOOLS.find((t) => t.declaration.name === "youtube_views")!;
const toolCtx = () => ({
  userId: "local-user",
  voice: "en-US-GuyNeural",
  resolution: "1080p" as const,
  seconds: 60,
  desktop: true,
  platform: "win32" as NodeJS.Platform,
  effects: { log: [] as string[] },
});

describe("reading the numbers", () => {
  it("reports every connected channel with its own sign-in", async () => {
    connectBoth();
    const result = await channelInsights({ recent: 5 });
    expect(result.errors).toEqual([]);
    expect(result.channels.map((c) => c.channelTitle)).toEqual(["Orbit Facts", "Soundwave Demos"]);
    const orbit = result.channels[0]!;
    expect(orbit.views).toBe(98_765);
    expect(orbit.subscribers).toBe(1234);
    expect(orbit.videos).toBe(42);
    expect(orbit.recent.map((v) => [v.title, v.views])).toEqual([
      ["Black holes in 60 seconds", 4321],
      ["Why the sky is dark", 980],
    ]);
    expect(orbit.gainedViews).toBeNull(); // first look: no invented "+0"
    expect(result.channels[1]!.views).toBe(1500);
  });

  it("says what changed since the last look, and keeps the history small", async () => {
    connectBoth();
    const dayAgo = new Date(Date.now() - 26 * 3_600_000);
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    const first = (await channelInsights({ now: dayAgo })).channels[0]!;
    fs.writeFileSync(
      historyFile(),
      JSON.stringify({ [first.id]: [{ at: first.lastCheckedAt ?? dayAgo.toISOString(), views: 98_765, subscribers: 1234, videos: 42 }] }),
    );
    // The channel grew since that look (the stand-in's numbers are what we set).
    fake.accounts[0]!.views = "99180";
    const grew = await channelInsights({ now: new Date() });
    const orbit = grew.channels.find((c) => c.channelTitle === "Orbit Facts")!;
    expect(orbit.gainedViews).toBe(415);
    expect(orbit.lastCheckedAt).toBeTruthy();

    const saved = JSON.parse(fs.readFileSync(historyFile(), "utf8")) as Record<string, unknown[]>;
    expect(saved[orbit.id]!.length).toBe(2);
    // A second look seconds later doesn't pile on another snapshot.
    await channelInsights({ now: new Date() });
    expect((JSON.parse(fs.readFileSync(historyFile(), "utf8")) as Record<string, unknown[]>)[orbit.id]!.length).toBe(2);
  });

  it("names the channel whose sign-in died, and still reports the other", async () => {
    connectBoth();
    fake.badRefreshTokens.push(TWO_CHANNELS[1]!.refreshToken);
    const result = await channelInsights({});
    expect(result.channels.map((c) => c.channelTitle)).toEqual(["Orbit Facts"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Soundwave Demos/);
    expect(result.errors[0]).toMatch(/reconnect/i);
  });

  it("answers honestly when nothing is connected, and for a channel that isn't", async () => {
    const none = await channelInsights({});
    expect(none.channels).toEqual([]);
    expect(none.errors[0]).toMatch(/No YouTube channel is connected/i);

    connectBoth();
    const wrong = await channelInsights({ channel: "My channel" });
    expect(wrong.channels).toEqual([]);
    expect(wrong.errors[0]).toMatch(/No channel called “My channel”/);
    expect(wrong.errors[0]).toMatch(/Orbit Facts/);
  });
});

describe("the agent's youtube_views tool", () => {
  it("returns a report a person could be briefed with", async () => {
    connectBoth();
    const out = (await viewsTool.run({}, toolCtx())) as {
      ok: boolean;
      report: string;
      summary: string;
      channels: Array<{ channelTitle: string; totalViews: number; latest: Array<{ title: string; views: number }> }>;
    };
    expect(out.ok).toBe(true);
    expect(out.report).toMatch(/Channel “Orbit Facts”: 98,765 total views/);
    expect(out.report).toMatch(/“Black holes in 60 seconds” — 4,321 views \(posted 2 days ago\)/);
    expect(out.report).toMatch(/Soundwave Demos/);
    expect(out.report).toMatch(/All connected channels together: 100,265 views/);
    expect(out.summary).toMatch(/2 channels has 100,265 views in total|has 100,265 views in total/);
    expect(out.channels.map((c) => c.channelTitle)).toEqual(["Orbit Facts", "Soundwave Demos"]);
    expect(out.channels[0]!.latest[0]).toMatchObject({ title: "Black holes in 60 seconds", views: 4321 });
  });

  it("can report one channel only", async () => {
    connectBoth();
    const out = (await viewsTool.run({ channel: "Soundwave Demos", videos: 1 }, toolCtx())) as { report: string; channels: unknown[] };
    expect(out.channels).toHaveLength(1);
    expect(out.report).toMatch(/Soundwave Demos/);
    expect(out.report).not.toMatch(/Orbit Facts/);
  });

  it("falls back to the legacy single connection when no channel is registered", async () => {
    youtubeService.saveConfig({ refreshToken: "1//legacy-token", channelTitle: "Orbit Facts" });
    const legacy = await legacyChannelInsight({});
    expect(legacy?.channelTitle).toBe("Orbit Facts");
    expect(legacy?.views).toBe(98_765);
    const out = (await viewsTool.run({}, toolCtx())) as { ok: boolean; report: string };
    expect(out.ok).toBe(true);
    expect(out.report).toMatch(/Orbit Facts/);
  });

  it("tells the truth when there is nothing connected at all", async () => {
    // No channel registered and no legacy refresh token in the config: nothing
    // to read, and the tool says so instead of showing zeros.
    const out = (await viewsTool.run({}, toolCtx())) as { ok: boolean; reason: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/No YouTube channel is connected|No YouTube channel/i);
  });
});

describe("the wording itself", () => {
  const now = new Date("2026-10-04T09:00:00Z");

  it("numbers with separators, and never invents a zero", () => {
    expect(formatCount(98_765)).toBe("98,765");
    expect(formatCount(null)).toBe("unknown");
    expect(formatCount(0)).toBe("0");
  });

  it("describes a gap in plain words", () => {
    expect(describeGap("2026-10-04T08:59:30Z", now)).toBe("just now");
    expect(describeGap("2026-10-04T08:30:00Z", now)).toBe("30 minutes ago");
    expect(describeGap("2026-10-03T09:00:00Z", now)).toBe("yesterday");
    expect(describeGap("2026-10-01T09:00:00Z", now)).toBe("3 days ago");
    expect(describeGap(null, now)).toBe("");
  });

  it("hides what YouTube hides, and flags a shrinking channel", () => {
    const text = viewsBriefing(
      [
        {
          name: "Orbit Facts",
          channelTitle: "Orbit Facts",
          subscribers: null,
          views: 1000,
          videos: 2,
          recent: [{ title: "Hidden numbers", views: null, publishedAt: null }],
          gainedViews: -20,
          lastCheckedAt: "2026-10-03T09:00:00Z",
        },
      ],
      [],
      now,
    );
    expect(text).toMatch(/views hidden by YouTube/);
    expect(text).toMatch(/−20 views since I looked yesterday/);
    expect(viewsSummary([{ name: "x", subscribers: null, views: 10, videos: 1, recent: [], gainedViews: null, lastCheckedAt: null }])).toMatch(/10 views in total\./);
  });
});
