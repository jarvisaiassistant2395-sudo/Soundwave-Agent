// Recording the agent's own window (lib/selfRecord.ts): the desktop app hands
// the server PNG frames of the Soundwave window while the agent works, and
// those frames become the background of the video. The capture stand-in here
// returns real PNGs (made by ffmpeg), and the frame→video step is real ffmpeg,
// so the test proves the whole chain: pixels in, MP4 out, stretched to the
// narration's length instead of looping mid-sentence.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { config } = await import("../src/config.js");
const { captureAvailable, recordWindow, framesToVideo, recordSelfVideo } = await import("../src/lib/selfRecord.js");
const { probeMedia, resolveFfmpegPath } = await import("../src/lib/ffmpeg.js");

const WORK = path.join(config.uploadsDir, "self-record-test");
const PNG = path.join(WORK, "window.png");
const hostRef = globalThis as { __soundwaveDesktopHost?: unknown };

const setHost = (host: unknown) => (hostRef.__soundwaveDesktopHost = host);
const clearHost = () => delete hostRef.__soundwaveDesktopHost;

beforeAll(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  // A 320×240 frame with real detail (a flat colour would compress under the
  // 1 KB floor the recorder uses to tell a blank window from a real one).
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=320x240:rate=1", "-frames:v", "1", PNG,
    ]);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}, 60_000);

afterAll(() => {
  clearHost();
  fs.rmSync(WORK, { recursive: true, force: true });
});

describe("can this machine film itself?", () => {
  it("says no without the desktop app's capture hook", async () => {
    clearHost();
    expect(captureAvailable()).toBe(false);
    expect(await recordWindow({ maxSeconds: 0.4 })).toBeNull();
  });

  it("says no when the hook exists but no frame ever comes back", async () => {
    setHost({ captureWindow: async () => null, showWindow: () => undefined });
    expect(captureAvailable()).toBe(true);
    expect(await recordWindow({ maxSeconds: 0.5, minSeconds: 0, fps: 4 })).toBeNull();
  });

  it("counts a frame that arrives as a base64 data URL (Electron's toDataURL)", async () => {
    const dataUrl = `data:image/png;base64,${fs.readFileSync(PNG).toString("base64")}`;
    setHost({ captureWindow: async () => dataUrl, showWindow: () => undefined });
    const recording = await recordWindow({ maxSeconds: 0.6, minSeconds: 0.4, fps: 4 });
    expect(recording).not.toBeNull();
    expect(recording!.frames).toBeGreaterThanOrEqual(2);
    expect(recording!.width).toBe(320);
    expect(recording!.height).toBe(240);
    clearHost();
  });
});

describe("real frames, real ffmpeg", () => {
  it("writes the frames out and brings the window up first", async () => {
    const calls: string[] = [];
    setHost({
      showWindow: () => calls.push("show"),
      captureWindow: async () => {
        calls.push("capture");
        return fs.readFileSync(PNG);
      },
    });
    const recording = (await recordWindow({ maxSeconds: 0.7, minSeconds: 0.5, fps: 4, onFrame: () => undefined }))!;
    expect(calls[0]).toBe("show"); // the window is on screen before the first frame
    expect(recording.frames).toBeGreaterThanOrEqual(2);
    const written = fs.readdirSync(recording.dir).filter((f) => /^frame-\d{4}\.png$/.test(f)).sort();
    expect(written.length).toBe(recording.frames);
    expect(written[0]).toBe("frame-0001.png");
    expect(recording.dir.startsWith(path.join(config.uploadsDir, "self-record"))).toBe(true);
    clearHost();
  });

  it("turns the frames into a video as long as the narration", async () => {
    const dir = path.join(WORK, "frames");
    fs.mkdirSync(dir, { recursive: true });
    const frames = 5;
    for (let i = 1; i <= frames; i += 1) fs.copyFileSync(PNG, path.join(dir, `frame-${String(i).padStart(4, "0")}.png`));
    const outPath = path.join(WORK, "background.mp4");

    const out = await framesToVideo({ dir, frames, seconds: 20, outPath });
    // Five frames stretched over twenty seconds: slow, but the picture keeps
    // showing what happened the whole time the voice is talking.
    expect(out.fps).toBeLessThan(1); // stretched, not sped up
    const probed = await probeMedia(outPath);
    expect(probed.hasVideo).toBe(true);
    expect(probed.width).toBe(320);
    expect(probed.height).toBe(240);
    expect(probed.duration).toBeGreaterThan(19);
    expect(probed.duration).toBeLessThan(21);
  }, 60_000);

  it("does the whole thing in one call and reports what it got", async () => {
    setHost({ showWindow: () => undefined, captureWindow: async () => fs.readFileSync(PNG) });
    const outPath = path.join(WORK, "self.mp4");
    const made = (await recordSelfVideo({ maxSeconds: 0.6, minSeconds: 0.4, fps: 4, narrationSeconds: 3, outPath }))!;
    expect(made.frames).toBeGreaterThanOrEqual(2);
    expect(made.width).toBe(320);
    expect(made.height).toBe(240);
    expect(fs.existsSync(made.videoPath)).toBe(true);
    const probed = await probeMedia(made.videoPath);
    expect(probed.duration).toBeGreaterThan(2.5);
    expect(probed.duration).toBeLessThan(3.5);
    clearHost();
  }, 60_000);

  it("comes back empty-handed instead of inventing footage", async () => {
    setHost({ captureWindow: async () => Buffer.alloc(400), showWindow: () => undefined }); // a blank/tiny PNG
    const out = await recordSelfVideo({ maxSeconds: 0.5, minSeconds: 0, fps: 4, narrationSeconds: 3, outPath: path.join(WORK, "never.mp4") });
    expect(out).toBeNull();
    expect(fs.existsSync(path.join(WORK, "never.mp4"))).toBe(false);
    clearHost();
  });
});
