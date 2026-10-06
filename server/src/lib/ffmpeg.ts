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

export interface ExportParams {
  videoPath: string;
  audioPath: string;
  subtitles: SubtitleCueInput[];
  subtitleStyle: SubtitleStyleInput;
  settings: ExportSettings;
  outputPath: string;
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
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  if (watermark) {
    header.push("Dialogue: 0,0:00:00.00,9:59:59.00,Watermark,,0,0,0,,{\\alpha&H80&}Soundwave AI");
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

export function runFfmpegExport(params: ExportParams): Promise<void> {
  return new Promise((resolve, reject) => {
    const { videoPath, audioPath, outputPath, settings, onProgress } = params;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const { resolution, format, quality, fps } = settings;
    // FIX: Portrait 9:16 should FILL frame, not letterbox with black bars
    // User screenshot showed landscape video centered with huge black bars top/bottom
    // For Shorts/TikTok, we want crop-to-fill: scale to cover then crop center
    // Old: scale=WxH:force_original_aspect_ratio=decrease,pad=WxH:(ow-iw)/2:(oh-ih)/2:color=black (letterbox)
    // New: scale=WxH:force_original_aspect_ratio=increase,crop=WxH (fill, no black bars)
    const scaleFilter = `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=increase,crop=${resolution.width}:${resolution.height}`;

    // Write the ASS file to a safe temp location.
    const assPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.ass`);
    fs.writeFileSync(
      assPath,
      buildAss(params.subtitles, params.subtitleStyle, resolution.width, resolution.height, settings.watermark),
      "utf8",
    );

    // Drive-colon-safe path quoting (Windows) for the subtitles filter, plus the
    // directory holding the font we ship: libass loads those files itself, so a
    // machine with no Inter installed still draws captions in Inter.
    const fontDir = captionFontDir();
    const vf = `${scaleFilter},subtitles=${ffmpegFilterPath(assPath)}${fontDir ? `:fontsdir=${ffmpegFilterPath(fontDir)}` : ""}`;

    // How long the output runs: explicit duration (audio length or the
    // user's chosen end), else the subtitle timeline end, else 10s.
    const outDuration =
      settings.duration && settings.duration > 0
        ? settings.duration
        : params.subtitles.reduce((m, c) => Math.max(m, c.end), 0) || 10;

    // -stream_loop -1: a background clip shorter than the voice loops until
    // the output length is reached, so the voiceover is never cut off.
    const args: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", videoPath, "-i", audioPath];

    // Audio chain: volume + fades (applied only when specified).
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

    if (format === "mp4") {
      const crf = quality === "low" ? 28 : quality === "medium" ? 23 : 18;
      const preset = quality === "low" ? "veryfast" : quality === "medium" ? "medium" : "slow";
      args.push("-map", "0:v:0", "-map", "1:a:0", "-vf", vf);
      if (afParts.length) args.push("-af", afParts.join(","));
      args.push("-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k");
    } else {
      const crf = quality === "low" ? 36 : quality === "medium" ? 31 : 26;
      const cpu = quality === "high" ? 2 : 4;
      args.push("-map", "0:v:0", "-map", "1:a:0", "-vf", vf);
      if (afParts.length) args.push("-af", afParts.join(","));
      args.push("-c:v", "libvpx-vp9", "-crf", String(crf), "-b:v", "0", "-cpu-used", String(cpu), "-row-mt", "1", "-c:a", "libopus", "-b:a", "160k");
    }

    // -t decides the end (min of audio; video loops or truncates to fit).
    args.push("-r", String(fps), "-t", outDuration.toFixed(3), "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", outputPath);

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
