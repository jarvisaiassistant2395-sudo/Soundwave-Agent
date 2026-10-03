// ── Shorts cut out of a long video ──────────────────────────────────────────
// "Make shorts from this video: <link>" — the agent downloads the video (or
// takes a file already on the PC), listens to it, picks the moments worth
// clipping (Gemini when there's a key, the loudest talking otherwise), and
// renders each one as a vertical short with burned captions of what is said,
// keeping the original audio. Each clip is a normal export job, so the Command
// Center and the phone show it, play it and download it like any other short.
//
// The thinking (window planning, scoring, picking, caption timing) is in
// brain/core/clips.ts — pure and unit-tested. This file is the ffmpeg/whisper
// plumbing around it.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { config } from "../config.js";
import { getStore } from "./store.js";
import { appendToConversation } from "./conversation.js";
import { newMessageId, chatTime } from "./chatMessages.js";
import { emitJob } from "../routes/export.js";
import { isReadableMediaFile } from "./mediaFile.js";
import { fetchMetadata, parseYouTubeUrl } from "./ytdlp.js";
import { importYouTubeLink } from "./youtubeImport.js";
import { probeMedia, resolveFfmpegPath, runFfmpegExport, type ExportSettings, type SubtitleStyleInput } from "./ffmpeg.js";
import { STT_SAMPLE_RATE, analyzePcm, encodeWav, transcribe } from "./stt.js";
import {
  DEFAULT_CLIPS,
  MAX_CLIPS,
  MAX_PICK_TRANSCRIPTS,
  buildPickerAsk,
  captionCues,
  clipFileName,
  clock,
  clockRange,
  fallbackPicks,
  inVideoOrder,
  parsePickerReply,
  planWindows,
  rankWindows,
  windowScore,
  withoutOverlaps,
  type ClipPick,
  type VideoWindow,
} from "./brain/core/clips.js";
import { activeBrain, FALLBACK_MODEL } from "./brain/settings.js";
import { GeminiError, generateContent, isGemini3, visibleText } from "./brain/gemini.js";

/** The caption look for clipped shorts: white, bold, stroked, middle of the frame. */
const CLIP_SUBTITLE_STYLE: SubtitleStyleInput = {
  fontFamily: "DejaVu Sans",
  fontWeight: 800,
  fontSize: 56,
  color: "#FFFFFF",
  bgColor: "#000000",
  bgOpacity: 0,
  bgPadding: 14,
  bgRadius: 10,
  vAlign: "middle",
  hAlign: "center",
  strokeEnabled: true,
  strokeColor: "#000000",
  strokeWidth: 4,
  shadowEnabled: true,
  shadowColor: "#000000",
  shadowBlur: 4,
  shadowX: 2,
  shadowY: 2,
};

export interface ClipsOptions {
  /** A YouTube link, or the path of a video already on this PC. */
  video: string;
  count?: number;
  /** What the person wants clipped out of it ("the funny bits", "the part about pricing"). */
  focus?: string;
  resolution?: "720p" | "1080p";
  userId?: string;
}

export interface ClipsStarted {
  jobIds: string[];
  sourceName: string;
  count: number;
}

interface Source {
  /** YouTube link (to download) or a file on this PC. */
  kind: "youtube" | "file";
  url: string;
  name: string;
  duration: number;
  filePath: string | null;
}

/** Rendering is one at a time on the person's machine — clips and shorts share that. */
let active: { source: string } | null = null;

export function clipsBusy(): { busy: boolean; source?: string } {
  return active ? { busy: true, source: active.source } : { busy: false };
}

/** Only used by the tests when a run is abandoned mid-way. */
export function _resetClipsForTests(): void {
  active = null;
}

/** ffmpeg with the args given; stdout only when it's asked for. */
function runFfmpeg(args: string[], opts: { collectStdout?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), ["-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["ignore", opts.collectStdout ? "pipe" : "ignore", "pipe"],
    });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(stderr.trim().slice(-400) || `ffmpeg exited with code ${code}`));
    });
  });
}

function toPcm(raw: Buffer): Int16Array {
  const samples = Math.floor(raw.length / 2);
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = raw.readInt16LE(i * 2);
  return pcm;
}

/** The whole video's sound as 16 kHz mono PCM, for the loudness profile. */
async function extractPcm(filePath: string, duration: number): Promise<Int16Array> {
  const maxSeconds = Math.min(Math.max(1, duration), 4 * 3600); // never read forever
  const raw = await runFfmpeg(["-t", String(maxSeconds), "-i", filePath, "-vn", "-ac", "1", "-ar", String(STT_SAMPLE_RATE), "-f", "s16le", "pipe:1"], {
    collectStdout: true,
  });
  return toPcm(raw);
}

function pcmSlice(pcm: Int16Array, startSec: number, endSec: number): Int16Array {
  const from = Math.max(0, Math.floor(startSec * STT_SAMPLE_RATE));
  const to = Math.min(pcm.length, Math.ceil(endSec * STT_SAMPLE_RATE));
  return pcm.subarray(from, Math.max(from, to));
}

/** What is said in a stretch of sound ("" when nothing, or nothing to listen with). */
async function listen(pcm: Int16Array, startSec: number, endSec: number): Promise<string> {
  const slice = pcmSlice(pcm, startSec, endSec);
  if (!slice.length) return "";
  const result = await transcribe(encodeWav(slice, STT_SAMPLE_RATE));
  return result.noSpeech ? "" : result.text.trim();
}

/** True when a speech engine and a model are actually there (the first window says so). */
async function speechAvailable(pcm: Int16Array): Promise<boolean> {
  try {
    await listen(pcm, 0, 1);
    return true;
  } catch {
    return false;
  }
}

/** Asks Gemini which windows to clip; the visible text of the answer, or "" when unusable. */
async function askPicker(windows: VideoWindow[], snippets: string[], count: number, focus?: string): Promise<string> {
  const brain = activeBrain();
  if (!brain) return "";
  const ask = buildPickerAsk(windows, snippets, count, focus);
  const models = [...new Set([brain.model, FALLBACK_MODEL])];
  for (const model of models) {
    try {
      const resp = await generateContent({
        apiKey: brain.apiKey,
        model,
        request: {
          contents: [{ role: "user", parts: [{ text: ask.user }] }],
          systemInstruction: { role: "user", parts: [{ text: ask.system }] },
          generationConfig: { maxOutputTokens: 2048, ...(isGemini3(model) ? { thinkingConfig: { thinkingLevel: "LOW" as const } } : {}) },
        } as never,
        timeoutMs: 45_000,
      });
      return visibleText(resp.candidates?.[0]?.content?.parts).trim();
    } catch (err) {
      const retryable = err instanceof GeminiError && (err.kind === "quota" || err.kind === "overloaded" || err.kind === "timeout");
      if (retryable && model !== models.at(-1)) continue;
      return ""; // no picker: the loudest windows still make good clips
    }
  }
  return "";
}

/**
 * Is this something we can work with? A YouTube link is only read up to its
 * details here (fast), so the person hears about a bad link right away; the
 * download itself happens in the background job.
 */
export async function checkSource(video: string): Promise<Source> {
  const wanted = (video ?? "").trim();
  if (!wanted) throw new Error("Tell me which video: paste a YouTube link, or the path of a video on this PC.");
  if (parseYouTubeUrl(wanted)) {
    const meta = await fetchMetadata(wanted);
    return { kind: "youtube", url: wanted, name: meta.title || "the video", duration: meta.duration ?? 0, filePath: null };
  }
  const local = path.resolve(wanted.replace(/^file:\/\//, ""));
  if (!fs.existsSync(local)) throw new Error(`There's no file at ${local}. Give me a YouTube link, or the path of a video on this PC.`);
  if (!isReadableMediaFile(local)) throw new Error(`${path.basename(local)} isn't a video file I can read.`);
  const probe = await probeMedia(local);
  if (!probe.hasVideo) throw new Error(`${path.basename(local)} has no video in it.`);
  return { kind: "file", url: local, name: path.basename(local), duration: probe.duration, filePath: local };
}

/** The real thing: download a link (or take the file as it is). */
async function fetchSource(source: Source, onProgress?: (s: string) => void): Promise<{ filePath: string; duration: number; name: string; url: string }> {
  if (source.kind === "file" && source.filePath) {
    return { filePath: source.filePath, duration: source.duration, name: source.name, url: source.url };
  }
  onProgress?.("Downloading the video…");
  const imported = await importYouTubeLink(source.url, {
    onProgress: (pct) => onProgress?.(`Downloading the video… ${Math.round(pct)}%`),
  });
  return { filePath: imported.filePath, duration: imported.duration || source.duration, name: imported.meta.title || source.name, url: imported.url };
}

interface ClipJob {
  id: string;
  report: (pct: number, step: string) => Promise<void>;
}

/**
 * One video → up to `count` vertical shorts with captions, delivered as export
 * jobs. Everything that happens is said in the chat: what it's listening to,
 * each clip when it's ready, and anything that went wrong.
 */
async function runClips(source: Source, jobIds: string[], count: number, focus: string | undefined, resolution: "720p" | "1080p", userId: string): Promise<void> {
  const store = await getStore();
  const dims = resolution === "1080p" ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
  const uploads = config.uploadsDir;
  const jobsDir = path.join(uploads, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const say = (text: string, extra: Record<string, unknown> = {}) => {
    const at = Date.now();
    appendToConversation({ id: newMessageId(at), sender: "assistant", text, time: chatTime(new Date(at)), at, tag: "SYS", ...extra });
  };

  const jobs: ClipJob[] = [];
  for (const id of jobIds) {
    const step = async (pct: number, text: string) => {
      const job = await store.getJob(id, userId);
      await store.updateJob(id, { progress: pct, settings: { ...((job?.settings as Record<string, unknown>) ?? {}), step: text } });
      emitJob(id, { progress: pct, step: text, status: "PROCESSING" });
    };
    jobs.push({ id, report: step });
  }
  const all = (pct: number, text: string) => Promise.all(jobs.map((j) => j.report(pct, text))).then(() => undefined);

  let filePath = "";
  try {
    const fetched = await fetchSource(source, (s) => void all(6, s));
    filePath = fetched.filePath;
    source = { ...source, duration: fetched.duration, name: fetched.name, url: fetched.url };
  } catch (err) {
    const message = (err as Error).message || "I couldn't download it.";
    await all(0, "Failed");
    for (const job of jobs) {
      await store.updateJob(job.id, { status: "FAILED", errorMessage: message.slice(0, 300), completedAt: new Date().toISOString() });
      emitJob(job.id, { status: "FAILED", error: message.slice(0, 300) });
    }
    say(`✂️ I couldn't get “${source.name}”: ${message}`);
    return;
  }

  const total = Math.max(0, Math.floor(source.duration));
  say(
    `✂️ Listening to “${source.name}” (${clock(total)}) for the ${count === 1 ? "best moment" : `${count} best moments`} — the clips will appear here as they're ready.`,
    { actionOutput: `From ${source.url}` },
  );

  const windows = planWindows(total);
  if (!windows.length) {
    await all(0, "Failed");
    for (const job of jobs) {
      await store.updateJob(job.id, { status: "FAILED", errorMessage: "The video is too short to clip.", completedAt: new Date().toISOString() });
      emitJob(job.id, { status: "FAILED", error: "The video is too short to clip." });
    }
    say(`✂️ “${source.name}” is too short to cut a clip out of.`);
    return;
  }

  await all(10, "Listening to the video…");
  let pcm: Int16Array;
  try {
    pcm = await extractPcm(filePath, total);
  } catch (err) {
    const message = `I couldn't read the sound of that video: ${(err as Error).message}`;
    await all(0, "Failed");
    for (const job of jobs) {
      await store.updateJob(job.id, { status: "FAILED", errorMessage: message.slice(0, 300), completedAt: new Date().toISOString() });
      emitJob(job.id, { status: "FAILED", error: message.slice(0, 300) });
    }
    say(`✂️ ${message}`);
    return;
  }

  const scores = windows.map((w) => windowScore(w, analyzePcm(pcmSlice(pcm, w.start, w.end))));
  const canListen = await speechAvailable(pcm);
  const ranked = rankWindows(windows, scores).slice(0, MAX_PICK_TRANSCRIPTS);
  const snippets: string[] = windows.map(() => "");
  for (let i = 0; i < ranked.length; i++) {
    const w = windows[ranked[i]!]!;
    await all(12 + Math.round((i / ranked.length) * 26), `Listening to the video… ${Math.round((i / ranked.length) * 100)}%`);
    if (!canListen) break;
    snippets[ranked[i]!] = await listen(pcm, w.start, w.end).catch(() => "");
  }

  // Which moments: the brain's picks, topped up with the loudest windows, then
  // in video order so the chat reads like the video does.
  await all(40, "Choosing the best moments…");
  const reply = await askPicker(windows, snippets, count, focus);
  const modelPicks: ClipPick[] = reply ? parsePickerReply(reply, total, count) : [];
  const finalPicks = inVideoOrder(withoutOverlaps([...modelPicks, ...fallbackPicks(windows, scores, total, count)], count));
  await all(44, `Cutting ${finalPicks.length === 1 ? "the clip" : `${finalPicks.length} clips`}…`);

  for (let i = 0; i < finalPicks.length; i++) {
    const pick = finalPicks[i]!;
    const job = jobs[i];
    if (!job) break;
    const length = Math.min(59, Math.max(12, pick.end - pick.start));
    const range = { start: pick.start, end: pick.start + length };
    const title = pick.title || `${source.name} — ${clock(pick.start)}`;
    const base = job.id;
    const videoOnly = path.join(jobsDir, `${base}_cut.mp4`);
    const audioOnly = path.join(jobsDir, `${base}_cut.m4a`);
    const outPath = path.join(uploads, clipFileName(i, pick.title, base));

    try {
      await store.updateJob(job.id, { settings: { topic: title, resolution: dims, range: clockRange(range), source: source.url, step: "Cutting the moment…" } as never });
      await job.report(50, "Cutting the moment…");
      await runFfmpeg(["-y", "-ss", pick.start.toFixed(3), "-t", length.toFixed(3), "-i", filePath, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", videoOnly]);
      await job.report(58, "Taking its sound…");
      await runFfmpeg(["-y", "-ss", pick.start.toFixed(3), "-t", length.toFixed(3), "-i", filePath, "-vn", "-c:a", "aac", "-b:a", "160k", audioOnly]);

      // Captions: what is said in this moment. Prefer a window already heard
      // that overlaps the clip; else listen to the clip's own sound.
      let said = snippets.find((text, index) => text && !(windows[index]!.end < range.start || windows[index]!.start > range.end)) ?? "";
      if (!said && canListen) {
        try {
          const raw = await runFfmpeg(["-y", "-i", audioOnly, "-ac", "1", "-ar", String(STT_SAMPLE_RATE), "-f", "s16le", "pipe:1"], { collectStdout: true });
          said = await listen(toPcm(raw), 0, length).catch(() => "");
        } catch {
          said = "";
        }
      }
      const cues = said ? captionCues(said, 0, length) : [];

      await job.report(64, cues.length ? "Burning the captions…" : "Rendering the clip…");
      const settings: ExportSettings = {
        resolution: dims,
        format: "mp4",
        quality: "low",
        fps: 30,
        watermark: false,
        audioVolume: 1,
        fadeIn: 0,
        fadeOut: 0.3,
        duration: length,
      };
      await runFfmpegExport({
        videoPath: videoOnly,
        audioPath: audioOnly,
        subtitles: cues,
        subtitleStyle: CLIP_SUBTITLE_STYLE,
        settings,
        outputPath: outPath,
        onProgress: (pct) => void job.report(Math.min(96, Math.max(64, Math.round(64 + pct * 0.32))), `Rendering the clip… ${Math.round(pct)}%`),
      });
      await job.report(97, "Saving the clip…");
      try {
        fs.copyFileSync(outPath, path.join(jobsDir, `${job.id}.mp4`));
      } catch {
        /* the download route also looks in uploads/ by name */
      }
      for (const temp of [videoOnly, audioOnly]) {
        try {
          fs.unlinkSync(temp);
        } catch {
          /* temp files */
        }
      }

      const outputUrl = `/api/v1/export/jobs/${job.id}/download`;
      await store.updateJob(job.id, { status: "COMPLETED", progress: 100, outputUrl, completedAt: new Date().toISOString() });
      emitJob(job.id, { status: "COMPLETED", progress: 100, url: outputUrl });
      // The clip is a normal export job with a real file, so the message says
      // where it is: the desktop chat plays it in line (the phone's Watch
      // button reads the job id). Without the URL the clip could only be read
      // about, never watched.
      say(`✂️ Clip ${i + 1} of ${finalPicks.length} — “${title}” (${clockRange(range)} of “${source.name}”)${pick.reason ? `\n${pick.reason}` : ""}`, {
        jobId: job.id,
        jobState: "done",
        topic: title,
        tag: "AUDIO",
        videoUrl: outputUrl,
        downloadUrl: outputUrl,
        actionOutput: `From ${source.url}\n${cues.length ? `Captions: ${cues.length} lines from what is said` : "No captions (no speech heard in this moment)"}`,
      });
    } catch (err) {
      const message = (err as Error).message || "unknown error";
      await store.updateJob(job.id, { status: "FAILED", errorMessage: message.slice(0, 300), completedAt: new Date().toISOString() });
      emitJob(job.id, { status: "FAILED", error: message.slice(0, 300) });
      say(`✂️ Clip ${i + 1} didn't render: ${message}`);
    }
  }

  if (finalPicks.length < jobs.length) {
    // A very short video can't fill every slot: the extra jobs mustn't spin forever.
    for (const job of jobs.slice(finalPicks.length)) {
      await store.updateJob(job.id, { status: "FAILED", progress: 0, errorMessage: "The video was too short for another clip.", completedAt: new Date().toISOString() });
      emitJob(job.id, { status: "FAILED", error: "The video was too short for another clip." });
    }
  }
}

/**
 * Starts the job in the background (the tool answers right away, like shorts
 * do). Throws for the things the person must hear immediately: a busy
 * renderer, or a source that can't be read at all.
 */
export async function startClipsJob(opts: ClipsOptions): Promise<ClipsStarted> {
  if (active) throw new Error(`I'm still working on “${active.source}” — one video at a time.`);
  const count = Math.max(1, Math.min(MAX_CLIPS, Math.round(opts.count ?? DEFAULT_CLIPS)));
  const source = await checkSource(opts.video);
  const resolution = opts.resolution === "1080p" ? "1080p" : "720p";
  const userId = opts.userId || "agent-local";

  const store = await getStore();
  const jobIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const job = await store.createJob({
      projectId: null,
      userId,
      status: "PROCESSING",
      progress: 4,
      settings: { topic: `${source.name} — clip ${i + 1}`, step: "Getting the video…", resolution: resolution === "1080p" ? { width: 1080, height: 1920 } : { width: 720, height: 1280 } } as never,
      outputUrl: null,
      errorMessage: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    });
    jobIds.push(job.id);
  }

  active = { source: source.name };
  void runClips(source, jobIds, count, opts.focus, resolution, userId)
    .catch((err) => console.error("[clips] failed:", (err as Error).message))
    .finally(() => {
      active = null;
    });

  return { jobIds, sourceName: source.name, count };
}
