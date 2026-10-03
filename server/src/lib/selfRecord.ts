// ── Recording himself: the agent films its own window doing real work ───────
// The server runs inside the desktop app (desktop/src/main.js sets
// globalThis.__soundwaveDesktopHost, then imports the server), so Electron can
// hand us real PNG frames of the Soundwave window while the agent works on the
// very video being made. Those frames become the background of that video —
// no gameplay footage, just the product proving itself.
//
// Honest limits, said out loud rather than faked:
//   • only inside the desktop app (a hosted server has no window);
//   • the window has to be visible — a minimised or occluded window captures
//     a blank or frozen frame, so we bring it up (without stealing focus
//     where the OS allows it) before the first frame;
//   • no screen, no pixels: if capture never returns a usable frame, the
//     caller is told and falls back to a normal short.
//
// Nothing here needs a display to be *written*; the tests drive it with a
// capture function that returns generated PNGs, and the frame→video step is
// real ffmpeg.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { resolveFfmpegPath } from "./ffmpeg.js";

interface CaptureHost {
  /** Electron's webContents.capturePage() → PNG bytes. */
  captureWindow?(): Promise<Uint8Array | ArrayBuffer | string | null>;
  /** Bring the app window back on screen (no focus steal when the OS allows). */
  showWindow?(): void;
}

function host(): CaptureHost | null {
  const h = (globalThis as { __soundwaveDesktopHost?: Partial<CaptureHost> }).__soundwaveDesktopHost;
  return h && typeof h.captureWindow === "function" ? (h as CaptureHost) : null;
}

/** Can this machine record the app window at all? */
export function captureAvailable(): boolean {
  return host() !== null;
}

function toBuffer(value: Uint8Array | ArrayBuffer | string | null | undefined): Buffer | null {
  if (!value) return null;
  if (typeof value === "string") {
    const base64 = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
    try {
      const buf = Buffer.from(base64, "base64");
      return buf.length > 1000 ? buf : null;
    } catch {
      return null;
    }
  }
  const buf = Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  return buf.length > 1000 ? buf : null;
}

export interface Recording {
  dir: string;
  frames: number;
  /** How long the capture really ran. */
  seconds: number;
  fps: number;
  width: number;
  height: number;
}

export interface RecordOptions {
  /** Longest we keep capturing. */
  maxSeconds: number;
  /** Shortest useful recording (a couple of frames of a still window is enough). */
  minSeconds?: number;
  fps?: number;
  /** Stop as soon as this is true (the render's other work is done). */
  stopWhen?: () => boolean;
  onFrame?: (count: number, seconds: number) => void;
  signal?: AbortSignal;
}

/** PNG size straight out of the IHDR chunk (frames are written as they arrive). */
function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length >= 24 && png.toString("ascii", 12, 16) === "IHDR") {
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

/** Capture the app window a few times a second until `stopWhen` or the cap. */
export async function recordWindow(opts: RecordOptions): Promise<Recording | null> {
  const h = host();
  const capture = h?.captureWindow;
  if (!h || !capture) return null;
  h.showWindow?.();
  const fps = Math.min(12, Math.max(1, Math.round(opts.fps ?? 6)));
  const minSeconds = Math.min(opts.maxSeconds, Math.max(0, opts.minSeconds ?? 4));
  const dir = path.join(config.uploadsDir, "self-record", randomBytes(5).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });

  const started = Date.now();
  const interval = Math.round(1000 / fps);
  let frames = 0;
  let width = 0;
  let height = 0;
  let lastDims = { width: 0, height: 0 };

  while (!opts.signal?.aborted) {
    const waited = (Date.now() - started) / 1000;
    if (waited >= opts.maxSeconds) break;
    if (waited >= minSeconds && opts.stopWhen?.()) break;
    try {
      const png = toBuffer(await capture());
      if (png) {
        lastDims = pngSize(png);
        if (lastDims.width) {
          width = lastDims.width;
          height = lastDims.height;
        }
        frames += 1;
        fs.writeFileSync(path.join(dir, `frame-${String(frames).padStart(4, "0")}.png`), png);
        opts.onFrame?.(frames, (Date.now() - started) / 1000);
      }
    } catch (err) {
      console.warn(`[selfRecord] a frame didn't come through: ${(err as Error).message}`);
    }
    const target = started + (frames + 1) * interval;
    const sleepFor = Math.max(0, target - Date.now());
    if (sleepFor > 0) await new Promise((r) => setTimeout(r, sleepFor));
  }

  const seconds = (Date.now() - started) / 1000;
  if (frames === 0) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* nothing to clean */ }
    return null;
  }
  console.log(`[selfRecord] ${frames} frames in ${seconds.toFixed(1)}s (${width}×${height})`);
  return { dir, frames, seconds, fps, width, height };
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stderr) : reject(new Error(stderr.slice(-800) || `ffmpeg exited ${code}`))));
  });
}

/**
 * Frames → one MP4. `seconds` stretches them to the narration's length, so a
 * 20-second recording of the agent working becomes the background of a
 * 60-second video instead of looping awkwardly mid-sentence.
 */
export async function framesToVideo(opts: { dir: string; frames: number; seconds: number; outPath: string; fps?: number }): Promise<{ outPath: string; fps: number; seconds: number }> {
  const seconds = Math.max(0.5, opts.seconds);
  const natural = opts.frames / seconds;
  // Below one frame a second is normal (a 3-second recording stretched over a
  // 60-second narration), and ffmpeg takes fractional rates happily — that is
  // what makes the picture last exactly as long as the voice instead of
  // jumping back to the start mid-sentence.
  const fps = Math.min(opts.fps ?? 12, Math.max(0.05, Math.round(natural * 1000) / 1000));
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  await run(resolveFfmpegPath(), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    String(fps),
    "-i",
    path.join(opts.dir, "frame-%04d.png"),
    // Even dimensions: the compositor crops to fill anyway, but odd sizes break yuv420p.
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-t",
    seconds.toFixed(3),
    opts.outPath,
  ]);
  return { outPath: opts.outPath, fps, seconds };
}

/** Capture, then turn the frames into the video the render will use as its background. */
export async function recordSelfVideo(opts: RecordOptions & { outPath: string; narrationSeconds: number }): Promise<{ videoPath: string; frames: number; captureSeconds: number; stretchedFps: number; width: number; height: number } | null> {
  const recording = await recordWindow(opts);
  if (!recording) return null;
  const video = await framesToVideo({
    dir: recording.dir,
    frames: recording.frames,
    seconds: opts.narrationSeconds,
    outPath: opts.outPath,
  });
  return {
    videoPath: video.outPath,
    frames: recording.frames,
    captureSeconds: +recording.seconds.toFixed(1),
    stretchedFps: video.fps,
    width: recording.width,
    height: recording.height,
  };
}

/** Tests: stop capture from finding a window. */
export function resetSelfRecordForTests(): void {
  /* capture goes through the host object tests set on globalThis */
}
