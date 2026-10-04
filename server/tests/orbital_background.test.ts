import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// yt-dlp is mocked (no YouTube in CI); everything above it — the YouTube link
// importer, the Orbital picker/history, the short builder — runs for real.
const mocks = vi.hoisted(() => ({
  listChannelVideos: vi.fn(),
  fetchMetadata: vi.fn(),
  downloadVideo: vi.fn(),
  synthesizeEdgeTTS: vi.fn(),
}));

vi.mock("../src/lib/ytdlp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ytdlp.js")>();
  return {
    ...actual,
    listChannelVideos: mocks.listChannelVideos,
    fetchMetadata: mocks.fetchMetadata,
    downloadVideo: mocks.downloadVideo,
  };
});

// Microsoft's voice service needs the network: the Soundwave voice is stubbed
// with a locally generated recording (there is no offline stand-in voice).
vi.mock("../src/lib/edgeTts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/edgeTts.js")>();
  return { ...actual, synthesizeEdgeTTS: mocks.synthesizeEdgeTTS };
});

const { config, resolveFfmpegPath } = await import("../src/config.js");
const { YtDlpError } = await import("../src/lib/ytdlp.js");
const orbital = await import("../src/lib/orbitalBackground.js");
const { buildShortVideo } = await import("../src/routes/agentShort.js");
const { parseShortRequest } = await import("../src/routes/agent.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests, getStore } = await import("../src/lib/store.js");

// The renderer needs ffmpeg.
const ffmpegPath = resolveFfmpegPath();
const hasFfmpeg = (() => {
  try {
    execFileSync(ffmpegPath, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const CHANNEL_TAB = "https://www.youtube.com/@OrbitalNCG/videos";
const VIDEO_A = { id: "AAAAAAAAAAA", title: "Minecraft Parkour Gameplay No Copyright (1 Hour)", duration: 3600, url: "https://www.youtube.com/watch?v=AAAAAAAAAAA" };
const VIDEO_B = { id: "BBBBBBBBBBB", title: "Minecraft Parkour Gameplay No Copyright (30 mins)", duration: 1800, url: "https://www.youtube.com/watch?v=BBBBBBBBBBB" };
const historyFile = () => path.join(config.dataDir, "agent", "orbital_background_history.json");

/** Smallest file isReadableMediaFile accepts as a complete MP4 (ftyp + moov). */
function fakeMp4(): Buffer {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write("ftypisom", 4, "latin1");
  const moov = Buffer.alloc(2048);
  moov.writeUInt32BE(2048, 0);
  moov.write("moov", 4, "latin1");
  return Buffer.concat([ftyp, moov]);
}

type DownloadArgs = [string, string, number, ((p: number) => void) | undefined, number | undefined, string | undefined, { section?: { start: number; end: number } | null; formatSort?: string } | undefined];

function writeFakeDownload(...args: DownloadArgs) {
  const [, uuid, , onProgress] = args;
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const filePath = path.join(config.uploadsDir, `${uuid}.mp4`);
  fs.writeFileSync(filePath, fakeMp4());
  onProgress?.(100);
  return { filePath, fileKey: `${uuid}.mp4`, ext: "mp4", size: fs.statSync(filePath).size };
}

function metadataFor(url: string) {
  const v = [VIDEO_A, VIDEO_B].find((x) => url.includes(x.id)) ?? VIDEO_A;
  return {
    title: v.title,
    duration: v.duration,
    webpageUrl: v.url,
    channel: "Orbital - No Copyright Gameplay",
    channelUrl: "https://www.youtube.com/channel/UCorbital",
  };
}

/** Stand-in for the Soundwave voice's MP3 (a 2 s tone when ffmpeg is around). */
let narrationMp3 = Buffer.alloc(1200);

function fakeNarration({ text }: { text: string }) {
  const words = text.split(/\s+/).filter(Boolean);
  const step = 2 / Math.max(1, words.length);
  return {
    audioBase64: narrationMp3.toString("base64"),
    mimeType: "audio/mpeg" as const,
    duration: 2,
    wordTimings: words.map((word, i) => ({ word, start: i * step, end: (i + 1) * step })),
  };
}

beforeAll(async () => {
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  if (hasFfmpeg) {
    narrationMp3 = execFileSync(ffmpegPath, ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3", "pipe:1"]);
  }
});

beforeEach(() => {
  orbital._resetOrbitalMemoryForTests();
  fs.rmSync(historyFile(), { force: true });
  mocks.listChannelVideos.mockReset().mockResolvedValue({ channelId: "UCorbital", channelName: "Orbital - No Copyright Gameplay", videos: [VIDEO_A, VIDEO_B] });
  mocks.fetchMetadata.mockReset().mockImplementation(async (url: string) => metadataFor(url));
  mocks.downloadVideo.mockReset().mockImplementation(async (...args: DownloadArgs) => writeFakeDownload(...args));
  mocks.synthesizeEdgeTTS.mockReset().mockImplementation(async (input: { text: string }) => fakeNarration(input));
});

describe("Orbital NCG background picker", () => {
  it("lists the Orbital channel and imports an unused video through the YouTube link importer", async () => {
    const imp = await orbital.importUnusedOrbitalVideo({ clipSeconds: 40, rand: () => 0 });

    expect(mocks.listChannelVideos).toHaveBeenCalledWith(CHANNEL_TAB);
    expect(imp.video.id).toBe(VIDEO_A.id);
    // The importer reads the pasted link's details, then imports just a window of it.
    expect(mocks.fetchMetadata).toHaveBeenCalledWith(VIDEO_A.url, undefined);
    const [url, , , , , format, options] = mocks.downloadVideo.mock.calls[0] as DownloadArgs;
    expect(url).toBe(VIDEO_A.url);
    expect(format).toBe(orbital.ORBITAL_IMPORT_FORMAT);
    expect(options?.formatSort).toBe(orbital.ORBITAL_IMPORT_FORMAT_SORT);
    expect(options?.section).toEqual({ start: 60, end: 100 }); // skips the intro of a 1h video
    expect(imp.imported.section).toEqual({ start: 60, end: 100 });
    expect(fs.existsSync(imp.imported.filePath)).toBe(true);

    // Picked but not rendered yet: reserved, not used.
    expect(orbital.getOrbitalStatus()).toMatchObject({ usedCount: 0, inProgress: 1, available: 1 });

    orbital.markOrbitalVideoUsed(imp.video, { jobId: "job-1", topic: "psychology", section: imp.imported.section });
    orbital.discardOrbitalImport(imp);
    expect(fs.existsSync(imp.imported.filePath)).toBe(false);

    const status = orbital.getOrbitalStatus();
    expect(status).toMatchObject({ usedCount: 1, inProgress: 0, available: 1, catalogSize: 2 });
    expect(status.lastUsed).toMatchObject({ id: VIDEO_A.id, url: VIDEO_A.url, jobId: "job-1", topic: "psychology" });
    // Persisted: survives a restart.
    const saved = JSON.parse(fs.readFileSync(historyFile(), "utf8"));
    expect(saved.used.map((u: { id: string }) => u.id)).toEqual([VIDEO_A.id]);
  });

  it("never picks a video it already used, and says so when every video is used", async () => {
    const first = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
    orbital.markOrbitalVideoUsed(first.video);
    orbital.discardOrbitalImport(first);

    const second = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
    expect(second.video.id).not.toBe(first.video.id);
    orbital.markOrbitalVideoUsed(second.video);
    orbital.discardOrbitalImport(second);

    mocks.downloadVideo.mockClear();
    await expect(orbital.importUnusedOrbitalVideo({ clipSeconds: 30 })).rejects.toMatchObject({ code: "ORBITAL_EXHAUSTED" });
    expect(mocks.downloadVideo).not.toHaveBeenCalled();

    // Reset makes the whole channel available again.
    expect(orbital.resetOrbitalHistory()).toMatchObject({ usedCount: 0, available: 2 });
  });

  it("checks the channel for new uploads before saying every video is used", async () => {
    for (let i = 0; i < 2; i++) {
      const imp = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
      orbital.markOrbitalVideoUsed(imp.video);
      orbital.discardOrbitalImport(imp);
    }
    const VIDEO_C = { id: "CCCCCCCCCCC", title: "Minecraft Parkour Gameplay No Copyright (new upload)", duration: 1200, url: "https://www.youtube.com/watch?v=CCCCCCCCCCC" };
    mocks.listChannelVideos.mockResolvedValue({ channelId: "UCorbital", channelName: "Orbital - No Copyright Gameplay", videos: [VIDEO_C, VIDEO_A, VIDEO_B] });
    const listingsBefore = mocks.listChannelVideos.mock.calls.length;

    const imp = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
    expect(imp.video.id).toBe(VIDEO_C.id);
    expect(mocks.listChannelVideos.mock.calls.length).toBe(listingsBefore + 1);
    orbital.releaseOrbitalVideo(imp.video.id);
    orbital.discardOrbitalImport(imp);
  });

  it("does not hand a reserved video to a second job, and releases it on failure", async () => {
    const a = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
    const b = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
    expect(b.video.id).not.toBe(a.video.id);
    await expect(orbital.importUnusedOrbitalVideo({ clipSeconds: 30 })).rejects.toMatchObject({ code: "ORBITAL_BUSY" });

    orbital.releaseOrbitalVideo(a.video.id); // e.g. the render failed
    orbital.discardOrbitalImport(a);
    const again = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
    expect(again.video.id).toBe(a.video.id);
    expect(orbital.getOrbitalStatus().usedCount).toBe(0);
    orbital.releaseOrbitalVideo(again.video.id);
    orbital.releaseOrbitalVideo(b.video.id);
    orbital.discardOrbitalImport(again);
    orbital.discardOrbitalImport(b);
  });

  it("skips a video the importer can't fetch and moves on to another unused one", async () => {
    mocks.downloadVideo.mockImplementation(async (...args: DownloadArgs) => {
      if (args[0].includes(VIDEO_A.id)) throw new YtDlpError("This video is unavailable, private, or has been removed.", "YT_UNAVAILABLE");
      return writeFakeDownload(...args);
    });
    const imp = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
    expect(imp.video.id).toBe(VIDEO_B.id);
    expect(imp.attempts).toBe(2);
    const status = orbital.getOrbitalStatus();
    expect(status.skipped.map((s) => s.id)).toEqual([VIDEO_A.id]);
    expect(status.usedCount).toBe(0);
    orbital.releaseOrbitalVideo(imp.video.id);
    orbital.discardOrbitalImport(imp);
  });

  it("stops (without marking anything) when YouTube itself is unreachable", async () => {
    mocks.fetchMetadata.mockRejectedValue(new YtDlpError("The connection to YouTube failed.", "YT_NETWORK"));
    await expect(orbital.importUnusedOrbitalVideo({ clipSeconds: 30 })).rejects.toMatchObject({ code: "ORBITAL_IMPORT_FAILED" });
    expect(mocks.fetchMetadata).toHaveBeenCalledTimes(1);
    expect(orbital.getOrbitalStatus()).toMatchObject({ usedCount: 0, skippedCount: 0, inProgress: 0 });
  });

  it("falls back to the last saved channel list when listing fails", async () => {
    const first = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
    orbital.markOrbitalVideoUsed(first.video);
    orbital.discardOrbitalImport(first);

    orbital._resetOrbitalMemoryForTests(); // simulate a server restart
    mocks.listChannelVideos.mockRejectedValue(new YtDlpError("The connection to YouTube failed.", "YT_NETWORK"));
    const next = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
    expect(next.video.id).toBe(VIDEO_B.id);
    orbital.releaseOrbitalVideo(next.video.id);
    orbital.discardOrbitalImport(next);
  });

  it("fails clearly when the channel can't be listed and nothing was saved", async () => {
    mocks.listChannelVideos.mockRejectedValue(new YtDlpError("The connection to YouTube failed.", "YT_NETWORK"));
    await expect(orbital.importUnusedOrbitalVideo({ clipSeconds: 30 })).rejects.toMatchObject({ code: "ORBITAL_LIST_FAILED" });
  });

  it("chooses a gameplay window inside the video", () => {
    const long = orbital.chooseOrbitalSection(3600, 40, () => 0.999);
    expect(long).not.toBeNull();
    expect(long!.end - long!.start).toBe(40);
    expect(long!.start).toBeGreaterThanOrEqual(60);
    expect(long!.end).toBeLessThanOrEqual(3600 - 30);
    expect(orbital.chooseOrbitalSection(45, 40)).toBeNull(); // short video: import it whole
    expect(orbital.chooseOrbitalSection(0, 40)).toEqual({ start: 0, end: 40 }); // unknown length: never the whole thing
  });
});

describe("YouTube link importer route (shared with the agent)", () => {
  it("imports a pasted YouTube link", async () => {
    const res = await request(createApp()).post("/api/v1/upload/youtube").send({ url: VIDEO_A.url });
    expect(res.status).toBe(201);
    expect(res.body.fileKey).toMatch(/^[0-9a-f-]{36}\.mp4$/);
    expect(res.body.duration).toBe(3600);
    const [, , maxBytes, , , format, options] = mocks.downloadVideo.mock.calls[0] as DownloadArgs;
    expect(maxBytes).toBe(2048 * 1024 * 1024);
    expect(format).toBeUndefined(); // full import, default format
    expect(options?.section ?? null).toBeNull();
    fs.rmSync(path.join(config.uploadsDir, res.body.fileKey), { force: true });
  });

  it("rejects links that aren't YouTube videos", async () => {
    const res = await request(createApp()).post("/api/v1/upload/youtube").send({ url: "https://example.com/video.mp4" });
    expect(res.status).toBe(400);
    expect(mocks.fetchMetadata).not.toHaveBeenCalled();
  });
});

describe("Agent Orbital endpoints", () => {
  it("reports and resets the Orbital history", async () => {
    const app = createApp();
    const imp = await orbital.importUnusedOrbitalVideo({ clipSeconds: 30, rand: () => 0 });
    orbital.markOrbitalVideoUsed(imp.video, { jobId: "job-x" });
    orbital.discardOrbitalImport(imp);

    const status = await request(app).get("/api/v1/agent/orbital");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ channelUrl: "https://www.youtube.com/@OrbitalNCG", usedCount: 1, available: 1 });
    expect(status.body.used[0]).toMatchObject({ id: VIDEO_A.id, url: VIDEO_A.url });

    const reset = await request(app).post("/api/v1/agent/orbital/reset");
    expect(reset.status).toBe(200);
    expect(reset.body.status).toMatchObject({ usedCount: 0, available: 2 });

    const agentStatus = await request(app).get("/api/v1/agent/status");
    expect(agentStatus.body.backgroundSource).toMatchObject({ type: "orbital_ncg", channelUrl: "https://www.youtube.com/@OrbitalNCG" });
    expect(agentStatus.body).not.toHaveProperty("cachedBackgroundClips");
  });

  it("no longer serves the old background pool endpoints", async () => {
    const app = createApp();
    for (const p of ["/api/v1/agent/background-pool", "/api/v1/agent/backgrounds", "/api/v1/agent/background-pool/inspect"]) {
      const res = await request(app).get(p);
      expect(res.status).toBe(404);
    }
    const replenish = await request(app).post("/api/v1/agent/background-pool/replenish").send({ url: VIDEO_A.url });
    expect(replenish.status).toBe(404);
  });
});

describe("Chat → YT short", () => {
  it("extracts the topic from a chat request", () => {
    expect(parseShortRequest("generate a yt short about psychology")).toEqual({ topic: "psychology" });
    expect(parseShortRequest("Make me a YouTube short on the history of Rome.")).toEqual({ topic: "the history of Rome" });
    expect(parseShortRequest("can you make a short video about sleep?")).toEqual({ topic: "sleep" });
    expect(parseShortRequest("create a video")).toEqual({ topic: "motivation" });
    expect(parseShortRequest("make a short about morning routines and focus")).toEqual({ topic: "morning routines and focus" });
    expect(parseShortRequest("what video did you make?")).toBeNull();
    expect(parseShortRequest("create a desktop shortcut")).toBeNull();
    expect(parseShortRequest("open the clipboard manager")).toBeNull();
  });

  it("starts an async short from chat and fails the job clearly if the Orbital import can't run", async () => {
    mocks.listChannelVideos.mockRejectedValue(new YtDlpError("The connection to YouTube failed.", "YT_NETWORK"));
    const res = await request(createApp()).post("/api/v1/agent/chat").send({ message: "generate a yt short about psychology" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, action: "soundwave_shorts", status: "PROCESSING", topic: "psychology" });
    expect(res.body.reply).toMatch(/Orbital NCG/);
    expect(res.body.reply).toMatch(/YouTube link importer/);
    expect(res.body.videoUrl).toBeUndefined();

    const store = await getStore();
    let job = await store.getJob(res.body.jobId, "local-user");
    for (let i = 0; i < 150 && job?.status === "PROCESSING"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      job = await store.getJob(res.body.jobId, "local-user");
    }
    expect(job?.status).toBe("FAILED");
    expect(job?.errorMessage).toMatch(/Orbital NCG/);
    expect(orbital.getOrbitalStatus()).toMatchObject({ usedCount: 0, inProgress: 0 });
  }, 60_000);
});

describe("Short narration", () => {
  it("fails the short clearly — with no robotic stand-in voice — when the Soundwave voice can't be reached", async () => {
    mocks.synthesizeEdgeTTS.mockRejectedValue(
      new Error("Couldn't reach the Soundwave voice service (Microsoft neural voices): Microsoft's voice service refused the connection (HTTP 403)."),
    );
    const steps: string[] = [];
    await expect(
      buildShortVideo({ topic: "facts", script: "Honey never spoils.", voice: "en-US-GuyNeural", autoPublishYouTube: false, onProgress: (_p, step) => step && steps.push(step) }),
    ).rejects.toThrow(/Soundwave voice "Guy".*HTTP 403.*generate the short again/);

    // The neural voice was asked for (with retries inside synthesizeEdgeTTS), nothing else.
    expect(mocks.synthesizeEdgeTTS).toHaveBeenCalledTimes(1);
    expect(mocks.synthesizeEdgeTTS).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "en-US-GuyNeural", text: "Honey never spoils." }),
      expect.objectContaining({ attempts: 3 }),
    );
    // Failed before the background step: no Orbital video was touched.
    expect(mocks.listChannelVideos).not.toHaveBeenCalled();
    expect(orbital.getOrbitalStatus()).toMatchObject({ usedCount: 0, inProgress: 0 });
    expect(steps.some((s) => /background/i.test(s))).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)("Short builder with an Orbital background", () => {
  it("renders over the imported Orbital clip, then marks the video used and removes the import", async () => {
    let importedPath = "";
    mocks.downloadVideo.mockImplementation(async (...args: DownloadArgs) => {
      const [, uuid, , onProgress] = args;
      fs.mkdirSync(config.uploadsDir, { recursive: true });
      importedPath = path.join(config.uploadsDir, `${uuid}.mp4`);
      execFileSync(ffmpegPath, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", importedPath]);
      onProgress?.(100);
      return { filePath: importedPath, fileKey: `${uuid}.mp4`, ext: "mp4", size: fs.statSync(importedPath).size };
    });

    const steps: string[] = [];
    const result = await buildShortVideo({
      topic: "psychology",
      script: "Your brain loves patterns.",
      resolution: "720p",
      autoPublishYouTube: false,
      onProgress: (_pct, step) => step && steps.push(step),
    });

    // Narrated by a Soundwave voice (the default narrator when none is picked).
    expect(mocks.synthesizeEdgeTTS).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "en-US-ChristopherNeural", text: "Your brain loves patterns." }),
      expect.anything(),
    );
    expect(result.background).toMatchObject({ source: "orbital_ncg", importer: "youtube_link_importer", channelUrl: "https://www.youtube.com/@OrbitalNCG" });
    expect([VIDEO_A.url, VIDEO_B.url]).toContain(result.background.url);
    expect(steps.some((s) => s.includes(`Pasting ${result.background.url} into the YouTube link importer`))).toBe(true);
    expect(fs.existsSync(path.join(config.uploadsDir, `soundwave_short_${result.jobId}.mp4`))).toBe(true);
    expect(fs.existsSync(importedPath)).toBe(false);

    const status = orbital.getOrbitalStatus();
    expect(status.lastUsed).toMatchObject({ id: result.background.videoId, jobId: result.jobId, topic: "psychology" });
    expect(status.inProgress).toBe(0);

    const job = await (await getStore()).getJob(result.jobId, "agent-local");
    expect(job?.status).toBe("COMPLETED");
    expect((job?.settings as unknown as { background?: { url: string } }).background?.url).toBe(result.background.url);
    // The shorts library (Projects / Overview) reads these from the job.
    expect(job?.settings).toMatchObject({ topic: "psychology", voice: "en-US-ChristopherNeural", duration: 2, youtubeUrl: null });

    for (const f of [`soundwave_short_${result.jobId}.mp4`, path.join("jobs", `${result.jobId}.mp4`)]) {
      fs.rmSync(path.join(config.uploadsDir, f), { force: true });
    }
  }, 120_000);

  it("hands the video back when the render fails", async () => {
    mocks.downloadVideo.mockImplementation(async (...args: DownloadArgs) => writeFakeDownload(...args)); // not decodable by ffmpeg
    await expect(buildShortVideo({ topic: "facts", script: "Octopuses have three hearts.", resolution: "720p", autoPublishYouTube: false })).rejects.toThrow();
    expect(orbital.getOrbitalStatus()).toMatchObject({ usedCount: 0, inProgress: 0, available: 2 });
  }, 120_000);
});
