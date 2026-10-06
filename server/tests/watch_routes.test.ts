// The Watching card's own wiring: the HTTP surface the Command Center uses to
// add a channel, change what it cuts, clip the newest one now and stop watching.
// Same fakes as channel_watch.test.ts (a fake YouTube listing and a fake clips
// pipeline) so what's asserted here is the route → store → queue path, not the
// network.
import fs from "node:fs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listChannelVideos: vi.fn(),
  clipsBusy: vi.fn(() => ({ busy: false }) as { busy: boolean; source?: string }),
  startClipsJob: vi.fn(async () => ({ jobIds: ["job-1"], sourceName: "video", count: 3 })),
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
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const conversation = await import("../src/lib/conversation.js");
const watch = await import("../src/lib/channelWatch.js");

const DATA = config.dataDir;
let app: ReturnType<typeof createApp>;

const listing = (videos: Array<{ id: string; title: string }>, channelName = "MrBeast") => ({
  channelId: "UCX6OQ3DkcsbYNE6H8uQQuVA",
  channelName,
  videos: videos.map((v) => ({ ...v, duration: 600, url: `https://www.youtube.com/watch?v=${v.id}` })),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clipsBusy.mockReturnValue({ busy: false });
  mocks.listChannelVideos.mockResolvedValue(
    listing([
      { id: "v1", title: "First" },
      { id: "v2", title: "Second" },
    ]),
  );
  fs.rmSync(DATA, { recursive: true, force: true });
  const store = new JsonStore();
  void store.init();
  setStoreForTests(store);
  conversation.resetConversationForTests();
  watch.resetChannelWatchForTests();
  (config as { desktopApp: boolean }).desktopApp = true;
  app = createApp();
});

describe("the Watching card's routes", () => {
  it("starts empty and says what the card needs to know (limit, cadence, availability)", async () => {
    const res = await request(app).get("/api/v1/watch").expect(200);
    expect(res.body).toMatchObject({ available: true, max: 10, defaultClips: 3, checkEveryMinutes: 5, watches: [] });
  });

  it("adds a channel by its @handle and answers with the whole card, ready to render", async () => {
    const res = await request(app).post("/api/v1/watch").send({ channel: "@MrBeast", clips: 2 }).expect(200);
    expect(mocks.listChannelVideos).toHaveBeenCalledWith(expect.stringContaining("youtube.com/@MrBeast"), { limit: expect.any(Number) });
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toBe("Watching MrBeast — 2 shorts out of every new video.");
    expect(res.body.watches).toHaveLength(1);
    expect(res.body.watches[0]).toMatchObject({
      name: "MrBeast",
      clips: 2,
      queued: 0,
      clippedCount: 0,
      lastClipped: null,
      lastError: null,
    });
    // Videos already up are skipped: the card's list is about what happens next.
    expect(res.body.watches[0].lastClipped).toBeNull();
    expect(watch.listWatches()[0]!.queue).toEqual([]);
  });

  it("a bad link is refused with the channel-shaped answer, not a 500", async () => {
    mocks.listChannelVideos.mockRejectedValue(new Error("Sign in to confirm you're not a bot"));
    const res = await request(app).post("/api/v1/watch").send({ channel: "@does-not-exist" }).expect(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/couldn't read that channel/i);
    expect(res.body.error).toMatch(/Sign in to confirm/);
    expect(watch.listWatches()).toHaveLength(0);
  });

  it("changes clips and focus in place, and clearing the focus really clears it", async () => {
    await request(app).post("/api/v1/watch").send({ channel: "@MrBeast", clips: 2, focus: "the funny bits" }).expect(200);
    const id = watch.listWatches()[0]!.id;

    let res = await request(app).patch(`/api/v1/watch/${id}`).send({ clips: 5 }).expect(200);
    expect(res.body.watches[0]).toMatchObject({ clips: 5, focus: "the funny bits" });

    res = await request(app).patch(`/api/v1/watch/${id}`).send({ focus: null }).expect(200);
    expect(res.body.watches[0].focus).toBeNull();
    expect(watch.listWatches()[0]!.focus).toBeUndefined();

    await request(app).patch("/api/v1/watch/w_nope").send({ clips: 2 }).expect(404);
  });

  it("clips the newest video now, even though it was skipped when the watch started", async () => {
    await request(app).post("/api/v1/watch").send({ channel: "@MrBeast" }).expect(200);
    const id = watch.listWatches()[0]!.id;
    expect(watch.listWatches()[0]!.queue).toEqual([]);

    const res = await request(app).post(`/api/v1/watch/${id}/latest`).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.started).toBe(true);
    expect(res.body.message).toBe("Cutting shorts out of “First” now — they'll appear in the chat.");
    // It really went through the pipeline (not just into a list that never runs).
    expect(mocks.startClipsJob).toHaveBeenCalledWith(expect.objectContaining({ video: "https://www.youtube.com/watch?v=v1" }));
    expect(res.body.watches[0]).toMatchObject({ queued: 0, clippedCount: 1, lastClipped: { title: "First" } });

    // And it isn't clipped twice: asking again queues the same video once more
    // (it is the newest), never twice into one queue.
    await request(app).post(`/api/v1/watch/${id}/latest`).expect(200);
    expect(watch.listWatches()[0]!.queue.map((q) => q.id)).toEqual([]);
  });

  it("with something already rendering, 'cut now' queues it and says so honestly", async () => {
    await request(app).post("/api/v1/watch").send({ channel: "@MrBeast" }).expect(200);
    const id = watch.listWatches()[0]!.id;
    mocks.clipsBusy.mockReturnValue({ busy: true, source: "another video" });

    const res = await request(app).post(`/api/v1/watch/${id}/latest`).expect(200);
    expect(res.body.started).toBe(false);
    expect(res.body.message).toMatch(/next in line/i);
    expect(res.body.watches[0].queued).toBe(1);
    expect(mocks.startClipsJob).not.toHaveBeenCalled();
  });

  it("stops watching one channel and leaves the others alone", async () => {
    await request(app).post("/api/v1/watch").send({ channel: "@MrBeast" }).expect(200);
    mocks.listChannelVideos.mockResolvedValue(listing([{ id: "a1", title: "A" }], "Another Channel"));
    await request(app).post("/api/v1/watch").send({ channel: "@Another" }).expect(200);
    expect(watch.listWatches()).toHaveLength(2);

    const first = watch.listWatches()[0]!.id;
    const res = await request(app).delete(`/api/v1/watch/${first}`).expect(200);
    expect(res.body.watches).toHaveLength(1);
    expect(res.body.watches[0].name).toBe("Another Channel");
    await request(app).delete(`/api/v1/watch/${first}`).expect(404);
  });

  it("a hosted server says it can't watch channels instead of pretending", async () => {
    (config as { desktopApp: boolean }).desktopApp = false;
    const res = await request(app).post("/api/v1/watch").send({ channel: "@MrBeast" }).expect(503);
    expect(res.body.error).toMatch(/desktop app/i);
    // The list still answers (the card uses it to decide whether to show itself).
    const list = await request(app).get("/api/v1/watch").expect(200);
    expect(list.body).toMatchObject({ available: false, watches: [] });
    (config as { desktopApp: boolean }).desktopApp = true;
  });
});
