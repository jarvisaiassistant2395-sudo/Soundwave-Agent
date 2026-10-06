import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, resolveFfmpegPath } from "../config.js";
import { captionFontDir, captionFontFamily, smallFontFamily } from "./captionFont.js";

// ── FFmpeg export pipeline ──────────────────────────────────────────────────
// Client-generated audio + background video + JSON subtitles are composited
// server-side. This is the ONLY server interaction involving audio, and only
// when the user explicitly initiates a video export.

export interface ExportSettings {
  resolution: { width: number; height: number };
  format: "mp4" | "webm";
  quality: "low" | "medium" | "high";
  fps: number;
  watermark: boolean;
  audioVolume?: number; // 0..1
  fadeIn?: number; // seconds
  fadeOut?: number; // seconds
  /** How long the output runs (seconds). Defaults to the audio length when
   *  set by the route; the video input is looped/truncated to match. */
  duration?: number;
}

export interface SubtitleStyleInput {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  letterSpacing?: number;
  lineHeight?: number;
  color?: string;
  textOpacity?: number;
  bgColor?: string;
  bgOpacity?: number;
  bgPadding?: number;
  bgRadius?: number;
  strokeEnabled?: boolean;
  strokeColor?: string;
  strokeWidth?: number;
  shadowEnabled?: boolean;
  shadowColor?: string;
  shadowBlur?: number;
  shadowX?: number;
  shadowY?: number;
  hAlign?: "left" | "center" | "right";
  vAlign?: "top" | "middle" | "bottom";
  customX?: number | null;
  customY?: number | null;
  margin?: number;
  animIn?: string;
  animOut?: string;
  animDuration?: number;
}

export interface SubtitleCueInput {
  start: number;
  end: number;
  text: string;
}

// ── What a storyboard becomes on the timeline ───────────────────────────────
// The plan itself (which beats, which words, which sounds) is brain/core/
// storyboard.ts. By the time it reaches here every beat is already measured in
// pixels and seconds — the renderer never guesses what a beat "should" be, it
// draws what it was handed. That split is what makes both halves testable.

/** A photo that pops in over the gameplay. */
export interface OverlayImageInput {
  path: string;
  start: number;
  end: number;
  /** The card's width in output pixels (its height follows the picture). */
  width: number;
  /** Top-left corner in output pixels (the caller centres it). */
  x: number;
  y: number;
  /** Seconds of the pop-in scale; 0 cuts in hard. */
  popIn?: number;
  /** A white hairline around the card, which separates it from dark gameplay. */
  border?: boolean;
}

/** A sound effect on the timeline (or the music bed, which starts at 0). */
export interface SoundEventInput {
  path: string;
  at: number;
  /** Mixed level; the narration is 1. */
  gain?: number;
}

export type CardKind = "hook" | "photo" | "stat" | "cta";

/** Words burned over the picture, in the style the kind deserves. */
export interface CardInput {
  kind: CardKind;
  start: number;
  end: number;
  text: string;
  /** 6-digit hex for stat/cta accents. */
  accent?: string;
}

export type MotionKind = "none" | "push" | "drift" | "pulse";

export interface MediaInput {
  images?: OverlayImageInput[];
  sounds?: SoundEventInput[];
  /** The percussion bed: looped under the whole short and ducked by the voice. */
  music?: { path: string; gain?: number; duck?: boolean };
  cards?: CardInput[];
  /** Camera move on the gameplay, so the background is never a still frame. */
  motion?: { kind: MotionKind; /** Beat times, for "pulse". */ pulses?: number[] };
  /** Hard white flash cuts (seconds) — two at most, from the storyboard. */
  flashes?: number[];
}

export interface ExportParams {
  videoPath: string;
  audioPath: string;
  subtitles: SubtitleCueInput[];
  subtitleStyle: SubtitleStyleInput;
  settings: ExportSettings;
  outputPath: string;
  /** The storyboard's pictures, sounds and cards. Absent = the plain render. */
  media?: MediaInput;
  onProgress?: (pct: number) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ── ASS generation ──────────────────────────────────────────────────────────
function hexToAss(hex: string, opacityPct: number): string {
  const clean = (hex ?? "#FFFFFF").replace("#", "");
  const parseHex = (s: string) => {
    const val = parseInt(s, 16);
    return isNaN(val) ? 0 : val;
  };
  const r = parseHex(clean.slice(0, 2));
  const g = parseHex(clean.slice(2, 4));
  const b = parseHex(clean.slice(4, 6));
  const alpha = Math.round(((100 - clamp(opacityPct, 0, 100)) / 100) * 255);
  const toHex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `&H${toHex(alpha)}${toHex(b)}${toHex(g)}${toHex(r)}`;
}

/**
 * An ASS *inline* colour (the `\c` tag): `&HBBGGRR&`, no alpha component —
 * unlike the style line's `&HAABBGGRR`. Getting this wrong paints a stat card
 * a random colour, which is exactly what an alpha byte in `\c` buys you.
 */
function assInlineColor(hex: string): string {
  const clean = (hex ?? "#FFFFFF").replace("#", "").toUpperCase().padEnd(6, "0");
  const [r, g, b] = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)];
  return `&H00${b}${g}${r}&`;
}

function assTime(seconds: number): string {
  const s = clamp(seconds, 0, 359999);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(sec)).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escAss(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\n/g, "\\N")
    .replace(/\{/g, "｛")
    .replace(/\}/g, "｝");
}

function alignmentFor(h: SubtitleStyleInput["hAlign"], v: SubtitleStyleInput["vAlign"]): number {
  const map: Record<string, number> = {
    "bottom-left": 1, "bottom-center": 2, "bottom-right": 3,
    "middle-left": 4, "middle-center": 5, "middle-right": 6,
    "top-left": 7, "top-center": 8, "top-right": 9,
  };
  return map[`${v ?? "bottom"}-${h ?? "center"}`] ?? 2;
}

export function buildAss(
  subtitles: SubtitleCueInput[],
  style: SubtitleStyleInput,
  width: number,
  height: number,
  watermark = false,
  cards: CardInput[] = [],
): string {
  // Scale font appropriately: for vertical 9:16 videos, scale against 720 reference width
  const scale = height > width ? (width / 720) : Math.min(width / 1280, height / 720);
  const fontSize = Math.round((style.fontSize ?? 54) * scale);
  const outline = style.strokeEnabled !== false ? Math.max(3, Math.round((style.strokeWidth ?? 4) * scale)) : 0;
  const shadow = style.shadowEnabled !== false
    ? Math.max(1, Math.round(Math.max(Math.abs(style.shadowX ?? 0), Math.abs(style.shadowY ?? 0), (style.shadowBlur ?? 2) / 2) * scale))
    : 0;
  const spacing = Math.round((style.letterSpacing ?? 0) * scale);
  const margin = Math.round((style.margin ?? 40) * scale);
  const primary = hexToAss(style.color ?? "#FFFFFF", style.textOpacity ?? 100);
  const outlineColor = hexToAss(style.strokeColor ?? "#000000", 100);
  const backColor = hexToAss("#000000", 60);

    // The caption face: what the caller asked for, else the font we ship
    // (assets/fonts, Inter) — never a font that only some machines have.
    const fontFace = (style.fontFamily || captionFontFamily()).replace(/,/g, "").trim() || "DejaVu Sans";
    // The style's own weight was being dropped on the floor: every caption was
    // written with Bold=0, so a "800" style rendered as regular. The shipped
    // ExtraBold family carries its weight in its name, so this flag only bites
    // for fonts named the ordinary way — which is exactly when it should.
    const bold = (style.fontWeight ?? 800) >= 600 ? 1 : 0;
    const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontFace},${fontSize},${primary},${primary},${outlineColor},${backColor},${bold},0,0,0,100,100,${spacing},0,1,${outline},${shadow},${alignmentFor(style.hAlign, style.vAlign)},${margin},${margin},${margin},1`,
    `Style: Watermark,${smallFontFamily()},${Math.max(16, Math.round(28 * scale))},${hexToAss("#FFFFFF", 55)},${hexToAss("#FFFFFF", 55)},${hexToAss("#000000", 0)},${hexToAss("#000000", 0)},0,0,0,0,100,100,0,0,1,1,0,9,20,20,20,1`,
    // ── The storyboard's cards ────────────────────────────────────────────
    // Four fixed places on the frame, so a card can never land on the
    // narration's captions (middle-centre, style Default above) or on another
    // card: the hook owns the top third, the photo label and the stat sit in
    // the bottom band, and the follow card gets the bottom line to itself.
    // BorderStyle=3 is libass' boxed mode: the text sits on its own band
    // instead of a stroke, which is how a hook reads over gameplay.
    `Style: Hook,${fontFace},${Math.round(96 * scale)},${hexToAss("#FFFFFF", 100)},${hexToAss("#FFFFFF", 100)},${hexToAss("#000000", 0)},${hexToAss("#08090C", 78)},${bold},0,0,0,100,100,0,0,3,0,0,8,${Math.round(width * 0.07)},${Math.round(width * 0.07)},${Math.round(height * 0.09)},1`,
    `Style: PhotoLabel,${fontFace},${Math.round(44 * scale)},${hexToAss("#FFFFFF", 100)},${hexToAss("#FFFFFF", 100)},${hexToAss("#000000", 100)},${hexToAss("#000000", 0)},${bold},0,0,0,100,100,0,0,1,${Math.max(2, Math.round(5 * scale))},0,2,${margin},${margin},${Math.round(height * 0.1)},1`,
    `Style: Stat,${fontFace},${Math.round(76 * scale)},${hexToAss("#22D3EE", 100)},${hexToAss("#FFFFFF", 100)},${hexToAss("#000000", 100)},${hexToAss("#08090C", 62)},0,0,0,0,100,100,0,0,3,0,0,2,${Math.round(width * 0.08)},${Math.round(width * 0.08)},${Math.round(height * 0.22)},1`,
    `Style: Cta,${fontFace},${Math.round(64 * scale)},${hexToAss("#08090C", 100)},${hexToAss("#08090C", 100)},${hexToAss("#000000", 0)},${hexToAss("#22D3EE", 96)},${bold},0,0,0,100,100,0,0,3,0,0,2,${Math.round(width * 0.1)},${Math.round(width * 0.1)},${Math.round(height * 0.12)},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  if (watermark) {
    header.push("Dialogue: 0,0:00:00.00,9:59:59.00,Watermark,,0,0,0,,{\\alpha&H80&}Soundwave AI");
  }

  // Cards first — they are on layer 1, so they draw over any caption that
  // happens to share the frame, never under it.
  const styleForCard: Record<CardKind, string> = { hook: "Hook", photo: "PhotoLabel", stat: "Stat", cta: "Cta" };
  for (const card of cards) {
    const text = escAss(card.text.trim());
    if (!text || card.end <= card.start) continue;
    // Hook and stat punch in (a scale pop an editor would call a "snap"); the
    // label and the follow card just fade, because they are not the punchline.
    const anim =
      card.kind === "hook"
        ? `{\\fad(140,180)\\t(0,240,\\fscx104\\fscy104)\\t(240,460,\\fscx100\\fscy100)}`
        : card.kind === "stat"
          ? `{\\fad(90,140)\\t(0,180,\\fscx108\\fscy108)\\t(180,340,\\fscx100\\fscy100)}`
          : `{\\fad(120,140)}`;
    const accent = card.accent && card.kind === "stat" ? `\\c${assInlineColor(card.accent)}` : "";
    const styled = `{${accent}${anim.slice(1)}`;
    header.push(
      `Dialogue: 1,${assTime(card.start)},${assTime(card.end)},${styleForCard[card.kind]},,0,0,0,,${styled}${text}`,
    );
  }

  const animIn = style.animIn ?? "fade";
  const animOut = style.animOut ?? "fade";
  const durMs = style.animDuration ?? 250;
  const fadIn = animIn === "fade" ? Math.round(durMs / 10) : 0;
  const fadOut = animOut === "fade" ? Math.round(durMs / 10) : 0;

  const lines: string[] = [];
  for (const cue of subtitles) {
    if (!cue.text.trim()) continue;
    const dur = Math.max(0.05, cue.end - cue.start);
    const x =
      style.customX != null ? (style.customX / 100) * width
      : style.hAlign === "left" ? margin
      : style.hAlign === "right" ? width - margin
      : width / 2;
    const y =
      style.customY != null ? (style.customY / 100) * height
      : style.vAlign === "top" ? margin
      : style.vAlign === "middle" ? height / 2
      : height - margin;

    let tags = "";
    if (fadIn || fadOut) tags += `\\fad(${fadIn},${fadOut})`;

    if (animIn === "slideUp" || animIn === "slideDown" || animIn === "slideLeft" || animIn === "slideRight") {
      const fromX = animIn === "slideLeft" ? x + 80 : animIn === "slideRight" ? x - 80 : x;
      const fromY = animIn === "slideUp" ? y + 60 : animIn === "slideDown" ? y - 60 : y;
      tags += `\\move(${Math.round(fromX)},${Math.round(fromY)},${Math.round(x)},${Math.round(y)},0,${Math.round(durMs)})`;
    } else if (animIn === "scale") {
      tags += `\\t(0,${Math.round(durMs)},\\fscx60\\fscy60)` + `\\t(0,${Math.round(durMs)},\\fscx100\\fscy100)`;
    }

    // ASS override tags only take effect inside a { … } block — previously
    // they were prepended bare, so "\fad(25,25)" was burned into the video
    // as literal text for the default fade animation.
    const tagBlock = tags ? `{${tags}}` : "";

    const isWordAnim = animIn === "wordByWord" || animIn === "typewriter";
    if (isWordAnim) {
      // Cumulative word-by-word reveal across the cue duration.
      const words = cue.text.split(/\s+/).filter(Boolean);
      if (words.length <= 1) {
        lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${tagBlock}${escAss(cue.text)}`);
      } else {
        const wordDur = dur / words.length;
        for (let i = 0; i < words.length; i++) {
          const start = cue.start + wordDur * i;
          const end = Math.min(cue.end, start + wordDur * 2);
          const prefix = words.slice(0, i + 1).join(" ");
          let text = escAss(prefix);
          if (animIn === "wordByWord" && i === words.length - 1) {
            text = `${escAss(words.slice(0, i).join(" "))} {\\c&H00FDE0&}${escAss(words[i]!)}`;
          }
          lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${tagBlock}${text}`);
        }
      }
    } else if (style.customX != null || style.customY != null) {
      lines.push(
        `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,{\\pos(${Math.round(x)},${Math.round(y)})}${tagBlock}${escAss(cue.text)}`,
      );
    } else {
      lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${tagBlock}${escAss(cue.text)}`);
    }
  }

  return [...header, ...lines].join("\n");
}

// ── Probe & export ──────────────────────────────────────────────────────────
export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export function probeMedia(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpegPath();
    const child = spawn(ffmpeg, ["-i", filePath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      const duration = durMatch
        ? parseInt(durMatch[1]!) * 3600 + parseInt(durMatch[2]!) * 60 + parseFloat(durMatch[3]!)
        : 0;
      const vidMatch = stderr.match(/(\d{2,5})x(\d{2,5})/);
      const hasVideo = /Video:/.test(stderr);
      const hasAudio = /Audio:/.test(stderr);
      if (code !== 0 && !hasVideo && !hasAudio) {
        reject(new Error("Unrecognized media file"));
        return;
      }
      resolve({
        duration,
        width: vidMatch ? parseInt(vidMatch[1]!, 10) : 1920,
        height: vidMatch ? parseInt(vidMatch[2]!, 10) : 1080,
        hasVideo,
        hasAudio,
      });
    });
  });
}

/** Escape a filesystem path for use as an ffmpeg filter-option value.
 *  On Windows the drive colon ("C:\") terminates the option for the filter
 *  parser (the famous "Unable to parse 'original_size' …" error), and
 *  backslashes/spaces need quoting — normalize to forward slashes and
 *  single-quote with escaped colon/apostrophe. */
export function ffmpegFilterPath(p: string): string {
  const fwd = p.replace(/\\/g, "/");
  return `'${fwd.replace(/:/g, "\\:").replace(/'/g, "\\'")}'`;
}

// ── The two argv builders: a plain render, and a storyboard render ──────────
// `buildFfmpegArgs` is the whole render as a list of strings — no process, no
// filesystem, nothing that can fail — which is what makes the compositing
// testable without running ffmpeg (tests/short_render.test.ts asserts the
// graph: the beat windows, the mixes, the camera move). `runFfmpegExport`
// below is the thin part that writes the ASS file, spawns ffmpeg and reads its
// progress back.
//
// The plain path is the render every earlier short used, byte for byte: when
// there is no storyboard, the old single `-vf` filter is built exactly as
// before. The rich path only appears when a plan has something to draw — so a
// person who turns the viral edit off, or a niche with no pictures, still gets
// today's output and today's speed.

export interface FfmpegArgContext {
  /** Where the captions/cards ASS file was written. */
  assPath: string;
  /** assets/fonts, when the shipped caption font was found. */
  fontDir: string | null;
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** `between()` terms for the beats a camera pulse lands on. */
function pulseExpression(pulses: number[], hitSeconds: number, cap = 24): string {
  const hits = pulses
    .filter((p) => Number.isFinite(p) && p >= 0)
    .slice(0, cap)
    .map((p) => `between(t,${p.toFixed(2)},${(p + hitSeconds).toFixed(2)})`);
  return hits.length ? hits.join("+") : "0";
}

/** ffmpeg wants audio delays in whole milliseconds, per channel or `all=1`. */
export function ms(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}

function hasMedia(media: ExportParams["media"]): boolean {
  if (!media) return false;
  return Boolean(
    media.images?.length || media.sounds?.length || media.music || media.cards?.length || media.flashes?.length || (media.motion && media.motion.kind !== "none"),
  );
}

/**
 * The complete ffmpeg command for a render, as argv.
 *
 * Input order is fixed and load-bearing, because the filter graph refers to
 * inputs by number: 0 is the gameplay (looped), 1 the narration, then the
 * photos, then the sound effects, then the music bed. Photos are looped stills
 * with a duration, shifted onto the timeline with `setpts`, which is what lets
 * a beat's window (and its fade) be written in the *short's* seconds rather
 * than the picture's.
 */
export function buildFfmpegArgs(params: ExportParams, ctx: FfmpegArgContext): string[] {
  const { videoPath, audioPath, outputPath, settings, media } = params;
  const { resolution, format, quality, fps } = settings;
  const { width: W, height: H } = resolution;

  // How long the output runs: explicit duration (audio length or the user's
  // chosen end), else the subtitle timeline end, else 10s.
  const outDuration =
    settings.duration && settings.duration > 0 ? settings.duration : params.subtitles.reduce((m, c) => Math.max(m, c.end), 0) || 10;

  // The audio chain's volume + fades (the tail fade is on the mix in the rich
  // path, on the voice alone in the plain one).
  const afParts: string[] = [];
  if (settings.audioVolume != null && settings.audioVolume !== 1) {
    afParts.push(`volume=${clamp(settings.audioVolume, 0, 2).toFixed(3)}`);
  }
  if (settings.fadeIn && settings.fadeIn > 0) {
    afParts.push(`afade=t=in:st=0:d=${clamp(settings.fadeIn, 0, 30).toFixed(2)}`);
  }
  if (settings.fadeOut && settings.fadeOut > 0) {
    const st = Math.max(0, outDuration - settings.fadeOut);
    afParts.push(`afade=t=out:st=${st.toFixed(2)}:d=${clamp(settings.fadeOut, 0, 30).toFixed(2)}`);
  }

  const images = media?.images ?? [];
  const sounds = media?.sounds ?? [];
  const music = media?.music;
  const videoFilters = `${`scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`},subtitles=${ffmpegFilterPath(ctx.assPath)}${ctx.fontDir ? `:fontsdir=${ffmpegFilterPath(ctx.fontDir)}` : ""}`;

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", videoPath, "-i", audioPath];

  // ── The plain render (no storyboard) ──────────────────────────────────────
  if (!hasMedia(media)) {
    args.push("-map", "0:v:0", "-map", "1:a:0", "-vf", videoFilters);
    if (afParts.length) args.push("-af", afParts.join(","));
    pushCodecs(args, format, quality);
    args.push("-r", String(fps), "-t", outDuration.toFixed(3), "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", outputPath);
    return args;
  }

  // ── Inputs: photos, effects, music ────────────────────────────────────────
  for (const image of images) {
    const hold = Math.max(0.2, image.end - image.start + 0.15);
    // 30fps so a fade or a pop has frames to animate over; -t is the picture's
    // own length, before setpts moves it onto the short's timeline.
    args.push("-framerate", "30", "-loop", "1", "-t", hold.toFixed(3), "-i", image.path);
  }
  for (const sound of sounds) args.push("-i", sound.path);
  if (music) args.push("-stream_loop", "-1", "-i", music.path);

  const imageBase = 2;
  const soundBase = imageBase + images.length;
  const musicIndex = soundBase + sounds.length;

  const parts: string[] = [];

  // ── Background: fill the frame, and keep the camera alive ─────────────────
  const motion = media?.motion?.kind ?? "none";
  if (motion === "none") {
    parts.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[base]`);
  } else if (motion === "drift") {
    // A slow lateral pan: a static scale and a moving window, which costs
    // almost nothing (no per-frame resampling) and kills the still-frame feel.
    const bw = even(W * 1.16);
    const bh = even(H * 1.16);
    parts.push(
      `[0:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},setsar=1,` +
        `crop=${W}:${H}:x='(iw-ow)/2*(1+sin(2*PI*t/13))':y='(ih-oh)/2*(1+cos(2*PI*t/17))'[base]`,
    );
  } else {
    // push = one long zoom in; pulse = a 3.5% punch-in on each beat.
    const over = motion === "push" ? 1.08 : 1.06;
    const bw = even(W * over);
    const bh = even(H * over);
    const zoom =
      motion === "push"
        ? `1+0.08*min(t/${outDuration.toFixed(2)},1)`
        : `1+0.035*min(${pulseExpression(media?.motion?.pulses ?? [], 0.12)},1)`;
    parts.push(
      `[0:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},setsar=1,` +
        `scale=w='floor(${bw}*(${zoom})/2)*2':h='floor(${bh}*(${zoom})/2)*2':eval=frame:flags=bicubic,` +
        `crop=${W}:${H}:x='(iw-ow)/2':y='(ih-oh)/2'[base]`,
    );
  }

  // ── Photos: pop in, hold, fade out ────────────────────────────────────────
  let last = "base";
  images.forEach((image, i) => {
    const idx = imageBase + i;
    const pop = clamp(image.popIn ?? 0.22, 0, 1.5);
    const fadeOut = 0.2;
    const exitAt = Math.max(image.start + 0.3, image.end - fadeOut);
    const scale =
      pop > 0
        ? `scale=w='floor(${even(image.width)}*if(lt(t,${(image.start + pop).toFixed(2)}),0.86+0.14*max(t-${image.start.toFixed(2)},0)/${pop.toFixed(2)},1)/2)*2':h=-2:eval=frame:flags=bicubic`
        : `scale=${even(image.width)}:-2:flags=bicubic`;
    const border = image.border === false ? "" : ",drawbox=x=0:y=0:w=iw:h=ih:color=white@0.85:t=6";
    parts.push(
      `[${idx}:v]setpts=PTS+${image.start.toFixed(3)}/TB,${scale}${border},format=rgba,` +
        `fade=t=in:st=${image.start.toFixed(2)}:d=${Math.max(0.08, pop).toFixed(2)}:alpha=1,` +
        `fade=t=out:st=${exitAt.toFixed(2)}:d=${fadeOut.toFixed(2)}:alpha=1[img${i}]`,
    );
    const next = `v${i}`;
    parts.push(
      `[${last}][img${i}]overlay=x=${Math.round(image.x)}:y=${Math.round(image.y)}:enable='between(t,${image.start.toFixed(2)},${image.end.toFixed(2)})'[${next}]`,
    );
    last = next;
  });

  // ── Flash cuts ────────────────────────────────────────────────────────────
  const flashes = (media?.flashes ?? []).filter((t) => Number.isFinite(t) && t >= 0).slice(0, 4);
  if (flashes.length) {
    const enable = flashes.map((t) => `between(t,${t.toFixed(2)},${(t + 0.07).toFixed(2)})`).join("+");
    parts.push(`[${last}]drawbox=x=0:y=0:w=iw:h=ih:color=white@0.5:t=fill:enable='${enable}'[flashed]`);
    last = "flashed";
  }

  // ── Captions and cards, on top of all of it ───────────────────────────────
  parts.push(`[${last}]subtitles=${ffmpegFilterPath(ctx.assPath)}${ctx.fontDir ? `:fontsdir=${ffmpegFilterPath(ctx.fontDir)}` : ""}[vout]`);

  // ── Audio: the voice, its effects, and a bed that gets out of its way ─────
  // Everything is normalized to the same sample format first: `amix` refuses
  // inputs that don't agree, and a phone/TTS voice can arrive at 24 kHz mono.
  const fmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
  const voiceParts = [`[1:a]${fmt}`, `volume=${clamp(settings.audioVolume ?? 1, 0, 2).toFixed(3)}`];
  const duck = Boolean(music && music.duck !== false);
  const hasMix = sounds.length > 0 || Boolean(music);
  if (!hasMix) {
    // Nothing to mix (cards and a camera move, no sounds): the voice goes
    // straight out, exactly as the plain render does.
    parts.push(`${voiceParts.join(",")}${afParts.length ? `,${afParts.join(",")}` : ""}[aout]`);
  } else if (duck) {
    // Two copies of the voice: one to hear, one to duck the music with.
    parts.push(`${voiceParts.join(",")},asplit=2[voice][voicekey]`);
  } else {
    parts.push(`${voiceParts.join(",")}[voice]`);
  }
  const mixInputs: string[] = hasMix ? ["voice"] : [];
  sounds.forEach((sound, i) => {
    parts.push(
      `[${soundBase + i}:a]${fmt},volume=${clamp(sound.gain ?? 0.6, 0, 4).toFixed(2)},adelay=${ms(sound.at)}:all=1[sfx${i}]`,
    );
    mixInputs.push(`sfx${i}`);
  });
  if (music) {
    // The bed comes in under the voice and ducks while it speaks
    // (sidechaincompress), which is the difference between music and noise.
    const bed = `[${musicIndex}:a]${fmt},volume=${clamp(music.gain ?? 0.08, 0, 1).toFixed(3)}`;
    parts.push(
      music.duck !== false
        ? `${bed}[musicraw];[musicraw][voicekey]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300[music]`
        : `${bed}[music]`,
    );
    mixInputs.push("music");
  }
  if (hasMix) {
    const afterMix = afParts.length ? `,${afParts.join(",")}` : "";
    parts.push(`${mixInputs.map((m) => `[${m}]`).join("")}amix=inputs=${mixInputs.length}:normalize=0:dropout_transition=0${afterMix}[aout]`);
  }

  args.push("-filter_complex", parts.join(";"));
  args.push("-map", "[vout]", "-map", "[aout]");
  pushCodecs(args, format, quality);
  args.push("-r", String(fps), "-t", outDuration.toFixed(3), "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", outputPath);
  return args;
}

function pushCodecs(args: string[], format: ExportSettings["format"], quality: ExportSettings["quality"]): void {
  if (format === "mp4") {
    const crf = quality === "low" ? 28 : quality === "medium" ? 23 : 18;
    const preset = quality === "low" ? "veryfast" : quality === "medium" ? "medium" : "slow";
    args.push("-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k");
  } else {
    const crf = quality === "low" ? 36 : quality === "medium" ? 31 : 26;
    const cpu = quality === "high" ? 2 : 4;
    args.push("-c:v", "libvpx-vp9", "-crf", String(crf), "-b:v", "0", "-cpu-used", String(cpu), "-row-mt", "1", "-c:a", "libopus", "-b:a", "160k");
  }
}

export function runFfmpegExport(params: ExportParams): Promise<void> {
  return new Promise((resolve, reject) => {
    const { outputPath, settings, onProgress } = params;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Write the ASS file to a safe temp location. It carries the captions and,
    // when there is a storyboard, its cards (hook, stat, photo labels, follow).
    const assPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.ass`);
    fs.writeFileSync(assPath, buildAss(params.subtitles, params.subtitleStyle, settings.resolution.width, settings.resolution.height, settings.watermark, params.media?.cards ?? []), "utf8");

    const args = buildFfmpegArgs(params, { assPath, fontDir: captionFontDir() });

    const ffmpeg = resolveFfmpegPath();
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let duration = 0;
    child.stdout.on("data", (d: Buffer) => {
      const txt = d.toString();
      const dm = txt.match(/out_time_ms=(\d+)/);
      if (!duration) {
        duration = settings.duration && settings.duration > 0 ? settings.duration : params.subtitles.reduce((m, c) => Math.max(m, c.end), 0) || 10;
      }
      if (dm) {
        const ms = parseInt(dm[1]!, 10) / 1000;
        const pct = duration > 0 ? clamp((ms / duration) * 100, 0, 99) : 0;
        onProgress?.(pct);
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      try {
        fs.unlinkSync(assPath);
      } catch { /* ignore */ }
      reject(e);
    });
    child.on("close", (code) => {
      try {
        fs.unlinkSync(assPath);
      } catch { /* ignore */ }
      if (code === 0) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(stderr.slice(-800) || `FFmpeg exited with code ${code}`));
      }
    });
  });
}

export { resolveFfmpegPath };
