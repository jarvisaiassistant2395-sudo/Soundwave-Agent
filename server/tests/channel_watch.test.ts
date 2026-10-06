// Watching a YouTube channel: "clip whatever @creator posts". The pure rules
// first (what a channel reference is, what's new, how often), then the tool the
// agent uses — add, list, stop — and one real tick with a fake YouTube and a
// fake clips pipeline, because that's where "it just works" is decided.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listChannelVideos: vi.fn(),
  clipsBusy: vi.fn(() => ({ busy: false }) as { busy: boolean; source?: string }),
  startClipsJob: vi.fn(async () => ({ jobIds: ["job-1", "job-2", "job-3"], sourceName: "video", count: 3 })),
}));

vi.mock("../src/lib/ytdlp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ytdlp.js")>();
  return { ...actual, listChannelVideos: mocks.listChannelVideos };
});
vi.mock("../src/lib/videoClips.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/videoClips.js")>();
  return { ...actual, clipsBusy: mocks.clipsBusy, startClipsJob: mocks.startClipsJob };
});

const { config } = await import("../src/config.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const conversation = await import("../src/lib/conversation.js");
const watch = await import("../src/lib/channelWatch.js");
const rules = await import("../src/lib/brain/core/watch.js");
const { toolsFor } = await import("../src/lib/brain/tools.js");

const listing = (videos: Array<{ id: string; title: string }>, channelName = "MrBeast") => ({
  channelId: "UCX6OQ3DkcsbYNE6H8uQQuVA",
  channelName,
  videos: videos.map((v) => ({ ...v, duration: 600, url: `https://www.youtube.com/watch?v=${v.id}` })),
});

let i = 0;
const ctx = () => ({
  userId: `watch-test-${++i}`,
  voice: "en-US-AvaMultilingualNeural",
  resolution: "720p" as const,
  desktop: true,
  platform: "win32" as const,
  effects: { log: [] as string[] },
});
const tool = (name: string) => toolsFor(ctx() as never).find((t) => t.declaration.name === name);

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.clipsBusy.mockReturnValue({ busy: false });
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  fs.rmSync(path.join(config.dataDir, "channel-watches.json"), { force: true });
  conversation.resetConversationForTests();
  watch.resetChannelWatchForTests();
});

describe("what a channel reference is", () => {
  it("takes @handles, bare handles and every kind of channel link", () => {
    expect(rules.parseChannelInput("@MrBeast")).toMatchObject({ tabUrl: "https://www.youtube.com/@MrBeast/videos", slug: "@mrbeast" });
    expect(rules.parseChannelInput("MrBeast")).toMatchObject({ tabUrl: "https://www.youtube.com/@MrBeast/videos" });
    expect(rules.parseChannelInput("youtube.com/@MrBeast")).toMatchObject({ tabUrl: "https://www.youtube.com/@MrBeast/videos" });
    expect(rules.parseChannelInput("https://www.youtube.com/@MrBeast/videos")).toMatchObject({ tabUrl: "https://www.youtube.com/@MrBeast/videos" });
    expect(rules.parseChannelInput("https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA")).toMatchObject({
      tabUrl: "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA/videos",
    });
    expect(rules.parseChannelInput("youtube.com/c/OldStyle")).toMatchObject({ tabUrl: "https://www.youtube.com/c/OldStyle/videos" });
  });

  it("refuses videos and prose — that's the other tool's job", () => {
    for (const bad of ["", "   ", "make shorts of mr beast", "https://youtu.be/dQw4w9WgXcQ", "youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/shorts/abc", "a".repeat(400)]) {
      expect(rules.parseChannelInput(bad), bad.slice(0, 40)).toBeNull();
    }
  });

  it("keeps the clips count inside 1–5 and defaults to 3", () => {
    expect(rules.clampWatchClips(undefined)).toBe(3);
    expect(rules.clampWatchClips(2)).toBe(2);
    expect(rules.clampWatchClips(0)).toBe(1);
    expect(rules.clampWatchClips(99)).toBe(5);
    expect(rules.clampWatchClips(Number.NaN)).toBe(3);
  });
});

describe("what counts as new", () => {
  const video = (id: string) => ({ id, title: `Video ${id}`, url: `https://youtu.be/${id}` });

  it("takes only unseen uploads, oldest first, and no more than three at once", () => {
    const list = [video("new1"), video("new2"), video("new3"), video("new4"), video("old")];
    const plan = rules.planWatch(list, ["old"]);
    // The newest three, flipped so the channel's uploads are cut in order.
    expect(plan.take.map((v) => v.id)).toEqual(["new3", "new2", "new1"]);
    expect(plan.later).toBe(1);
  });

  it("skips what's already queued or clipped, and knows an empty channel", () => {
    const plan = rules.planWatch([video("a"), video("b")], ["a", "b"]);
    expect(plan.take).toEqual([]);
    expect(plan.later).toBe(0);
    expect(rules.planWatch([], ["a"]).take).toEqual([]);
  });

  it("writes the status and the announcements people read", () => {
    expect(rules.watchStatusText({ slug: "@mrbeast", clips: 3, queued: 1, clippedCount: 4, lastCheckedAt: Date.now() - 120_000 })).toBe(
      "Watching @mrbeast, 3 shorts per new video, checked 2 minutes ago, 4 videos clipped so far — 1 video waiting to be cut",
    );
    expect(rules.watchStatusText({ slug: "@x", clips: 1, queued: 0, clippedCount: 0, lastCheckedAt: null })).toContain("never checked yet");
    expect(rules.watchStatusText({ channelName: "MrBeast", slug: "@mrbeast", clips: 2, queued: 0, clippedCount: 0, lastCheckedAt: Date.now(), lastError: "yt-dlp failed" })).toContain("last check failed");
    expect(rules.newUploadText("MrBeast", { id: "abc", title: "I Built A Pool", url: "" }, 3)).toContain("MrBeast posted “I Built A Pool” — cutting 3 shorts");
    expect(rules.laterText("MrBeast", 2)).toContain("2 more new videos");
  });
});

describe("the agent's tools", () => {
  it("starts watching a channel (only new uploads) and says what it will do", async () => {
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000001", title: "Old video" }]));
    const c = ctx();
    const result = await tool("watch_youtube_channel")!.run({ channel: "@MrBeast", clips: 2 }, c as never);
    expect(result).toMatchObject({ started: true, channel: "MrBeast", clips: 2, alreadyWatching: false });
    expect(String(result.note)).toContain("videos already up are skipped");
    expect(watch.listWatches()).toHaveLength(1);
    expect(c.effects.log.join(" ")).toContain("Watching MrBeast");
    // The existing video is remembered, not queued: adding a watch never queues the back catalogue.
    const stored = watch.listWatches()[0]!;
    expect(stored.seen).toEqual(["vid00000001"]);
    expect(stored.queue).toEqual([]);
  });

  it("can clip the newest video too when asked", async () => {
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000001", title: "Newest" }]));
    const result = await tool("watch_youtube_channel")!.run({ channel: "@MrBeast", latest: true }, ctx() as never);
    expect(String(result.note)).toContain("starting with the newest one now");
    const stored = watch.listWatches()[0]!;
    expect(stored.queue.map((q) => q.id)).toEqual(["vid00000001"]);
    expect(stored.seen).toEqual([]);
  });

  it("updates an existing watch instead of adding a second one", async () => {
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000001", title: "Old" }]));
    await tool("watch_youtube_channel")!.run({ channel: "@MrBeast" }, ctx() as never);
    const again = await tool("watch_youtube_channel")!.run({ channel: "youtube.com/@MrBeast", clips: 5, focus: "the funny bits" }, ctx() as never);
    expect(again).toMatchObject({ started: true, alreadyWatching: true, clips: 5 });
    expect(watch.listWatches()).toHaveLength(1);
    expect(watch.listWatches()[0]!.focus).toBe("the funny bits");
  });

  it("refuses a video link and a channel that can't be read", async () => {
    const bad = await tool("watch_youtube_channel")!.run({ channel: "https://youtu.be/dQw4w9WgXcQ" }, ctx() as never);
    expect(bad).toMatchObject({ started: false });
    expect(String(bad.reason)).toContain("not a video");

    mocks.listChannelVideos.mockRejectedValue(new Error("This channel does not exist"));
    const missing = await tool("watch_youtube_channel")!.run({ channel: "@NoSuchChannel" }, ctx() as never);
    expect(missing).toMatchObject({ started: false });
    expect(String(missing.reason)).toContain("couldn't read that channel");
    expect(watch.listWatches()).toHaveLength(0);
  });

  it("lists what's watched and stops watching", async () => {
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000001", title: "Old" }]));
    await tool("watch_youtube_channel")!.run({ channel: "@MrBeast" }, ctx() as never);
    const listed = await tool("list_watched_channels")!.run({}, ctx() as never);
    expect(listed.count).toBe(1);
    expect(String((listed.watching as string[])[0])).toContain("Watching MrBeast, 3 shorts per new video");

    const stopped = await tool("stop_watching_channel")!.run({ channel: "all" }, ctx() as never);
    expect(stopped).toMatchObject({ stopped: true, channels: ["MrBeast"] });
    expect(watch.listWatches()).toHaveLength(0);
    const nothing = await tool("stop_watching_channel")!.run({ channel: "@MrBeast" }, ctx() as never);
    expect(nothing).toMatchObject({ stopped: false });
  });
});

describe("a check while the app runs", () => {
  it("announces a new upload and hands it to the clips pipeline", async () => {
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000001", title: "Old video" }]));
    await tool("watch_youtube_channel")!.run({ channel: "@MrBeast", clips: 2, focus: "the funny bits" }, ctx() as never);

    // A new video is posted.
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000002", title: "I Built A Pool" }, { id: "vid00000001", title: "Old video" }]));
    await watch.tickWatches(Date.now() + 11 * 60_000);

    expect(mocks.startClipsJob).toHaveBeenCalledTimes(1);
    expect(mocks.startClipsJob).toHaveBeenCalledWith(expect.objectContaining({ video: "https://www.youtube.com/watch?v=vid00000002", count: 2, focus: "the funny bits" }));
    const messages = conversation.getConversation().messages.map((m) => m.text).join("\n");
    expect(messages).toContain("MrBeast posted “I Built A Pool” — cutting 2 shorts");
    const stored = watch.listWatches()[0]!;
    expect(stored.queue).toEqual([]);
    expect(stored.seen).toContain("vid00000002");
    expect(stored.clipped.map((c) => c.id)).toEqual(["vid00000002"]);
  });

  it("waits while something else renders, and doesn't cut the same video twice", async () => {
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000001", title: "Old video" }]));
    await tool("watch_youtube_channel")!.run({ channel: "@MrBeast" }, ctx() as never);
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000002", title: "New video" }, { id: "vid00000001", title: "Old video" }]));

    // A short is rendering: the video is queued and announced later, not dropped.
    mocks.clipsBusy.mockReturnValue({ busy: true, source: "another video" });
    await watch.tickWatches(Date.now() + 11 * 60_000);
    expect(mocks.startClipsJob).not.toHaveBeenCalled();
    expect(watch.listWatches()[0]!.queue.map((q) => q.id)).toEqual(["vid00000002"]);

    // Free again (and not before the re-check window): it starts, once.
    mocks.clipsBusy.mockReturnValue({ busy: false });
    await watch.tickWatches(Date.now() + 12 * 60_000);
    await watch.tickWatches(Date.now() + 13 * 60_000);
    expect(mocks.startClipsJob).toHaveBeenCalledTimes(1);
    expect(watch.listWatches()[0]!.queue).toEqual([]);
    expect(watch.listWatches()[0]!.seen).toContain("vid00000002");
  });

  it("keeps a failed clip queued, then gives up out loud — and never loses the reason", async () => {
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000001", title: "Old" }]));
    await tool("watch_youtube_channel")!.run({ channel: "@MrBeast" }, ctx() as never);
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000002", title: "Doomed video" }, { id: "vid00000001", title: "Old" }]));
    mocks.startClipsJob.mockRejectedValue(new Error("yt-dlp couldn't download it"));

    await watch.tickWatches(Date.now() + 11 * 60_000);
    expect(watch.listWatches()[0]!.queue[0]!.attempts).toBe(1);
    await watch.tickWatches(Date.now() + 12 * 60_000);
    await watch.tickWatches(Date.now() + 13 * 60_000);
    const stored = watch.listWatches()[0]!;
    expect(stored.queue).toEqual([]);
    expect(stored.seen).toContain("vid00000002");
    expect(conversation.getConversation().messages.map((m) => m.text).join("\n")).toContain("I couldn't cut “Doomed video”");
  });

  it("survives a broken check: the error is kept for the status, nothing is re-announced", async () => {
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "vid00000001", title: "Old" }]));
    await tool("watch_youtube_channel")!.run({ channel: "@MrBeast" }, ctx() as never);
    mocks.listChannelVideos.mockRejectedValue(new Error("network is down"));
    await watch.tickWatches(Date.now() + 11 * 60_000);
    expect(watch.listWatches()[0]!.lastError).toContain("network is down");
    expect(watch.listWatches()[0]!.queue).toEqual([]);
    expect(mocks.startClipsJob).not.toHaveBeenCalled();
  });
});
