// ── The render: what the storyboard turns into on the timeline ─────────────
// Two halves, on purpose.
//
// The first asserts the *argv* — the filter graph built for a plan, with no
// process and no filesystem involved. That is where the timing rules live
// (a beat's window, a fade under the hook, a sound at its beat, the music
// ducked under the voice), and it runs everywhere, including a machine with no
// ffmpeg.
//
// The second half renders a real short: a real background, a real voice, a real
// photo and real effects, then reads the finished file back with probeMedia.
// It is small (a 4-second 270×480 clip) but it is the whole pipeline — filters,
// ASS cards, mixing, encoders — and it exists because a filtergraph that looks
// right as a string can still be rejected by ffmpeg. Where the machine has no
// ffmpeg the render half skips and says so, as the caption-font suite does.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildAss, buildFfmpegArgs, ms, probeMedia, runFfmpegExport, type ExportParams, type MediaInput } from "../src/lib/ffmpeg.js";
import { ensurePulse, ensureSfx } from "../src/lib/sfx.js";

const repoRoot = path.resolve(__dirname, "..", "..");
function findFfmpeg(): string | null {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(repoRoot, "vendor", "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    "ffmpeg",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["-version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}
const ffmpeg = findFfmpeg();

const style = { fontWeight: 800, fontSize: 56, strokeEnabled: true, strokeWidth: 4, vAlign: "middle" as const, hAlign: "center" as const };
const cues = [
  { start: 0.2, end: 1.1, text: "your brain is" },
  { start: 1.1, end: 2.0, text: "lying to you" },
];

function paramsWith(media?: MediaInput): ExportParams {
  return {
    videoPath: "bg.mp4",
    audioPath: "voice.wav",
    subtitles: cues,
    subtitleStyle: style,
    settings: {
      resolution: { width: 1080, height: 1920 },
      format: "mp4",
      quality: "high",
      fps: 60,
      watermark: false,
      audioVolume: 1,
      fadeOut: 0.3,
      duration: 4,
    },
    outputPath: "out.mp4",
    ...(media ? { media } : {}),
  };
}

const ctx = { assPath: "/tmp/job.ass", fontDir: "/repo/assets/fonts" };
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? null : (args[i + 1] ?? null);
};

describe("the plain render (no storyboard)", () => {
  it("is exactly the render Soundwave made before this existed", () => {
    const args = buildFfmpegArgs(paramsWith(), ctx);
    expect(args).not.toContain("-filter_complex");
    expect(flag(args, "-vf")).toBe(
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles='/tmp/job.ass':fontsdir='/repo/assets/fonts'",
    );
    expect(flag(args, "-map")).toBe("0:v:0");
    expect(args.join(" ")).toContain("-stream_loop -1 -i bg.mp4 -i voice.wav");
    expect(args).toContain("-af");
    expect(args.at(-1)).toBe("out.mp4");
  });
});

describe("the storyboard render", () => {
  const media: MediaInput = {
    images: [{ path: "photo.png", start: 1.5, end: 3.9, width: 720, x: 180, y: 173, popIn: 0.22 }],
    sounds: [
      { path: "impact.wav", at: 0, gain: 0.8 },
      { path: "whoosh.wav", at: 1.5, gain: 0.55 },
    ],
    music: { path: "pulse.wav", gain: 0.07, duck: true },
    cards: [
      { kind: "hook", start: 0, end: 1.9, text: "YOUR BRAIN LIES ABOUT TIME" },
      { kind: "photo", start: 1.5, end: 3.7, text: "slow motion in the skull" },
      { kind: "cta", start: 2.4, end: 4, text: "Follow for more" },
    ],
    motion: { kind: "pulse", pulses: [1.5, 2.4] },
    flashes: [0.04, 1.5],
  };
  const args = buildFfmpegArgs(paramsWith(media), ctx);
  const graph = flag(args, "-filter_complex")!;

  it("takes the gameplay, the voice, then the pictures, effects and bed in that order", () => {
    const inputs = args.filter((a, i) => args[i - 1] === "-i" || (i > 0 && args[i - 1] === "-framerate"));
    expect(args.join(" ")).toContain("-stream_loop -1 -i bg.mp4 -i voice.wav");
    expect(args.join(" ")).toContain("-framerate 30 -loop 1 -t 2.550 -i photo.png");
    expect(args.join(" ")).toContain("-i impact.wav -i whoosh.wav");
    expect(args.join(" ")).toContain("-stream_loop -1 -i pulse.wav");
    expect(inputs.length).toBeGreaterThan(0);
  });

  it("lays the photo on the short's own timeline, popping in and fading out", () => {
    expect(graph).toContain("[2:v]setpts=PTS+1.500/TB");
    expect(graph).toContain("0.86+0.14*max(t-1.50,0)/0.22");
    expect(graph).toContain("fade=t=in:st=1.50:d=0.22:alpha=1");
    expect(graph).toContain("fade=t=out:st=3.70:d=0.20:alpha=1");
    expect(graph).toContain("overlay=x=180:y=173:enable='between(t,1.50,3.90)'");
    expect(graph).toContain("drawbox=x=0:y=0:w=iw:h=ih:color=white@0.85:t=6");
  });

  it("moves the camera, and flashes the hard cuts", () => {
    // The pulse: the frame is 6% wider than the screen and punches in 3.5% on
    // each beat, so the gameplay is never a still frame.
    expect(graph).toContain("scale=w='floor(1144*(1+0.035*min(between(t,1.50,1.62)+between(t,2.40,2.52),1))/2)*2'");
    expect(graph).toContain("crop=1080:1920:x='(iw-ow)/2':y='(ih-oh)/2'");
    expect(graph).toContain("drawbox=x=0:y=0:w=iw:h=ih:color=white@0.5:t=fill:enable='between(t,0.04,0.11)+between(t,1.50,1.57)'");
  });

  it("puts the cards and captions on top of everything", () => {
    // Cards and captions are drawn after the pictures and the flash, and the
    // result of all of it is what gets encoded.
    expect(graph.indexOf("subtitles=")).toBeGreaterThan(graph.indexOf("overlay="));
    expect(graph).toContain("subtitles='/tmp/job.ass':fontsdir='/repo/assets/fonts'[vout]");
    expect(flag(args, "-map")).toBe("[vout]");
  });

  it("mixes the voice with the effects and a bed that gets out of its way", () => {
    expect(graph).toContain(
      "[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=1.000,asplit=2[voice][voicekey]",
    );
    expect(graph).toContain("[3:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.80,adelay=0:all=1[sfx0]");
    expect(graph).toContain("[4:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.55,adelay=1500:all=1[sfx1]");
    expect(graph).toContain("[5:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.070[musicraw]");
    expect(graph).toContain("[musicraw][voicekey]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300[music]");
    expect(graph).toContain("[voice][sfx0][sfx1][music]amix=inputs=4:normalize=0:dropout_transition=0,afade=t=out:st=3.70:d=0.30[aout]");
    expect(args.join(" ")).toContain("-map [vout] -map [aout]");
  });

  it("leaves the bed alone when it is the only sound, and skips the duck when asked", () => {
    const noDuck = buildFfmpegArgs(paramsWith({ music: { path: "pulse.wav", gain: 0.05, duck: false }, motion: { kind: "drift" } }), ctx);
    const g = flag(noDuck, "-filter_complex")!;
    expect(g).toContain("[music]amix=inputs=2:normalize=0");
    expect(g).not.toContain("sidechaincompress");
    expect(g).toContain("crop=1080:1920:x='(iw-ow)/2*(1+sin(2*PI*t/13))'");
  });

  it("reads camera moves as one of four, and never guesses a fifth", () => {
    for (const kind of ["none", "push", "drift", "pulse"] as const) {
      const a = buildFfmpegArgs(paramsWith({ motion: { kind }, cards: [{ kind: "hook", start: 0, end: 1, text: "X" }] }), ctx);
      expect(a).toContain("-filter_complex");
    }
  });

  it("sends the voice straight out when there is nothing to mix it with", () => {
    const cardsOnly = buildFfmpegArgs(
      paramsWith({ cards: [{ kind: "hook", start: 0, end: 1.9, text: "X" }], motion: { kind: "none" } }),
      ctx,
    );
    const g = flag(cardsOnly, "-filter_complex")!;
    expect(g).toContain(
      "[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=1.000,afade=t=out:st=3.70:d=0.30[aout]",
    );
    expect(g).not.toContain("amix");
  });

  it("mixes an effect time in whole milliseconds, never a fraction of one", () => {
    expect(ms(1.5)).toBe(1500);
    expect(ms(0.0004)).toBe(0);
    expect(ms(-3)).toBe(0);
  });
});

describe("the cards in the captions file", () => {
  const ass = buildAss(cues, style, 1080, 1920, false, [
    { kind: "hook", start: 0, end: 1.9, text: "THE OCEAN\nIS LYING TO YOU" },
    { kind: "photo", start: 1.5, end: 3.7, text: "pressure at depth" },
    { kind: "stat", start: 2, end: 3.4, text: "11 KM DOWN", accent: "#22D3EE" },
    { kind: "cta", start: 2.4, end: 4, text: "Follow for more" },
  ]);

  it("gives every kind its own place on the frame", () => {
    expect(ass).toContain("Style: Hook,");
    expect(ass).toContain("Style: PhotoLabel,");
    expect(ass).toContain("Style: Stat,");
    expect(ass).toContain("Style: Cta,");
  });

  it("draws them on a layer above the captions, with a two-line hook", () => {
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:01.90,Hook,");
    expect(ass).toContain("THE OCEAN\\NIS LYING TO YOU");
    expect(ass).toContain("Dialogue: 1,0:00:01.50,0:00:03.70,PhotoLabel,");
    expect(ass).toContain("Dialogue: 1,0:00:02.40,0:00:04.00,Cta,");
  });

  it("pops the hook and the stat, and colours the stat's number", () => {
    expect(ass).toMatch(/Hook,[^\n]*\{\\fad\(140,180\)\\t\(0,240,\\fscx104/);
    // #22D3EE written the ASS way: &H00BBGGRR&, no alpha.
    expect(ass).toMatch(/Stat,[^\n]*\{\\c&H00EED322&\\fad\(90,140\)\\t\(0,180,\\fscx108/);
  });

  it("escapes braces rather than letting a caption inject tags", () => {
    const evil = buildAss([{ start: 0, end: 1, text: "a {\\pos(0,0)} b" }], style, 1080, 1920);
    expect(evil).not.toContain("{\\pos(0,0)} b");
    expect(evil).toContain("｛");
  });

  it("skips a card with no words or no time", () => {
    const empty = buildAss(cues, style, 1080, 1920, false, [
      { kind: "hook", start: 0, end: 1, text: "   " },
      { kind: "cta", start: 2, end: 2, text: "Follow" },
    ]);
    expect(empty).not.toMatch(/Dialogue: 1,[^\n]*Hook,/);
    expect(empty).not.toMatch(/Dialogue: 1,[^\n]*Cta,/);
  });
});

describe.skipIf(!ffmpeg)("rendering one for real", () => {
  let dir = "";

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-render-"));
  });
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the temp dir is the OS's business */
    }
  });

  it("renders a short with a photo, effects, a bed, cards and a camera move", async () => {
    const ffmpegPath = ffmpeg!;
    const run = (args: string[]) => spawnSync(ffmpegPath, args, { stdio: "ignore" }).status === 0;

    // A background, a fake voiceover and a real photo, all built here.
    const bg = path.join(dir, "bg.mp4");
    expect(
      run([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=30:duration=4",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        bg,
      ]),
    ).toBe(true);
    const voice = path.join(dir, "voice.wav");
    expect(
      run([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=200:duration=4:sample_rate=48000",
        "-c:a",
        "pcm_s16le",
        voice,
      ]),
    ).toBe(true);
    // A real image file — the render path does not care what is in it.
    // `gradients` is the nicer-looking fixture but it is a newer lavfi source
    // (FFmpeg 5.0+), and a developer machine or CI image with FFmpeg 4.x turns
    // that into a red build for a reason that has nothing to do with the code.
    const photo = path.join(dir, "photo.png");
    const photoFromGradients = run([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "gradients=size=1280x720:duration=1:n=3",
      "-frames:v",
      "1",
      photo,
    ]);
    const photoFromColour =
      photoFromGradients ||
      run(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x1F2937:size=1280x720", "-frames:v", "1", photo]);
    expect(photoFromColour, "this ffmpeg could not produce a test photo (neither gradients nor the color source worked)").toBe(true);

    const impact = await ensureSfx("impact", dir);
    const whoosh = await ensureSfx("whoosh", dir);
    const pulse = await ensurePulse(dir);
    expect(impact && whoosh && pulse).toBeTruthy();

    const out = path.join(dir, "short.mp4");
    const progress: number[] = [];
    await runFfmpegExport({
      videoPath: bg,
      audioPath: voice,
      subtitles: cues,
      subtitleStyle: style,
      settings: {
        resolution: { width: 270, height: 480 },
        format: "mp4",
        quality: "low",
        fps: 30,
        watermark: false,
        audioVolume: 1,
        fadeOut: 0.3,
        duration: 4,
      },
      outputPath: out,
      onProgress: (p) => progress.push(p),
      media: {
        images: [{ path: photo, start: 1.0, end: 3.4, width: 200, x: 35, y: 43, popIn: 0.22 }],
        sounds: [
          { path: impact!, at: 0, gain: 0.8 },
          { path: whoosh!, at: 1.0, gain: 0.55 },
        ],
        music: { path: pulse!, gain: 0.07, duck: true },
        cards: [
          { kind: "hook", start: 0, end: 1.6, text: "YOUR BRAIN\nLIES ABOUT TIME" },
          { kind: "photo", start: 1.0, end: 3.2, text: "slow motion" },
          { kind: "cta", start: 3.2, end: 4, text: "Follow for more" },
        ],
        motion: { kind: "pulse", pulses: [1.0, 3.2] },
        flashes: [0.04],
      },
    });

    expect(fs.existsSync(out)).toBe(true);
    const probed = await probeMedia(out);
    expect(probed.hasVideo).toBe(true);
    expect(probed.hasAudio).toBe(true);
    expect(probed.width).toBe(270);
    expect(probed.height).toBe(480);
    expect(probed.duration).toBeGreaterThan(3.4);
    expect(probed.duration).toBeLessThan(4.6);
    expect(progress.at(-1)).toBe(100);
  }, 120_000);

  it("still renders the plain short — the path every earlier version used", async () => {
    const ffmpegPath = ffmpeg!;
    const run = (args: string[]) => spawnSync(ffmpegPath, args, { stdio: "ignore" }).status === 0;
    const bg = path.join(dir, "bg2.mp4");
    run([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      bg,
    ]);
    const voice = path.join(dir, "voice2.wav");
    run([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=200:duration=3:sample_rate=48000",
      "-c:a",
      "pcm_s16le",
      voice,
    ]);
    const out = path.join(dir, "plain.mp4");
    await runFfmpegExport({
      videoPath: bg,
      audioPath: voice,
      subtitles: cues,
      subtitleStyle: style,
      settings: {
        resolution: { width: 270, height: 480 },
        format: "mp4",
        quality: "low",
        fps: 30,
        watermark: false,
        audioVolume: 1,
        fadeOut: 0.3,
        duration: 3,
      },
      outputPath: out,
    });
    const probed = await probeMedia(out);
    expect(probed.hasVideo).toBe(true);
    expect(probed.hasAudio).toBe(true);
  }, 120_000);
});
