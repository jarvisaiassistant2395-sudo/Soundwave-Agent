// "Make shorts from this video" as the agent sees it: the tool exists on the PC,
// refuses honestly when the video is wrong, queues when the renderer is busy,
// and hands the work to the clips pipeline. The pipeline's own ffmpeg work is
// mocked here (CI has no video to cut in this test); the pure rules are covered
// in clips.test.ts and clip_queue.test.ts, and the real pipeline — including the
// queue draining and a crash mid-render — in video_clips.test.ts.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  clipsBusy: vi.fn(
    () => ({ busy: false }) as { busy: boolean; source?: string; queued?: number; waitingFor?: string[] },
  ),
  startClipsJob: vi.fn(async (opts: { video: string; count?: number }) => ({
    jobIds: ["job-clip-1", "job-clip-2", "job-clip-3"].slice(0, opts.count ?? 3),
    sourceName: "A Long Talk",
    count: opts.count ?? 3,
    queued: false,
    position: 0,
    waitingAhead: 0,
  })),
  startShortJob: vi.fn(async () => ({ jobId: "job-short" })),
  getActiveShortJobs: vi.fn((): Array<{ jobId: string; topic: string; startedAt: number }> => []),
}));

vi.mock("../src/lib/videoClips.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/videoClips.js")>();
  return { ...actual, clipsBusy: mocks.clipsBusy, startClipsJob: mocks.startClipsJob };
});
vi.mock("../src/routes/agentShort.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/agentShort.js")>();
  return { ...actual, startShortJob: mocks.startShortJob, getActiveShortJobs: mocks.getActiveShortJobs };
});

const { config } = await import("../src/config.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const { toolsFor } = await import("../src/lib/brain/tools.js");
const clips = await import("../src/lib/videoClips.js");
const { createApp } = await import("../src/app.js");

let i = 0;
const ctx = (desktop = true) => ({
  userId: `clip-test-${++i}`,
  voice: "en-US-AvaMultilingualNeural",
  resolution: "720p" as const,
  desktop,
  platform: "win32" as const,
  effects: { log: [] as string[] },
});

const tool = (desktop = true) => toolsFor(ctx(desktop) as never).find((t) => t.declaration.name === "make_shorts_from_video");

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.clipsBusy.mockReturnValue({ busy: false });
  mocks.getActiveShortJobs.mockReturnValue([]);
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  // The card's GET reads the real queue off disk; a file an earlier file's tests
  // left behind would make it look busy.
  fs.rmSync(path.join(config.dataDir, "clips-queue.json"), { force: true });
  clips._resetClipsForTests();
});

describe("the tool the agent is offered", () => {
  it("exists on the PC, with the real arguments, and not on the phone", () => {
    const t = tool();
    expect(t).toBeTruthy();
    expect(t!.declaration.parameters?.required).toEqual(["video"]);
    expect(Object.keys(t!.declaration.parameters?.properties ?? {})).toEqual(["video", "count", "focus"]);
    expect(t!.declaration.description).toMatch(/path of a video file/);
    expect(tool(false), "clips are rendered on the PC").toBeFalsy();
  });

  it("starts the job and tells the person what will happen", async () => {
    const c = ctx();
    const result = await tool()!.run({ video: "https://youtu.be/dQw4w9WgXcQ", count: 2, focus: "the funny bits" }, c as never);
    expect(result).toMatchObject({ started: true, clips: 2, video: "A Long Talk" });
    expect(String(result.note)).toContain("Listening to “A Long Talk”");
    expect(c.effects.log.join(" ")).toContain("2 short(s) out of “A Long Talk”");
    expect(mocks.startClipsJob).toHaveBeenCalledWith(expect.objectContaining({ video: "https://youtu.be/dQw4w9WgXcQ", count: 2, focus: "the funny bits" }));
  });

  it("asks which video instead of guessing", async () => {
    const result = await tool()!.run({}, ctx() as never);
    expect(result).toMatchObject({ started: false });
    expect(String(result.reason)).toContain("Which video?");
    expect(mocks.startClipsJob).not.toHaveBeenCalled();
  });

  it("queues behind what's rendering instead of refusing the person", async () => {
    // One video renders at a time, but "clip these three" must not answer one
    // and drop two: the pipeline queues this one and says where it landed.
    mocks.clipsBusy.mockReturnValue({ busy: true, source: "An Old Panel", queued: 1, waitingFor: ["Another Talk"] });
    mocks.startClipsJob.mockResolvedValueOnce({
      jobIds: ["job-q-1"],
      sourceName: "A Long Talk",
      count: 1,
      queued: true,
      position: 2,
      waitingAhead: 1,
    });
    const result = await tool()!.run({ video: "x.mp4" }, ctx() as never);
    expect(result).toMatchObject({ started: true, queued: true, position: 2, clips: 1 });
    expect(String(result.note)).toContain("queued behind 2 videos");
    expect(String(result.note)).toContain("one renders at a time");
    expect(mocks.startClipsJob).toHaveBeenCalled();
  });

  it("reports the queue when it's full and nothing can be taken on", async () => {
    mocks.clipsBusy.mockReturnValue({ busy: true, source: "An Old Panel", queued: 8 });
    mocks.startClipsJob.mockRejectedValueOnce(new Error("I've already got 8 videos waiting to be clipped — ask me again once some of them are done."));
    const result = await tool()!.run({ video: "x.mp4" }, ctx() as never);
    expect(result).toMatchObject({ started: false, busy: true, renderingNow: "An Old Panel", queued: 8 });
    expect(String(result.reason)).toContain("8 videos waiting");
  });

  it("passes the pipeline's own words back when the video is no good", async () => {
    mocks.startClipsJob.mockRejectedValueOnce(new Error("There's no file at /tmp/nope.mp4. Give me a YouTube link, or the path of a video on this PC."));
    const result = await tool()!.run({ video: "/tmp/nope.mp4" }, ctx() as never);
    expect(result).toMatchObject({ started: false });
    expect(String(result.reason)).toContain("There's no file at /tmp/nope.mp4");
  });

  it("keeps the count inside 1–5", async () => {
    await tool()!.run({ video: "x.mp4", count: 99 }, ctx() as never);
    expect(mocks.startClipsJob).toHaveBeenLastCalledWith(expect.objectContaining({ count: 5 }));
    await tool()!.run({ video: "x.mp4", count: Number.NaN }, ctx() as never);
    expect(mocks.startClipsJob).toHaveBeenLastCalledWith(expect.objectContaining({ count: 3 }));
  });

  it("makes the shorts tool wait while clips are being cut", async () => {
    mocks.clipsBusy.mockReturnValue({ busy: true, source: "A Long Talk" });
    const shortTool = toolsFor(ctx() as never).find((t) => t.declaration.name === "make_youtube_short")!;
    const result = await shortTool.run({ topic: "coffee" }, ctx() as never);
    expect(result).toMatchObject({ started: false, busy: true });
    expect(String(result.reason)).toContain("A Long Talk");
    expect(mocks.startShortJob).not.toHaveBeenCalled();
  });
});

describe("reading a source that isn't there", () => {
  it("says the path doesn't exist, and that a bad file isn't a video", async () => {
    await expect(clips.checkSource("/tmp/definitely-not-here.mp4")).rejects.toThrow(/There's no file at/);
    const text = path.join(config.uploadsDir, "notes.txt");
    fs.writeFileSync(text, "not a video");
    await expect(clips.checkSource(text)).rejects.toThrow(/isn't a video file/);
    await expect(clips.checkSource("   ")).rejects.toThrow(/paste a YouTube link/);
  });
});

// ── The same job, started from the Command Center card ──────────────────────
// The card posts to this route, so it must behave exactly like the tool: one
// video at a time, a real reason when the source is wrong, and no pretending.

describe("POST /api/v1/clips — the card's way in", () => {
  it("starts the job and answers with what will happen", async () => {
    const app = createApp();
    const res = await request(app).post("/api/v1/clips").send({ video: "https://youtu.be/dQw4w9WgXcQ", count: 2, focus: "the funny bits" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, video: "A Long Talk", count: 2, jobIds: ["job-clip-1", "job-clip-2"] });
    expect(String(res.body.message)).toContain("Listening to “A Long Talk”");
    expect(mocks.startClipsJob).toHaveBeenCalledWith(expect.objectContaining({ video: "https://youtu.be/dQw4w9WgXcQ", count: 2, focus: "the funny bits" }));
  });

  it("queues a second video while one is being cut, and says where it landed", async () => {
    mocks.clipsBusy.mockReturnValue({ busy: true, source: "A Long Talk" });
    mocks.startClipsJob.mockResolvedValueOnce({
      jobIds: ["job-q-9"],
      sourceName: "Another Talk",
      count: 1,
      queued: true,
      position: 1,
      waitingAhead: 0,
    });
    const app = createApp();
    const res = await request(app).post("/api/v1/clips").send({ video: "https://youtu.be/another" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, video: "Another Talk", queued: true, position: 1 });
    expect(String(res.body.message)).toContain("queued behind");
  });

  it("answers 409 only when the queue itself is full", async () => {
    mocks.clipsBusy.mockReturnValue({ busy: true, source: "A Long Talk", queued: 8 });
    mocks.startClipsJob.mockRejectedValueOnce(new Error("I've already got 8 videos waiting to be clipped — ask me again once some of them are done."));
    const app = createApp();
    const res = await request(app).post("/api/v1/clips").send({ video: "https://youtu.be/another" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, busy: true, source: "A Long Talk", queued: 8 });
    expect(String(res.body.error)).toContain("8 videos waiting");
  });

  it("rejects an empty source instead of starting nothing", async () => {
    const app = createApp();
    const res = await request(app).post("/api/v1/clips").send({ video: "" });
    expect(res.status).toBe(400);
    expect(mocks.startClipsJob).not.toHaveBeenCalled();
  });

  it("passes on the real reason when the source can't be read", async () => {
    mocks.startClipsJob.mockRejectedValueOnce(new Error("There's no file at C:\\nope.mp4"));
    const app = createApp();
    const res = await request(app).post("/api/v1/clips").send({ video: "C:\\nope.mp4" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toContain("There's no file at");
  });

  it("says what the card is allowed to offer", async () => {
    const app = createApp();
    const res = await request(app).get("/api/v1/clips");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ busy: false, defaultCount: 3, maxCount: 5, queued: 0, waitingFor: [] });
    expect(typeof res.body.available).toBe("boolean");
    expect(res.body.maxQueued).toBeGreaterThan(0);
  });
});
