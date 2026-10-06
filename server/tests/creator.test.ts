import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createApp } from "../src/app.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";
import { config, resolveFfmpegPath } from "../src/config.js";

// The test video is generated with ffmpeg; without it (e.g. CI runs the tests
// before ffmpeg is fetched) every endpoint would just 404 on the missing file.
const hasFfmpeg = spawnSync(resolveFfmpegPath(), ["-version"], { stdio: "ignore" }).status === 0;

let app: ReturnType<typeof createApp>;
const testKey = "11111111-2222-3333-4444-555555555555.mp4";
let testVideoPath = "";

beforeAll(async () => {
  if (!hasFfmpeg) return;
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();

  fs.mkdirSync(config.uploadsDir, { recursive: true });
  testVideoPath = path.join(config.uploadsDir, testKey);

  // Generate 4-second synthetic test video: 1.5s audio, 1.5s silence, 1.0s audio
  const ffmpeg = resolveFfmpegPath();
  spawnSync(ffmpeg, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x180:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.5",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:duration=1.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=1.0",
    "-filter_complex",
    "[1:a][2:a][3:a]concat=n=3:v=0:a=1[outa]",
    "-map",
    "0:v",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    testVideoPath,
  ]);
});

afterAll(() => {
  try {
    if (fs.existsSync(testVideoPath)) fs.unlinkSync(testVideoPath);
  } catch {}
});

describe.skipIf(!hasFfmpeg)("Creator Studio API", () => {
  let detectedSpeechIntervals: Array<{ start: number; end: number; duration: number }> = [];

  it("detects dead-air pauses and returns silence analysis", async () => {
    const res = await request(app).post("/api/v1/creator/analyze-silence").send({
      fileKey: testKey,
      noiseThresholdDb: -30,
      minSilenceDuration: 0.4,
      paddingSec: 0.1,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.analysis).toBeDefined();
    expect(res.body.analysis.totalDuration).toBeGreaterThanOrEqual(3.9);
    expect(res.body.analysis.savedDuration).toBeGreaterThanOrEqual(1.0);
    expect(res.body.analysis.cutsCount).toBeGreaterThanOrEqual(1);

    detectedSpeechIntervals = res.body.analysis.speechIntervals;
  });

  it("executes auto-edit jump cutting and screen studio framing synchronously", async () => {
    const res = await request(app)
      .post("/api/v1/creator/auto-edit")
      .send({
        fileKey: testKey,
        speechIntervals: detectedSpeechIntervals,
        framing: {
          aspect: "16:9",
          zoomFactor: 1.15,
          backdrop: "gradient_cyber",
          paddingPercent: 4,
        },
        async: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.jobId).toBeDefined();
    // The reason, when there is one. This assertion used to say only
    // "expected 'FAILED' to be 'COMPLETED'", which is what a red build reports
    // for *any* ffmpeg problem: a missing filter, an old binary, a bad path.
    // The route now returns the stored reason (which names the ffmpeg it used),
    // so the failure explains itself.
    expect(res.body.status, `the auto-edit job failed: ${res.body.error ?? "no reason recorded"}`).toBe("COMPLETED");
    expect(res.body.downloadUrl).toBeDefined();

    // Verify download
    const dlRes = await request(app).get(res.body.downloadUrl);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers["content-type"]).toBe("video/mp4");
    expect(dlRes.body.length).toBeGreaterThan(1000);
  }, 25_000);

  it("handles async job queueing and status query", async () => {
    const res = await request(app)
      .post("/api/v1/creator/auto-edit")
      .send({
        fileKey: testKey,
        framing: { aspect: "9:16", backdrop: "midnight" },
        async: true,
      });

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeDefined();
    expect(res.body.status).toBe("PROCESSING");

    const statusRes = await request(app).get(`/api/v1/creator/jobs/${res.body.jobId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.id).toBe(res.body.jobId);
  });
});
