// The clips pipeline's plumbing — the half that used to have no tests at all.
// clips.test.ts covers the pure rules; clips_tool.test.ts mocks this file away
// entirely. What was left untested was exactly where the quiet bugs lived: how
// the video's sound is read, what happens when the speech engine is busy or too
// slow, and what the queue does when a second video arrives (or the app closes
// mid-render). ffmpeg and whisper are stand-ins here — no real video is cut —
// but every branch below is the real one from lib/videoClips.ts.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A whole run listens to several windows and renders each clip, so the default
// five seconds isn't enough even with stand-ins for ffmpeg and whisper.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const RATE = 16_000;
/** WAV header size, so a call's audio length can be read back off its bytes. */
const WAV_HEADER = 44;

const mocks = vi.hoisted(() => ({
  transcribe: vi.fn(),
  resolveWhisper: vi.fn(),
  probeMedia: vi.fn(),
  resolveFfmpegPath: vi.fn(() => "ffmpeg"),
  runFfmpegExport: vi.fn(),
  isReadableMediaFile: vi.fn(() => true),
  getActiveShortJobs: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawn };
});
vi.mock("../src/lib/stt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/stt.js")>();
  // SttError stays the real class: lib/videoClips.ts checks `instanceof`, and a
  // stand-in would make a busy engine look like an ordinary failure.
  return { ...actual, transcribe: mocks.transcribe, resolveWhisper: mocks.resolveWhisper };
});
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ffmpeg.js")>();
  return {
    ...actual,
    probeMedia: mocks.probeMedia,
    resolveFfmpegPath: mocks.resolveFfmpegPath,
    runFfmpegExport: mocks.runFfmpegExport,
  };
});
vi.mock("../src/lib/mediaFile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/mediaFile.js")>();
  return { ...actual, isReadableMediaFile: mocks.isReadableMediaFile };
});
vi.mock("../src/routes/agentShort.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/agentShort.js")>();
  return { ...actual, getActiveShortJobs: mocks.getActiveShortJobs };
});

const { config } = await import("../src/config.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const conversation = await import("../src/lib/conversation.js");
const { audioProfile } = await import("../src/lib/brain/core/clips.js");
const { MAX_WAITING } = await import("../src/lib/brain/core/clipQueue.js");
const { SttError } = await import("../src/lib/stt.js");
const clips = await import("../src/lib/videoClips.js");

/** The one store the pipeline and these assertions share (JsonStore writes are debounced). */
let db: InstanceType<typeof JsonStore>;

// ── A stand-in video ────────────────────────────────────────────────────────

/** A deterministic tone at `level` × full scale, with a little life in it. */
function tone(seconds: number, level: number): Int16Array {
  const n = Math.round(seconds * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const wobble = 1 + 0.35 * Math.sin((2 * Math.PI * 7 * i) / RATE);
    out[i] = Math.round(level * 32767 * wobble * Math.sin((2 * Math.PI * 220 * i) / RATE));
  }
  return out;
}

const asBuffer = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

/** Talking, a pause, talking again, then room tone — two moments to find. */
function talkingVideo(seconds = 40): { pcm: Int16Array; buffer: Buffer } {
  const parts = [
    tone(seconds * 0.3, 0.3),
    tone(seconds * 0.05, 0.002),
    tone(seconds * 0.35, 0.3),
    tone(seconds * 0.3, 0.002),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const pcm = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    pcm.set(p, at);
    at += p.length;
  }
  return { pcm, buffer: asBuffer(pcm) };
}

/** What the stand-in ffmpeg pipes out, in chunks (the shape real pipes arrive in). */
let pcmChunks: Buffer[] = [];
const spawnLog: string[][] = [];

/** Set to make the next sound-extraction fail the way ffmpeg does. */
let extractFailsWith: string | null = null;

/** What lib/videoClips.ts uses of a spawned ffmpeg. */
interface FakeStream extends EventEmitter {
  pause(): void;
  resume(): void;
}
interface FakeChild extends EventEmitter {
  stdout: FakeStream;
  stderr: EventEmitter;
  kill(): void;
}

function fakeStream(): FakeStream {
  const emitter = new EventEmitter() as FakeStream;
  emitter.pause = () => {};
  emitter.resume = () => {};
  return emitter;
}

/** spawn(cmd, args, opts) — the command comes first, the arguments second. */
function fakeFfmpeg(_command: string, args: string[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = fakeStream();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  spawnLog.push(args);
  const isExtract = args.includes("s16le") && args.includes("pipe:1");
  const failure = isExtract ? extractFailsWith : null;
  setImmediate(() => {
    if (failure) {
      child.stderr.emit("data", Buffer.from(failure));
      child.emit("close", 1);
      return;
    }
    if (isExtract) for (const chunk of pcmChunks) child.stdout.emit("data", chunk);
    child.emit("close", 0);
  });
  return child;
}

/** Splits a buffer into chunks, optionally making the first an odd number of bytes. */
function chunkUp(buffer: Buffer, size: number, oddFirst = false): Buffer[] {
  const out: Buffer[] = [];
  let at = 0;
  if (oddFirst && buffer.length > size + 1) {
    out.push(buffer.subarray(0, size + 1));
    at = size + 1;
  }
  for (; at < buffer.length; at += size) out.push(buffer.subarray(at, Math.min(buffer.length, at + size)));
  return out;
}

interface RenderCall {
  outputPath: string;
  subtitles: Array<{ text: string; start: number; end: number }>;
  settings: { resolution: { width: number; height: number } } & Record<string, unknown>;
}
let exportCalls: RenderCall[] = [];

let sourceFile = "";

async function makeSourceVideo(durationSec = 40): Promise<string> {
  const file = path.join(config.uploadsDir, `talk-${Math.random().toString(36).slice(2)}.mp4`);
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(4096, 7));
  mocks.probeMedia.mockResolvedValue({ duration: durationSec, width: 1920, height: 1080, hasVideo: true, hasAudio: true });
  return file;
}

async function settle(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Everything the pipeline said: the words, the detail line, and where a clip landed. */
const chatText = () =>
  conversation
    .getConversation()
    .messages.map((m) => [m.text, m.actionOutput ?? "", m.videoUrl ?? "", m.downloadUrl ?? "", m.jobId ?? ""].join("\n"))
    .join("\n");

const queueIdle = () => !clips.clipsBusy().busy;

/** The renderer is taken by an ordinary short, so clips have to wait. */
const shortIsRendering = () => mocks.getActiveShortJobs.mockReturnValue([{ jobId: "short-1", topic: "coffee", startedAt: Date.now() }]);
const shortIsDone = () => mocks.getActiveShortJobs.mockReturnValue([]);

/** JsonStore writes are debounced; a restarted store needs the last one on disk. */
const flushStore = () => new Promise((r) => setTimeout(r, 250));

beforeEach(async () => {
  vi.clearAllMocks();
  spawnLog.length = 0;
  exportCalls = [];
  extractFailsWith = null;
  const video = talkingVideo(40);
  pcmChunks = chunkUp(video.buffer, 64 * 1024);
  mocks.spawn.mockImplementation(fakeFfmpeg as never);
  mocks.getActiveShortJobs.mockReturnValue([]);
  mocks.resolveWhisper.mockReturnValue({
    setup: { cli: "whisper-cli", model: "/m/ggml-base.en.bin", modelName: "base.en" },
    problem: null,
  });
  mocks.transcribe.mockResolvedValue({
    text: "Here is how nobody talks about coffee.",
    noSpeech: false,
    durationMs: 1000,
    model: "base.en",
    elapsedMs: 10,
  });
  mocks.runFfmpegExport.mockImplementation((async (params: RenderCall & { onProgress?: (p: number) => void }) => {
    fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });
    fs.writeFileSync(params.outputPath, "a rendered clip");
    exportCalls.push(params);
    params.onProgress?.(0.5);
    params.onProgress?.(1);
  }) as never);

  clips._resetClipsForTests();
  clips._setClipsListenTimingForTests({ attempts: 4, busyDelayMs: 0 });
  // The conversation lives on disk under one shared DATA_DIR, so resetting the
  // in-memory copy isn't enough: the next load would read back every message
  // earlier tests (and other files) left there.
  conversation.resetConversationForTests();
  fs.rmSync(path.join(config.dataDir, "agent-conversation.json"), { force: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.mkdirSync(path.join(config.uploadsDir, "jobs"), { recursive: true });
  // uploads/ lives outside DATA_DIR and survives between runs: an earlier,
  // failed run's temp files would otherwise be blamed on this one.
  for (const file of fs.readdirSync(path.join(config.uploadsDir, "jobs"))) {
    if (file.startsWith("clips_pcm_") || file.endsWith("_cut.mp4") || file.endsWith("_cut.m4a")) {
      fs.rmSync(path.join(config.uploadsDir, "jobs", file), { force: true });
    }
  }
  fs.rmSync(path.join(config.dataDir, "store.json"), { force: true });
  db = new JsonStore();
  await db.init();
  setStoreForTests(db);
  sourceFile = await makeSourceVideo(40);
});

// ── The video's sound, streamed rather than held ────────────────────────────

describe("reading the video's sound", () => {
  it("profiles a stream exactly as it would the whole buffer, and reads one window back", async () => {
    const video = talkingVideo(40);
    const pcm = await clips.extractPcm(sourceFile, 40);
    try {
      // Same frames, same floor, same threshold as a single in-memory read:
      // streaming must not change what the highlight search sees.
      expect(pcm.profile).toEqual(audioProfile(video.pcm, RATE));
      expect(pcm.samples).toBe(video.pcm.length);
      // One window, read back from disk — not the whole video held in RAM.
      const slice = pcm.slice(2, 4);
      expect(slice.length).toBe(2 * RATE);
      expect(Array.from(slice.slice(0, 8))).toEqual(Array.from(video.pcm.subarray(2 * RATE, 2 * RATE + 8)));
      // Past the end is clamped, and an empty window is empty rather than a crash.
      expect(pcm.slice(39, 999).length).toBeLessThanOrEqual(RATE);
      expect(pcm.slice(10, 10)).toHaveLength(0);
    } finally {
      pcm.dispose();
    }
  });

  it("keeps the frames aligned when a pipe chunk ends half-way through a sample", async () => {
    const video = talkingVideo(6);
    pcmChunks = chunkUp(video.buffer, 4097, true); // an odd first chunk
    await makeSourceVideo(6);
    const pcm = await clips.extractPcm(sourceFile, 6);
    try {
      expect(pcm.profile).toEqual(audioProfile(video.pcm, RATE));
      expect(pcm.samples).toBe(video.pcm.length);
    } finally {
      pcm.dispose();
    }
  });

  it("deletes its temporary file, and survives being told twice", async () => {
    const jobsDir = path.join(config.uploadsDir, "jobs");
    const pcm = await clips.extractPcm(sourceFile, 40);
    const temps = () => fs.readdirSync(jobsDir).filter((f) => f.startsWith("clips_pcm_"));
    expect(temps().length).toBeGreaterThan(0);
    pcm.dispose();
    pcm.dispose();
    expect(temps()).toHaveLength(0);
    // A disposed store reads as empty rather than from a deleted file.
    expect(pcm.slice(0, 5)).toHaveLength(0);
  });

  it("says why when ffmpeg can't read the sound, and leaves no temp file behind", async () => {
    extractFailsWith = "Invalid data found when processing input";
    try {
      await expect(clips.extractPcm(sourceFile, 40)).rejects.toThrow(/Invalid data found/);
      expect(fs.readdirSync(path.join(config.uploadsDir, "jobs")).filter((f) => f.startsWith("clips_pcm_"))).toHaveLength(0);
    } finally {
      extractFailsWith = null;
    }
  });
});

// ── The shared speech engine: the person's voice goes first ─────────────────

describe("listening to a moment", () => {
  it("asks in the background, with a budget that follows the window's own length", async () => {
    await clips.startClipsJob({ video: sourceFile, count: 1, userId: "listen-1" });
    await settle(() => exportCalls.length > 0, "a clip to render");
    expect(mocks.transcribe).toHaveBeenCalled();
    let sawALongWindow = false;
    for (const call of mocks.transcribe.mock.calls) {
      const opts = call[1] as { background?: boolean; timeoutMs?: number };
      // The person's voice input must never queue behind clip work (lib/stt.ts).
      expect(opts.background).toBe(true);
      expect(typeof opts.timeoutMs).toBe("number");
      const seconds = ((call[0] as Buffer).length - WAV_HEADER) / 2 / RATE;
      // A window too long for the interactive 90 s cap gets a longer one: that
      // cap is what turned a slow PC into clips with no captions and no reason.
      if (seconds > 22.5) {
        sawALongWindow = true;
        expect(opts.timeoutMs).toBeGreaterThan(90_000);
      }
    }
    expect(sawALongWindow, "a 40 s video should produce at least one long window").toBe(true);
  });

  it("retries a refused listen instead of hearing silence", async () => {
    clips._setClipsListenTimingForTests({ attempts: 3, busyDelayMs: 0 });
    let refused = 0;
    mocks.transcribe.mockImplementation((async () => {
      if (refused++ < 2) throw new SttError("STT_BUSY", "The speech engine is busy with something you asked for.");
      return { text: "Worth clipping.", noSpeech: false, durationMs: 1000, model: "base.en", elapsedMs: 5 };
    }) as never);
    await clips.startClipsJob({ video: sourceFile, count: 1, userId: "listen-2" });
    await settle(() => exportCalls.length > 0, "a clip to render");
    // Two refusals, then the words — and the words reached the captions.
    expect(refused).toBeGreaterThanOrEqual(3);
    expect(chatText()).not.toContain("Couldn't listen to");
    expect(exportCalls[0]!.subtitles.length).toBeGreaterThan(0);
  });

  it("says the engine couldn't keep up, never that the moment was silent", async () => {
    mocks.transcribe.mockRejectedValue(new SttError("STT_FAILED", "The speech engine took longer than 160 s."));
    await clips.startClipsJob({ video: sourceFile, count: 1, userId: "listen-3" });
    await settle(() => exportCalls.length > 0, "the clip to render");
    await settle(() => queueIdle(), "the run to finish");
    const text = chatText();
    expect(text).toContain("Couldn't listen to");
    expect(text).toContain("took longer than 160 s");
    // …and never the lie that used to stand in for it.
    expect(text).not.toContain("no speech heard in this moment");
    expect(exportCalls[0]!.subtitles).toHaveLength(0);
    expect(text).toContain("No captions —");
  });

  it("still says silence when silence is what it heard", async () => {
    mocks.transcribe.mockResolvedValue({ text: "", noSpeech: true, durationMs: 1000, model: "base.en", elapsedMs: 2 });
    await clips.startClipsJob({ video: sourceFile, count: 1, userId: "listen-4" });
    await settle(() => exportCalls.length > 0, "the clip to render");
    await settle(() => queueIdle(), "the run to finish");
    expect(chatText()).toContain("no speech heard");
    expect(chatText()).not.toContain("Couldn't listen to");
  });

  it("picks on the sound alone, and says so, when there's no speech engine at all", async () => {
    mocks.resolveWhisper.mockReturnValue({ setup: null, problem: "Voice input isn't set up yet." });
    await clips.startClipsJob({ video: sourceFile, count: 1, userId: "listen-5" });
    await settle(() => exportCalls.length > 0, "a clip to render");
    expect(mocks.transcribe).not.toHaveBeenCalled();
    const text = chatText();
    expect(text).toContain("no speech engine on this PC");
    expect(text).toContain("Voice input isn't set up yet");
    expect(exportCalls[0]!.subtitles).toHaveLength(0);
  });
});

// ── The queue: one renderer, several videos ─────────────────────────────────

describe("the clips queue", () => {
  it("queues a second video instead of refusing it", async () => {
    shortIsRendering();
    const first = await clips.startClipsJob({ video: sourceFile, count: 2, userId: "q-1" });
    expect(first.queued).toBe(true);
    expect(first.position).toBe(1);
    const second = await clips.startClipsJob({ video: sourceFile, count: 1, userId: "q-2" });
    expect(second.queued).toBe(true);
    expect(second.position).toBe(2);
    // A waiting run's jobs say they're waiting, not that they're being cut.
    expect((await db.listJobs("q-1")).map((j) => j.status)).toEqual(["QUEUED", "QUEUED"]);
    expect(clips.clipsQueueView()).toMatchObject({ busy: false, queued: 2 });
    // And the person is told, in the chat, that theirs is waiting.
    expect(chatText()).toContain("queued behind");
    shortIsDone();
  });

  it("drains: the next video starts once the renderer is free", async () => {
    shortIsRendering();
    const waiting = await clips.startClipsJob({ video: sourceFile, count: 1, userId: "q-3" });
    expect(waiting.queued).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(exportCalls).toHaveLength(0); // held off, not started behind a short
    shortIsDone();
    await clips._pumpClipsForTests();
    await settle(() => exportCalls.length > 0, "the queued clip to render");
    await settle(() => clips.clipsQueueView().queued === 0, "the queue to empty");
  });

  it("refuses honestly once the queue is full, and fails the jobs it made", async () => {
    shortIsRendering();
    for (let i = 0; i < MAX_WAITING; i++) {
      await clips.startClipsJob({ video: sourceFile, count: 1, userId: `full-${i}` });
    }
    await expect(clips.startClipsJob({ video: sourceFile, count: 1, userId: "overflow" })).rejects.toThrow(/waiting to be clipped/);
    expect((await db.listJobs("overflow")).map((j) => j.status)).toEqual(["FAILED"]);
    shortIsDone();
  });

  it("starts straight away when the renderer is free", async () => {
    const started = await clips.startClipsJob({ video: sourceFile, count: 1, userId: "free-1" });
    expect(started).toMatchObject({ queued: false, position: 0 });
    expect((await db.listJobs("free-1"))[0]!.status).not.toBe("QUEUED");
    await settle(() => exportCalls.length > 0, "the clip to render");
  });
});

// ── A crash mid-render ──────────────────────────────────────────────────────

describe("the last session's unfinished clips", () => {
  it("fails the jobs it left behind and tells the person, instead of spinning", async () => {
    shortIsRendering();
    const run = await clips.startClipsJob({ video: sourceFile, count: 2, userId: "crash" });
    expect(run.queued).toBe(true);
    // The app closes here: the queue file survives, the renderer does not.
    const queueFile = path.join(config.dataDir, "clips-queue.json");
    const persisted = fs.readFileSync(queueFile, "utf8");
    expect(persisted).toContain(run.jobIds[0]!);
    await flushStore();

    clips._resetClipsForTests();
    fs.writeFileSync(queueFile, persisted, "utf8");
    // A restart reads the store back off disk, as the app would.
    const restarted = new JsonStore();
    await restarted.init();
    setStoreForTests(restarted);

    clips.initClips();
    await settle(() => chatText().includes("closed"), "the person to be told");
    const jobs = await restarted.listJobs("crash");
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.status)).toEqual(["FAILED", "FAILED"]);
    expect(jobs[0]!.errorMessage).toContain("closed before this finished");
    // The queue is empty again, so the next ask starts straight away.
    expect(clips.clipsQueueView()).toMatchObject({ busy: false, queued: 0 });
    expect(chatText()).toContain("still being cut when Soundwave AI closed");
    db = restarted;
    shortIsDone();
  });

  it("leaves a job that already finished alone", async () => {
    const done = await db.createJob({
      projectId: null,
      userId: "kept",
      status: "COMPLETED",
      progress: 100,
      settings: {},
      outputUrl: "/x",
      errorMessage: null,
      startedAt: null,
      completedAt: new Date().toISOString(),
    });
    fs.writeFileSync(
      path.join(config.dataDir, "clips-queue.json"),
      JSON.stringify({
        active: { id: "r1", jobIds: [done.id], video: sourceFile, count: 1, resolution: "1080p", userId: "kept", sourceName: "x", askedAt: 1 },
        waiting: [],
      }),
      "utf8",
    );
    clips._resetClipsForTests();
    clips.initClips();
    await new Promise((r) => setTimeout(r, 80));
    expect((await db.getJobById(done.id))!.status).toBe("COMPLETED");
    expect(chatText()).not.toContain("closed before this finished");
  });

  it("ignores a queue file that isn't JSON", async () => {
    fs.writeFileSync(path.join(config.dataDir, "clips-queue.json"), "{ not json", "utf8");
    clips._resetClipsForTests();
    expect(() => clips.initClips()).not.toThrow();
    expect(clips.clipsQueueView()).toMatchObject({ busy: false, queued: 0 });
  });
});

// ── The whole run, end to end ───────────────────────────────────────────────

describe("cutting the clips", () => {
  it("renders each pick as a vertical short with captions, and posts it to the chat", async () => {
    const started = await clips.startClipsJob({ video: sourceFile, count: 2, userId: "run-1" });
    expect(started.queued).toBe(false);
    expect(started.position).toBe(0);
    await settle(() => exportCalls.length >= 1, "a clip to render");
    await settle(() => queueIdle(), "the run to finish");

    const jobs = await db.listJobs("run-1");
    expect(jobs.some((j) => j.status === "COMPLETED")).toBe(true);
    const finished = jobs.find((j) => j.status === "COMPLETED")!;
    expect(finished.outputUrl).toBe(`/api/v1/export/jobs/${finished.id}/download`);

    const call = exportCalls[0]!;
    expect(call.outputPath).toMatch(/\.mp4$/);
    // 9:16, the honest quality ceiling for footage that started compressed.
    expect(call.settings).toMatchObject({ format: "mp4", quality: "medium", fps: 60, watermark: false });
    expect(call.settings.resolution).toEqual({ width: 1080, height: 1920 });
    // Captions of what was actually said, timed inside the clip.
    expect(call.subtitles.length).toBeGreaterThan(0);
    expect(call.subtitles.every((c) => c.start >= 0 && c.end > c.start)).toBe(true);

    const text = chatText();
    expect(text).toContain("Clip 1 of");
    expect(text).toContain("Captions:");
    expect(text).toContain("/api/v1/export/jobs/");
    // Picture and sound are cut separately, so the original audio survives.
    expect(spawnLog.some((a) => a.includes("-an"))).toBe(true);
    expect(spawnLog.some((a) => a.includes("-vn"))).toBe(true);
  });

  it("fails one video honestly and leaves the queue usable", async () => {
    const missing = path.join(config.uploadsDir, "gone.mp4");
    await expect(clips.startClipsJob({ video: missing, count: 1, userId: "bad" })).rejects.toThrow(/There's no file at/);
    expect(clips.clipsQueueView()).toMatchObject({ busy: false, queued: 0 });
    const ok = await clips.startClipsJob({ video: sourceFile, count: 1, userId: "after-bad" });
    expect(ok.queued).toBe(false);
  });

  it("refuses a video too short to hold a clip, and says so in the chat", async () => {
    sourceFile = await makeSourceVideo(6);
    const started = await clips.startClipsJob({ video: sourceFile, count: 1, userId: "short-video" });
    await settle(() => queueIdle(), "the run to fail");
    const jobs = await db.listJobs("short-video");
    expect(jobs[0]!.status).toBe("FAILED");
    expect(jobs[0]!.errorMessage).toContain("too short");
    expect(started.jobIds).toHaveLength(1);
    expect(chatText()).toContain("too short to cut a clip");
  });

  it("fails the jobs a short video can't fill, rather than leaving them spinning", async () => {
    sourceFile = await makeSourceVideo(26); // room for one clip, not four
    await clips.startClipsJob({ video: sourceFile, count: 4, userId: "overfilled" });
    await settle(() => queueIdle(), "the run to finish");
    const jobs = await db.listJobs("overfilled");
    expect(jobs).toHaveLength(4);
    expect(jobs.every((j) => j.status === "COMPLETED" || j.status === "FAILED")).toBe(true);
    expect(jobs.some((j) => j.status === "FAILED")).toBe(true);
    expect(jobs.filter((j) => j.status === "FAILED")[0]!.errorMessage).toContain("too short for another clip");
  });

  it("cleans up the intermediates it cut", async () => {
    await clips.startClipsJob({ video: sourceFile, count: 1, userId: "tidy" });
    await settle(() => queueIdle(), "the run to finish");
    const jobsDir = path.join(config.uploadsDir, "jobs");
    const left = fs.readdirSync(jobsDir).filter((f) => f.endsWith("_cut.mp4") || f.endsWith("_cut.m4a") || f.startsWith("clips_pcm_"));
    expect(left).toHaveLength(0);
  });
});
