/**
 * Soundwave AI — Creator Mode: Silence Removal & Auto-Jump-Cut Engine
 * Analyzes audio amplitude, detects dead air/pauses, cuts silence with safety padding,
 * and renders smooth, professional screen captures with Screen-Studio-style framing and zoom.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { resolveFfmpegPath } from "../config.js";
import { probeMedia } from "./ffmpeg.js";

export interface SilenceDetectOptions {
  noiseThresholdDb?: number; // e.g. -30 dB (lower = stricter silence, higher = cuts softer pauses)
  minSilenceDuration?: number; // e.g. 0.4s
  paddingSec?: number; // safety padding before and after speech (e.g. 0.15s)
}

export interface SpeechInterval {
  start: number;
  end: number;
  duration: number;
}

export interface SilenceAnalysisResult {
  totalDuration: number;
  hasAudio: boolean;
  hasVideo: boolean;
  originalDuration: number;
  estimatedDuration: number;
  savedDuration: number;
  savedPercent: number;
  cutsCount: number;
  silenceIntervals: Array<{ start: number; end: number; duration: number }>;
  speechIntervals: SpeechInterval[];
  timelineBlocks: Array<{
    start: number;
    end: number;
    duration: number;
    type: "speech" | "silence";
  }>;
}

export interface FramingOptions {
  aspect?: "16:9" | "9:16" | "1:1";
  zoomFactor?: number; // 1.0 = normal, 1.15 = subtle, 1.35 = focus
  backdrop?: "gradient_cyber" | "gradient_purple" | "midnight" | "none";
  paddingPercent?: number; // 0..15% margin around screen capture
  focusRegion?: "center" | "top_left" | "top_right" | "bottom_left" | "bottom_right";
  quality?: "fast" | "high";
}

export interface AutoEditOptions {
  inputPath: string;
  outputPath: string;
  speechIntervals?: SpeechInterval[];
  silenceOptions?: SilenceDetectOptions;
  framing?: FramingOptions;
  onProgress?: (percent: number) => void;
}

/**
 * Detect silence intervals in an audio/video file using FFmpeg's silencedetect filter.
 */
export async function detectSilenceIntervals(filePath: string, options: SilenceDetectOptions = {}): Promise<SilenceAnalysisResult> {
  const probe = await probeMedia(filePath);
  const totalDuration = Math.max(0.1, probe.duration);

  if (!probe.hasAudio) {
    return {
      totalDuration,
      hasAudio: false,
      hasVideo: probe.hasVideo,
      originalDuration: totalDuration,
      estimatedDuration: totalDuration,
      savedDuration: 0,
      savedPercent: 0,
      cutsCount: 0,
      silenceIntervals: [],
      speechIntervals: [{ start: 0, end: totalDuration, duration: totalDuration }],
      timelineBlocks: [{ start: 0, end: totalDuration, duration: totalDuration, type: "speech" }],
    };
  }

  const noise = options.noiseThresholdDb ?? -30;
  const minDur = options.minSilenceDuration ?? 0.4;
  const padding = options.paddingSec ?? 0.15;

  const ffmpeg = resolveFfmpegPath();
  const args = ["-i", filePath, "-af", `silencedetect=noise=${noise}dB:d=${minDur}`, "-f", "null", "-"];

  const rawSilences: Array<{ start: number; end: number }> = [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        // silencedetect might exit with non-zero on corrupt streams, but check if we got output
      }

      let currentStart: number | null = null;
      const lines = stderr.split("\n");

      for (const line of lines) {
        if (!line.includes("silencedetect")) continue;

        const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
        if (startMatch && startMatch[1]) {
          currentStart = parseFloat(startMatch[1]);
        }

        const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
        if (endMatch && endMatch[1] && currentStart !== null) {
          const endVal = parseFloat(endMatch[1]);
          if (endVal > currentStart) {
            rawSilences.push({
              start: Math.max(0, currentStart),
              end: Math.min(totalDuration, endVal),
            });
          }
          currentStart = null;
        }
      }

      // Handle unclosed trailing silence that extends to end of video
      if (currentStart !== null && currentStart < totalDuration) {
        rawSilences.push({
          start: currentStart,
          end: totalDuration,
        });
      }

      resolve();
    });
  });

  // Calculate Speech intervals (the inverse of silence)
  const speechIntervals: SpeechInterval[] = [];

  if (rawSilences.length === 0) {
    // No silence found; entire video is speech
    speechIntervals.push({ start: 0, end: totalDuration, duration: totalDuration });
  } else {
    let cursor = 0;

    for (const sil of rawSilences) {
      if (sil.start > cursor) {
        // Speech segment from cursor to sil.start with safety padding
        const segStart = cursor === 0 ? 0 : Math.max(0, cursor - padding);
        const segEnd = Math.min(totalDuration, sil.start + padding);

        if (segEnd - segStart >= 0.1) {
          speechIntervals.push({
            start: segStart,
            end: segEnd,
            duration: segEnd - segStart,
          });
        }
      }
      cursor = Math.max(cursor, sil.end);
    }

    // Trailing speech after last silence
    if (cursor < totalDuration) {
      const segStart = Math.max(0, cursor - padding);
      const segEnd = totalDuration;
      if (segEnd - segStart >= 0.1) {
        speechIntervals.push({
          start: segStart,
          end: segEnd,
          duration: segEnd - segStart,
        });
      }
    }
  }

  // Merge overlapping or touching speech intervals (caused by padding)
  const mergedSpeech: SpeechInterval[] = [];
  for (const interval of speechIntervals) {
    if (mergedSpeech.length === 0) {
      mergedSpeech.push(interval);
    } else {
      const last = mergedSpeech[mergedSpeech.length - 1]!;
      if (interval.start <= last.end + 0.05) {
        // Overlap or touch: merge
        last.end = Math.max(last.end, interval.end);
        last.duration = last.end - last.start;
      } else {
        mergedSpeech.push(interval);
      }
    }
  }

  // If all audio was cut (rare edge case), retain entire video to avoid destroying user media
  if (mergedSpeech.length === 0) {
    mergedSpeech.push({ start: 0, end: totalDuration, duration: totalDuration });
  }

  const estimatedDuration = mergedSpeech.reduce((sum, s) => sum + s.duration, 0);
  const savedDuration = Math.max(0, totalDuration - estimatedDuration);
  const savedPercent = totalDuration > 0 ? (savedDuration / totalDuration) * 100 : 0;
  const cutsCount = Math.max(0, mergedSpeech.length - 1);

  // Build timeline blocks (for UI visualization)
  const timelineBlocks: SilenceAnalysisResult["timelineBlocks"] = [];
  let tCursor = 0;

  for (const sp of mergedSpeech) {
    if (sp.start > tCursor + 0.01) {
      timelineBlocks.push({
        start: tCursor,
        end: sp.start,
        duration: sp.start - tCursor,
        type: "silence",
      });
    }
    timelineBlocks.push({
      start: sp.start,
      end: sp.end,
      duration: sp.duration,
      type: "speech",
    });
    tCursor = sp.end;
  }

  if (tCursor < totalDuration - 0.01) {
    timelineBlocks.push({
      start: tCursor,
      end: totalDuration,
      duration: totalDuration - tCursor,
      type: "silence",
    });
  }

  const silenceFormatted = rawSilences.map((s) => ({
    start: s.start,
    end: s.end,
    duration: s.end - s.start,
  }));

  return {
    totalDuration,
    hasAudio: probe.hasAudio,
    hasVideo: probe.hasVideo,
    originalDuration: totalDuration,
    estimatedDuration: Math.round(estimatedDuration * 100) / 100,
    savedDuration: Math.round(savedDuration * 100) / 100,
    savedPercent: Math.round(savedPercent * 10) / 10,
    cutsCount,
    silenceIntervals: silenceFormatted,
    speechIntervals: mergedSpeech,
    timelineBlocks,
  };
}

/**
 * Execute automated jump-cutting and Screen Studio framing/zoom in FFmpeg.
 */
export async function autoEditVideo(options: AutoEditOptions): Promise<void> {
  const { inputPath, outputPath, onProgress } = options;
  const framing = options.framing || {};
  const aspect = framing.aspect || "16:9";
  const zoom = Math.max(1.0, Math.min(2.0, framing.zoomFactor || 1.0));
  const backdrop = framing.backdrop || "none";
  const paddingPct = Math.max(0, Math.min(20, framing.paddingPercent ?? (backdrop !== "none" ? 6 : 0)));
  const focus = framing.focusRegion || "center";

  const probe = await probeMedia(inputPath);
  let intervals = options.speechIntervals;

  if (!intervals) {
    const analysis = await detectSilenceIntervals(inputPath, options.silenceOptions);
    intervals = analysis.speechIntervals;
  }

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Canvas dimensions based on target aspect
  let targetW = 1920;
  let targetH = 1080;
  if (aspect === "9:16") {
    targetW = 1080;
    targetH = 1920;
  } else if (aspect === "1:1") {
    targetW = 1080;
    targetH = 1080;
  }

  // Build filter graph
  const filterLines: string[] = [];
  const hasAudio = probe.hasAudio;
  const numSegments = intervals.length;

  // 1. Jump-Cut Trim & Concat
  let activeVideoTag = "0:v";
  let activeAudioTag = hasAudio ? "0:a" : "";

  if (numSegments > 1) {
    const concatPads: string[] = [];

    intervals.forEach((seg, idx) => {
      const s = seg.start.toFixed(3);
      const e = seg.end.toFixed(3);

      filterLines.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${idx}];`);
      concatPads.push(`[v${idx}]`);

      if (hasAudio) {
        filterLines.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${idx}];`);
        concatPads.push(`[a${idx}]`);
      }
    });

    if (hasAudio) {
      filterLines.push(`${concatPads.join("")}concat=n=${numSegments}:v=1:a=1[vcut][acut];`);
      activeVideoTag = "vcut";
      activeAudioTag = "acut";
    } else {
      filterLines.push(`${concatPads.join("")}concat=n=${numSegments}:v=1:a=0[vcut];`);
      activeVideoTag = "vcut";
    }
  } else if (hasAudio) {
    // Single segment pass-through for audio in filter graph
    filterLines.push(`[0:a]anull[acut];`);
    activeAudioTag = "acut";
  }

  // 2. Smart Zoom & Crop calculation
  let zoomFilter = "";
  if (zoom > 1.01) {
    let cropX = "(in_w-out_w)/2";
    let cropY = "(in_h-out_h)/2";

    if (focus === "top_left") {
      cropX = "0";
      cropY = "0";
    } else if (focus === "top_right") {
      cropX = "in_w-out_w";
      cropY = "0";
    } else if (focus === "bottom_left") {
      cropX = "0";
      cropY = "in_h-out_h";
    } else if (focus === "bottom_right") {
      cropX = "in_w-out_w";
      cropY = "in_h-out_h";
    }

    zoomFilter = `crop=w='in_w/${zoom}':h='in_h/${zoom}':x='${cropX}':y='${cropY}',scale=${probe.width}:${probe.height},`;
  }

  // 3. Framing & Backdrop
  let finalVideoTag = activeVideoTag;

  if (backdrop !== "none" || aspect !== "16:9") {
    // (The backdrop colour is chosen once, below, where the lavfi canvas is
    // actually built — this block used to duplicate it into a dead variable.)

    // Scaled screen size inside backdrop canvas
    const margin = paddingPct / 100;
    const availW = Math.round(targetW * (1 - margin * 2));
    const availH = Math.round(targetH * (1 - margin * 2));

    filterLines.push(`[${activeVideoTag}]${zoomFilter}scale=${availW}:${availH}:force_original_aspect_ratio=decrease[screen_scaled];`);
    filterLines.push(`[1:v][screen_scaled]overlay=(W-w)/2:(H-h)/2[framed];`);
    finalVideoTag = "framed";
  } else if (zoomFilter) {
    filterLines.push(`[${activeVideoTag}]${zoomFilter.slice(0, -1)}[zoomed];`);
    finalVideoTag = "zoomed";
  }

  // Clean trailing semicolons
  let fullScript = filterLines.join("\n").trim();
  if (fullScript.endsWith(";")) {
    fullScript = fullScript.slice(0, -1);
  }

  // Write filter script to temporary file to avoid OS command-line buffer limits
  const scriptFile = path.join(os.tmpdir(), `soundwave_edit_${crypto.randomUUID()}.txt`);
  fs.writeFileSync(scriptFile, fullScript, "utf-8");

  const totalEditDuration = intervals.reduce((acc, i) => acc + i.duration, 0);

  const ffmpeg = resolveFfmpegPath();
  const args = ["-y", "-i", inputPath];

  if (backdrop !== "none" || aspect !== "16:9") {
    let bgColor = "0x0B1120";
    if (backdrop === "gradient_purple") bgColor = "0x180B26";
    if (backdrop === "midnight") bgColor = "0x05070E";
    // Add backdrop canvas input
    args.push("-f", "lavfi", "-i", `color=c=${bgColor}:size=${targetW}x${targetH}:rate=30`);
  }

  if (fullScript.length > 0) {
    args.push("-filter_complex_script", scriptFile);
    args.push("-map", `[${finalVideoTag}]`);
    if (hasAudio) {
      args.push("-map", activeAudioTag ? `[${activeAudioTag}]` : "0:a");
    }
  } else {
    // Direct pass-through
    args.push("-map", "0:v");
    if (hasAudio) args.push("-map", "0:a");
  }

  args.push("-c:v", "libx264", "-preset", framing.quality === "high" ? "medium" : "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");

  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k");
  }

  args.push("-shortest", outputPath);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;

        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
        if (timeMatch && totalEditDuration > 0 && onProgress) {
          const hours = parseInt(timeMatch[1]!, 10);
          const mins = parseInt(timeMatch[2]!, 10);
          const secs = parseFloat(timeMatch[3]!);
          const currentSec = hours * 3600 + mins * 60 + secs;
          const pct = Math.min(99, Math.round((currentSec / totalEditDuration) * 100));
          onProgress(pct);
        }
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          onProgress?.(100);
          resolve();
        } else {
          reject(new Error(`FFmpeg auto-editing failed (code ${code}): ${stderr.slice(-400)}`));
        }
      });
    });
  } finally {
    try {
      if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile);
    } catch {
      // ignore tmp cleanup error
    }
  }
}
