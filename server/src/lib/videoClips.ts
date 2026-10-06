// ── Shorts cut out of a long video ──────────────────────────────────────────
// "Make shorts from this video: <link>" — the agent downloads the video (or
// takes a file already on the PC), listens to it, picks the moments worth
// clipping (Gemini when there's a key, the best-scoring talking otherwise), and
// renders each one as a vertical short with burned captions of what is said,
// keeping the original audio. Each clip is a normal export job, so the Command
// Center and the phone show it, play it and download it like any other short.
//
// The thinking (window planning, scoring, picking, caption timing, the queue's
// rules) is in brain/core/clips.ts and brain/core/clipQueue.ts — pure and
// unit-tested. This file is the ffmpeg/whisper plumbing around it, covered by
// tests/video_clips.test.ts with a stand-in ffmpeg.
//
// Three things this file is careful about, because each one used to go wrong
// quietly:
//
//  • Memory. A video's PCM is 32 kB per second, so the four hours this reads is
//    460 MB. It is streamed to a temporary file and profiled frame by frame on
//    the way past; windows are read back one at a time. Nothing the size of the
//    video is ever held in RAM.
//  • The speech engine is shared with the person's voice input, and the person
//    goes first (lib/stt.ts). Clip listening is therefore `background`, which
//    is *refused* rather than queued while anything else is waiting — so a
//    refusal is retried, never mistaken for "nothing was said".
//  • Silence and failure are different facts. A window the engine couldn't
//    handle is reported as that, to the person in the chat and to Gemini in the
//    picker's list, instead of both being flattened into "no speech heard".

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { config } from "../config.js";
import { getStore } from "./store.js";
import { appendToConversation } from "./conversation.js";
import { newMessageId, chatTime } from "./chatMessages.js";
import { emitJob } from "../routes/export.js";
import { isReadableMediaFile } from "./mediaFile.js";
import { fetchMetadata, fetchViewSignals, parseYouTubeUrl } from "./ytdlp.js";
import { importYouTubeLink } from "./youtubeImport.js";
import { probeMedia, resolveFfmpegPath, runFfmpegExport, type ExportSettings, type SubtitleStyleInput } from "./ffmpeg.js";
import { STT_SAMPLE_RATE, SttError, encodeWav, resolveWhisper, transcribe, whisperBudgetMs } from "./stt.js";
import {
  heatWindows,
  interestBrief,
  rankByInterest,
  snapToInterest,
  trendTerms,
  windowInterest,
  type ViewSignals,
} from "./brain/core/interest.js";
import { loadTrendDigest } from "./trends.js";
// What this channel's own posted clips did — the picker leans on results, not vibes.
import { audienceBrief } from "./postSchedule.js";
import {
  DEFAULT_CLIPS,
  MAX_CLIPS,
  MAX_CLIP_SECONDS,
  MAX_PICK_TRANSCRIPTS,
  MIN_CLIP_SECONDS,
  audioProfile,
  buildPickerAsk,
  captionCues,
  candidateWindows,
  clipFileName,
  mergeWindows,
  selectClips,
  trimOverlaps,
  clock,
  clockRange,
  createProfileAccumulator,
  inVideoOrder,
  momentFeatures,
  momentReason,
  momentScore,
  parsePickerReply,
  pickMoments,
  planWindows,
  rankWindows,
  snapToSpeech,
  speechRuns,
  withoutOverlaps,
  type AudioProfile,
  type ClipPick,
  type VideoWindow,
} from "./brain/core/clips.js";
import {
  MAX_WAITING,
  beginRun,
  busyText,
  emptyRunState,
  enqueue,
  finishRun,
  landingPosition,
  nextRunnable,
  orphanedJobs,
  parseRunState,
  queuedText,
  queueView,
  serializeRunState,
  type ClipsRunState,
  type QueuedClips,
} from "./brain/core/clipQueue.js";
import { activeBrain, FALLBACK_MODEL } from "./brain/settings.js";
import { GeminiError, generateContent, isGemini3, visibleText } from "./brain/gemini.js";
import { getActiveShortJobs } from "../routes/agentShort.js";

/** The caption look for clipped shorts: white, bold, stroked, middle of the frame. */
const CLIP_SUBTITLE_STYLE: SubtitleStyleInput = {
  // No fontFamily on purpose: buildAss draws captions in the font Soundwave
  // ships (lib/captionFont.ts) — asking for "DejaVu Sans" by name meant a font
  // this machine may not have (it does not, on Windows).
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

/** Never read more than this much of a video's sound, however long it runs. */
const MAX_PROFILE_HOURS = 4;
/** A refused listen (the person is talking) is retried this many times. */
const LISTEN_ATTEMPTS = 4;
/** How long the first retry waits; each later one waits proportionally longer. */
const LISTEN_BUSY_DELAY_MS = 1_500;
/** While anything waits in the queue, it's offered to the renderer this often. */
const PUMP_INTERVAL_MS = 5_000;

// Overridable for the tests, which would otherwise wait out real backoff delays
// to prove a busy engine is retried rather than mistaken for silence.
let listenAttempts = LISTEN_ATTEMPTS;
let listenBusyDelayMs = LISTEN_BUSY_DELAY_MS;

/** Only used by the tests. */
export function _setClipsListenTimingForTests(opts: { attempts?: number; busyDelayMs?: number }): void {
  if (opts.attempts !== undefined) listenAttempts = Math.max(1, opts.attempts);
  if (opts.busyDelayMs !== undefined) listenBusyDelayMs = Math.max(0, opts.busyDelayMs);
}

/** Only used by the tests: drain the queue now instead of waiting for the timer. */
export function _pumpClipsForTests(): Promise<void> {
  return pump();
}

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
  /** True when another video has the renderer: this one waits its turn. */
  queued: boolean;
  /** 0 = rendering now, 1 = next, 2 = behind one more, … */
  position: number;
  /** How many videos were already waiting when this one joined. */
  waitingAhead: number;
}

interface Source {
  /** YouTube link (to download) or a file on this PC. */
  kind: "youtube" | "file";
  url: string;
  name: string;
  duration: number;
  filePath: string | null;
}

// ── The queue, on disk ──────────────────────────────────────────────────────
// Kept in a file rather than only in memory so a clips run the app was in the
// middle of when it closed is still known about at startup: its jobs can be
// settled honestly (initClips) instead of showing as "processing" forever.

let mirror: ClipsRunState | null = null;
let mirrorFile = "";
let pumpTimer: NodeJS.Timeout | null = null;

function stateFile(): string {
  return path.join(config.dataDir, "clips-queue.json");
}

function loadRunState(): ClipsRunState {
  const file = stateFile();
  // The data dir moves between tests: a stale mirror would answer for the wrong one.
  if (mirror && mirrorFile === file) return mirror;
  try {
    mirror = parseRunState(fs.readFileSync(file, "utf8"));
  } catch {
    mirror = emptyRunState();
  }
  mirrorFile = file;
  return mirror;
}

function saveRunState(next: ClipsRunState): ClipsRunState {
  mirror = next;
  mirrorFile = stateFile();
  try {
    fs.mkdirSync(path.dirname(mirrorFile), { recursive: true });
    fs.writeFileSync(mirrorFile, serializeRunState(next), "utf8");
  } catch (err) {
    // The queue still works from memory; only a crash would lose it.
    console.warn(`[clips] could not save the queue: ${(err as Error).message}`);
  }
  schedulePump();
  return next;
}

/** May a render begin? Clips and ordinary shorts share this PC's one renderer. */
function rendererFree(): boolean {
  return !loadRunState().active && getActiveShortJobs().length === 0;
}

/**
 * What's being cut, and what's waiting behind it. Synchronous and cheap (an
 * in-memory mirror of a small file), because the UI card polls it and the tools
 * ask before they speak.
 */
export function clipsBusy(): { busy: boolean; source?: string; queued?: number; waitingFor?: string[] } {
  const view = queueView(loadRunState());
  return {
    busy: view.busy,
    ...(view.source ? { source: view.source } : {}),
    ...(view.queued ? { queued: view.queued, waitingFor: view.waitingFor } : {}),
  };
}

/** The queue as the Command Center's card shows it. */
export function clipsQueueView() {
  return queueView(loadRunState());
}

/** Only used by the tests, and after a run is abandoned mid-way. */
export function _resetClipsForTests(): void {
  mirror = null;
  mirrorFile = "";
  if (pumpTimer) {
    clearInterval(pumpTimer);
    pumpTimer = null;
  }
  pumping = false;
  try {
    fs.rmSync(stateFile(), { force: true });
  } catch {
    /* nothing on disk */
  }
}

// ── The video's sound: streamed to disk, profiled on the way past ───────────

export interface PcmStore {
  /** The energy profile, built frame by frame as the sound arrived. */
  profile: AudioProfile;
  /** Samples written. */
  samples: number;
  /** One window's sound, read back from disk — never the whole video in RAM. */
  slice(startSec: number, endSec: number): Int16Array;
  /** Close the file and delete it. Safe to call twice. */
  dispose(): void;
}

const EMPTY = Buffer.alloc(0);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Deletes a temporary file, retrying a few times off the hot path. On Windows a
 * name can stay listed for a moment after the file itself is gone — a handle
 * that is still open, or a virus scanner reading the file mid-write — and these
 * retries make sure a temporary file cannot outlive the request. Never throws:
 * a leftover temp file must not turn into a failed render.
 */
function deleteTemp(file: string, tries = 4): void {
  try {
    fs.unlinkSync(file);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || tries <= 0) return;
  }
  setTimeout(() => deleteTemp(file, tries - 1), 120).unref();
}

/** Ends a write stream if needed and resolves once its handle is really closed. */
function closeWriteStream(stream: fs.WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", () => resolve());
    stream.destroy();
  });
}

/**
 * Decodes the whole video's sound to 16 kHz mono PCM, writing it to a temporary
 * file and computing the energy profile as it streams past.
 *
 * This replaced holding the PCM in memory: a one-hour video is 115 MB of it,
 * and the old path briefly held three copies (the pipe's chunks, their
 * concatenation, and the Int16Array made from it) — over a gigabyte for a long
 * video, on a machine that is also running an ffmpeg render. Now peak memory is
 * one pipe buffer, and a window is read back from disk when it's needed.
 */
export async function extractPcm(filePath: string, durationSec: number): Promise<PcmStore> {
  const maxSeconds = Math.min(Math.max(1, durationSec), MAX_PROFILE_HOURS * 3600);
  const dir = path.join(config.uploadsDir, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  const pcmPath = path.join(dir, `clips_pcm_${process.pid}_${crypto.randomBytes(6).toString("hex")}.s16le`);

  const accumulator = createProfileAccumulator(STT_SAMPLE_RATE);
  const out = fs.createWriteStream(pcmPath);
  let writeError: Error | null = null;
  out.on("error", (err) => {
    writeError = err;
  });

  let samples = 0;
  let leftover: Buffer = EMPTY;

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        resolveFfmpegPath(),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-t",
          String(maxSeconds),
          "-i",
          filePath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          String(STT_SAMPLE_RATE),
          "-f",
          "s16le",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      child.stderr?.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (writeError) return;
        // A pipe chunk can end half-way through a 16-bit sample: carry the odd
        // byte over rather than shifting every frame after it by half a sample.
        const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
        leftover = buf.length % 2 ? buf.subarray(buf.length - 1) : EMPTY;
        const even = leftover.length ? buf.subarray(0, buf.length - 1) : buf;
        if (!even.length) return;
        accumulator.push(new Int16Array(even.buffer, even.byteOffset, even.length / 2));
        samples += even.length / 2;
        // Backpressure: without this the disk write queues up in memory and
        // the whole point of streaming is lost.
        if (!out.write(even)) {
          child.stdout?.pause();
          out.once("drain", () => child.stdout?.resume());
        }
      });
      child.on("error", (err) => done(() => reject(new Error(`ffmpeg couldn't start: ${err.message}`))));
      child.on("close", (code) => {
        done(() => {
          out.end(() => {
            const settle = () => {
              if (writeError) reject(writeError);
              else if (code === 0) resolve();
              else reject(new Error(stderr.trim().slice(-400) || `ffmpeg exited with code ${code}`));
            };
            // "finish" means the bytes reached the OS, not that the handle is
            // gone. Windows keeps a deleted-but-open file listed in the folder
            // until it closes, and the caller may dispose() the moment this
            // promise settles — so wait for the stream's own close.
            if (out.closed) settle();
            else out.once("close", settle);
          });
        });
      });
    });
  } catch (err) {
    // Close the write handle first: a Windows file with an open handle cannot
    // be removed from its folder yet, and this temp file must not survive a
    // failure the caller is being told about.
    await closeWriteStream(out);
    deleteTemp(pcmPath);
    throw err;
  }

  const fd = fs.openSync(pcmPath, "r");
  let closed = false;
  return {
    profile: accumulator.finish(),
    samples,
    slice(startSec, endSec) {
      const from = Math.max(0, Math.min(samples, Math.floor(Math.max(0, startSec) * STT_SAMPLE_RATE)));
      const to = Math.max(from, Math.min(samples, Math.ceil(Math.max(0, endSec) * STT_SAMPLE_RATE)));
      const bytes = (to - from) * 2;
      if (!bytes || closed) return new Int16Array(0);
      const buf = Buffer.allocUnsafe(bytes);
      let read = 0;
      while (read < bytes) {
        let n = 0;
        try {
          n = fs.readSync(fd, buf, read, bytes - read, from * 2 + read);
        } catch {
          break;
        }
        if (n <= 0) break;
        read += n;
      }
      return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(read / 2));
    },
    dispose() {
      if (closed) return;
      closed = true;
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      deleteTemp(pcmPath);
    },
  };
}

// ── Listening: one window at a time, the person's voice first ───────────────

/**
 * What listening to a window produced. `silent` and `failed` are kept apart on
 * purpose: the first means nobody was talking (a reason to skip that moment,
 * and an honest "no captions"), the second means the engine couldn't tell us
 * (not a reason to skip it, and a different thing to say out loud).
 */
export type ListenOutcome = { kind: "said"; text: string } | { kind: "silent" } | { kind: "failed"; reason: string };

/**
 * What is said in one window of the video's sound.
 *
 * `background: true` keeps the person's voice input ahead of this, which means
 * the call is *refused* — not queued — whenever anything else is waiting on the
 * engine. A refusal is therefore retried with a growing wait, and only becomes
 * `failed` once the attempts run out. Treating it as "nothing was said" (what
 * `.catch(() => "")` used to do) produced clips with no captions and a chat
 * that said the moment was silent.
 */
async function listen(store: PcmStore, startSec: number, endSec: number): Promise<ListenOutcome> {
  const slice = store.slice(startSec, endSec);
  if (!slice.length) return { kind: "silent" };
  // The budget follows the audio's own length: a 59-second window on a slow
  // CPU is not the same proposition as a five-second voice command, and killing
  // it at the interactive 90 s cap lost the captions.
  const budgetMs = whisperBudgetMs(Math.max(1, endSec - startSec));
  let busyReason = "";
  for (let attempt = 0; attempt < listenAttempts; attempt++) {
    if (attempt) await sleep(listenBusyDelayMs * attempt);
    try {
      const result = await transcribe(encodeWav(slice, STT_SAMPLE_RATE), { background: true, timeoutMs: budgetMs });
      const text = result.text.trim();
      return text ? { kind: "said", text } : { kind: "silent" };
    } catch (err) {
      if (err instanceof SttError && err.code === "STT_BUSY") {
        busyReason = err.message || "the speech engine was busy with something you asked for";
        continue; // the person is talking: yield, then try again
      }
      const reason = err instanceof Error ? err.message : "the speech engine stopped";
      return { kind: "failed", reason };
    }
  }
  return { kind: "failed", reason: busyReason || "the speech engine stayed busy with your voice input" };
}

/** Is there a speech engine on this PC at all? Free to ask, unlike transcribing. */
function speechEngine(): { available: boolean; problem: string | null } {
  const { setup, problem } = resolveWhisper();
  return { available: Boolean(setup), problem };
}

/** What the chat says about a clip's captions — the real reason, not a guess. */
function captionNote(
  cues: number,
  heard: ListenOutcome,
  opts: { canListen: boolean; fellBack: boolean },
): string {
  if (cues > 0) {
    return opts.fellBack
      ? `Captions: ${cues} lines borrowed from a neighbouring window (this clip's own sound couldn't be listened to — ${heard.kind === "failed" ? heard.reason : "the speech engine was unavailable"})`
      : `Captions: ${cues} lines from what is said`;
  }
  if (!opts.canListen) return "No captions (there's no speech engine on this PC to listen with)";
  if (heard.kind === "failed") return `No captions — ${heard.reason}, so there was nothing to burn in`;
  return "No captions (no speech heard in this moment)";
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

/**
 * Asks Gemini which moments to clip — one call per video, and only when a key
 * is configured (the local scoring below picks perfectly usable clips without
 * it). The windows it sees already start and end at speech boundaries.
 *
 * `snippets[i]` is what was said, `""` when the window was listened to and
 * nothing was said, and `null` when it couldn't be listened to — see
 * buildPickerAsk, which tells the model those two apart.
 */
async function askPicker(
  windows: VideoWindow[],
  snippets: Array<string | null>,
  count: number,
  focus?: string,
  evidence?: Array<string[] | undefined>,
): Promise<string> {
  const brain = activeBrain();
  if (!brain) return "";
  const ask = buildPickerAsk(windows, snippets, count, focus, evidence, audienceBrief());
  const models = [...new Set([brain.model, FALLBACK_MODEL])];
  for (const model of models) {
    try {
      const resp = await generateContent({
        purpose: "clips",
        // Re-clipping the same video with the same moments heard asks the same
        // question — the answer is reusable.
        cache: true,
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
      return ""; // no picker: the best-scoring moments still make good clips
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

/** Windows and picks are matched by where they start and end. */
function interestKey(window: { start: number; end: number }): string {
  return `${window.start.toFixed(2)}–${window.end.toFixed(2)}`;
}

/** The saved trend digest, or nothing: a missing/corrupt file must never stop a clip job. */
function safeTrendDigest(): ReturnType<typeof loadTrendDigest> {
  try {
    return loadTrendDigest();
  } catch (err) {
    console.warn(`[clips] trend digest unreadable: ${(err as Error).message}`);
    return null;
  }
}

/** Fails every job in a run with one message, and says so in the chat. */
async function failRun(jobs: ClipJob[], store: Awaited<ReturnType<typeof getStore>>, message: string, say: (text: string, extra?: Record<string, unknown>) => void): Promise<void> {
  const trimmed = message.slice(0, 300);
  await Promise.all(jobs.map((j) => j.report(0, "Failed")));
  for (const job of jobs) {
    await store.updateJob(job.id, { status: "FAILED", errorMessage: trimmed, completedAt: new Date().toISOString() });
    emitJob(job.id, { status: "FAILED", error: trimmed });
  }
  say(`✂️ ${trimmed}`);
}

/**
 * One video → up to `count` vertical shorts with captions, delivered as export
 * jobs. Everything that happens is said in the chat: what it's listening to,
 * what it could and couldn't hear, each clip when it's ready, and anything that
 * went wrong.
 */
async function runClips(run: QueuedClips): Promise<void> {
  const store = await getStore();
  const dims = run.resolution === "1080p" ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
  const uploads = config.uploadsDir;
  const jobsDir = path.join(uploads, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const count = run.count;

  const say = (text: string, extra: Record<string, unknown> = {}) => {
    const at = Date.now();
    appendToConversation({ id: newMessageId(at), sender: "assistant", text, time: chatTime(new Date(at)), at, tag: "SYS", ...extra });
  };

  const jobs: ClipJob[] = run.jobIds.map((id) => ({
    id,
    report: async (pct: number, text: string) => {
      const job = await store.getJob(id, run.userId);
      await store.updateJob(id, { progress: pct, settings: { ...((job?.settings as Record<string, unknown>) ?? {}), step: text } });
      emitJob(id, { progress: pct, step: text, status: "PROCESSING" });
    },
  }));
  const all = (pct: number, text: string) => Promise.all(jobs.map((j) => j.report(pct, text))).then(() => undefined);

  // A queued run's jobs were created as QUEUED: they render now, so say so.
  for (const job of jobs) {
    const existing = await store.getJobById(job.id);
    if (existing && existing.status === "QUEUED") {
      await store.updateJob(job.id, { status: "PROCESSING", progress: 4, startedAt: new Date().toISOString() });
      emitJob(job.id, { status: "PROCESSING", progress: 4 });
    }
  }

  let source: Source;
  try {
    // Re-checked rather than trusted from when it was queued: a queued video can
    // wait a while, and a link that went private should fail honestly here.
    source = await checkSource(run.video);
  } catch (err) {
    await failRun(jobs, store, (err as Error).message || "I couldn't read that video.", say);
    return;
  }

  let filePath = "";
  try {
    const fetched = await fetchSource(source, (s) => void all(6, s));
    filePath = fetched.filePath;
    source = { ...source, duration: fetched.duration, name: fetched.name, url: fetched.url };
  } catch (err) {
    await failRun(jobs, store, `I couldn't get “${source.name}”: ${(err as Error).message || "the download failed."}`, say);
    return;
  }

  const total = Math.max(0, Math.floor(source.duration));
  say(
    `✂️ Listening to “${source.name}” (${clock(total)}) for the ${count === 1 ? "best moment" : `${count} best moments`} — the clips will appear here as they're ready.`,
    { actionOutput: `From ${source.url}` },
  );

  if (total < MIN_CLIP_SECONDS) {
    await failRun(jobs, store, `“${source.name}” is too short to cut a clip out of.`, say);
    return;
  }

  await all(10, "Listening to the video…");

  // ── What the audience actually did (measured, not guessed) ────────────────
  // Started now and collected after the sound has been profiled, so the
  // YouTube round trips overlap the PCM pass instead of adding to it. Three
  // real signals, all best-effort:
  //   • YouTube's own most-replayed curve (yt-dlp's `heatmap`) — where viewers
  //     rewound, i.e. the parts they care about;
  //   • the top comments that name a timecode ("2:14 had me crying");
  //   • this week's trending terms, from the digest the trend scout already
  //     saved (real view counts of popular Shorts), matched against the words.
  // A video with none of this clips exactly as it did before.
  const digest = safeTrendDigest();
  const trends = digest?.top?.length ? trendTerms(digest.top, { max: 8 }) : [];
  const signalsPromise: Promise<ViewSignals | null> =
    source.kind === "youtube"
      ? fetchViewSignals(source.url, {
          // The comments pass is slower and needs a second extraction; worth it
          // for a video people actually commented on, and the function itself
          // skips it when the count is trivial.
          comments: true,
          timeoutMs: Math.min(config.ytDlpTimeoutMs, 60_000),
          onProgress: (note) => void all(11, note),
        }).catch((err: unknown) => {
          console.warn(`[clips] view signals for ${source.url} failed: ${(err as Error).message}`);
          return null;
        })
      : Promise.resolve(null);

  // Where the moments are: read the whole video's sound once — streamed to disk
  // and profiled on the way past, never held in memory — find the places
  // someone talks (opening on an onset, closing on a pause, not on a grid
  // line), and score them. A video nobody talks in falls back to the grid.
  let pcm: PcmStore;
  try {
    pcm = await extractPcm(filePath, total);
  } catch (err) {
    await failRun(jobs, store, `I couldn't read the sound of that video: ${(err as Error).message}`, say);
    return;
  }

  const measured = await signalsPromise;
  const viewSignals: ViewSignals | null =
    measured || trends.length
      ? { heat: measured?.heat ?? [], anchors: measured?.anchors ?? [], trends, stats: measured?.stats ?? {}, chapters: measured?.chapters, notes: measured?.notes }
      : null;
  for (const line of interestBrief(viewSignals).slice(0, 4)) say(`✂️ ${line}`);

  try {
    const profile = pcm.profile;
    const runs = speechRuns(profile);
    const fromSpeech = candidateWindows(runs, total);
    // The audience's own peaks are candidates too, even when nobody talks over
    // them: the heat map is the only signal that points at a moment the audio
    // never would have nominated (a visual reveal, a silent reaction).
    const fromHeat = viewSignals ? heatWindows(viewSignals.heat, total) : [];
    const fallback = fromSpeech.length || fromHeat.length ? [] : planWindows(total);
    const windows = mergeWindows([...fromSpeech, ...fromHeat, ...fallback], total);
    let scores = windows.map((w) => momentScore(momentFeatures(w, profile)));
    // Measured interest per window, from the audience's data alone (the words
    // are not heard yet, so trend matching happens again once they are).
    const measuredInterest = windows.map((w) => (viewSignals ? windowInterest(w, { signals: viewSignals }).score : 0));
    /**
     * One number to rank a moment by: the better of what the sound and words
     * say, and what the audience measurably did — with the measurement allowed
     * to win outright. A replay peak nobody talks over still becomes a clip
     * (that is what the audience asked for), and a strong talking hook is never
     * dragged down by a mediocre heat value. With no measured data this is
     * exactly the score it always was.
     */
    const combinedRank = (i: number) => Math.min(1, Math.max(scores[i]!, 1.05 * (measuredInterest[i] ?? 0)));
    const listenRank = combinedRank;
    const listening = Math.min(windows.length, MAX_PICK_TRANSCRIPTS);
    say(
      fromSpeech.length
        ? `✂️ Found ${windows.length} moment${windows.length === 1 ? "" : "s"} worth checking in “${source.name}”${fromHeat.length ? ` (${fromHeat.length} of them from YouTube's own most-replayed data)` : ""} — listening to the most promising ${listening}.`
        : fromHeat.length
          ? `✂️ No speech stood out in “${source.name}”, but YouTube's own replay data marks ${fromHeat.length} moment${fromHeat.length === 1 ? "" : "s"} people rewound — starting there.`
          : `✂️ No speech stood out in “${source.name}” — searching ${windows.length} even window${windows.length === 1 ? "" : "s"}.`,
      {
        actionOutput: fromHeat.length
          ? "Candidate moments come from the sound and from YouTube's most-replayed curve"
          : fromSpeech.length
            ? "Cut points follow speech, not a fixed grid"
            : "No speech measured — the search falls back to even windows",
      },
    );

    const engine = speechEngine();
    const canListen = engine.available;
    if (!canListen) {
      say(`✂️ There's no speech engine on this PC${engine.problem ? ` (${engine.problem})` : ""} — picking on the sound alone, and the clips will have no captions.`, {
        actionOutput: "Voice input isn't set up, so nothing can be listened to",
      });
    }

    // `null` = couldn't be listened to, "" = listened to and nothing was said.
    // The difference matters: the first is not a reason to skip a moment, and
    // the picker and the chat are both told which happened.
    const snippets: Array<string | null> = windows.map(() => null);
    let unheard = 0;
    let unheardWhy = "";
    if (canListen) {
      const ranked = [...windows.keys()].sort((a, b) => listenRank(b) - listenRank(a)).slice(0, MAX_PICK_TRANSCRIPTS);
      for (let i = 0; i < ranked.length; i++) {
        const index = ranked[i]!;
        const w = windows[index]!;
        await all(12 + Math.round((i / ranked.length) * 26), `Listening to the video… ${Math.round((i / ranked.length) * 100)}%`);
        const heard = await listen(pcm, w.start, w.end);
        if (heard.kind === "said") snippets[index] = heard.text;
        else if (heard.kind === "silent") snippets[index] = "";
        else {
          unheard++;
          unheardWhy = heard.reason;
        }
      }
      if (unheard) {
        say(
          `✂️ Couldn't listen to ${unheard} of the ${listening} most promising moment${unheard === 1 ? "" : "s"} (${unheardWhy}) — picking from what was heard, and from the sound of the rest.`,
          { actionOutput: "Those moments are marked as unheard, not as silent" },
        );
      }
    }

    // What was heard changes the ranking: words can lift a moment past a loud
    // patch of nothing-saying, and filler drops it back.
    const features = windows.map((w, i) => momentFeatures(w, profile, snippets[i] ?? undefined));
    scores = windows.map((w, i) => (snippets[i] ? momentScore(features[i]!) : scores[i]!));

    // Which moments: the brain's picks (snapped onto the same speech
    // boundaries), topped up with the best-scoring moments, then in video order
    // so the chat reads like the video does.
    await all(40, "Choosing the best moments…");
    // The measured evidence goes to the picker with the windows, so it can
    // choose *and* say which real signal it used.
    const windowEvidence = windows.map((w, i) =>
      viewSignals ? windowInterest(w, { signals: viewSignals, text: snippets[i] ?? undefined }).evidence : undefined,
    );
    const reply = await askPicker(windows, snippets, count, run.focus, windowEvidence);
    const modelPicks: ClipPick[] = (reply ? parsePickerReply(reply, total, count) : []).map((pick) => {
      const snapped = snapToSpeech(pick, runs, 2.5, total);
      return { ...pick, start: snapped.start, end: snapped.end };
    });
    // Measured interest, recomputed now that the words are known — this is the
    // version that counts for ranking, because it can match trending terms.
    const interestOf = new Map<string, { score: number; evidence: string[] }>();
    for (const [i, w] of windows.entries()) {
      if (!viewSignals) break;
      const { score, evidence } = windowInterest(w, { signals: viewSignals, text: snippets[i] ?? undefined });
      interestOf.set(interestKey(w), { score, evidence });
    }
    /**
     * The measured interest behind a pick. Model picks are snapped onto speech
     * boundaries, so they rarely match a window exactly — fall back to the
     * window the pick's middle sits in (or the nearest one within a clip's
     * reach), which is the moment it was actually chosen from.
     */
    const interestFor = (pick: { start: number; end: number }) => {
      const exact = interestOf.get(interestKey(pick));
      if (exact) return exact;
      const middle = (pick.start + pick.end) / 2;
      let best: { score: number; evidence: string[] } | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const w of windows) {
        const entry = interestOf.get(interestKey(w));
        if (!entry) continue;
        const distance = middle < w.start ? w.start - middle : middle > w.end ? middle - w.end : 0;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = entry;
        }
      }
      return bestDistance <= 15 ? best : undefined;
    };

    const interestByIndex = windows.map((w, i) => interestOf.get(interestKey(w))?.score ?? measuredInterest[i] ?? 0);
    const pickScores = scores.map((s, i) => Math.min(1, Math.max(s, 1.05 * interestByIndex[i]!)));
    const localPicks = pickMoments(windows, pickScores, total, count).map((pick) => {
      const index = windows.findIndex((w) => w.start === pick.start);
      return index >= 0 ? { ...pick, reason: momentReason(features[index]!) } : pick;
    });
    // ── Which moments become clips ────────────────────────────────────────
    // Two kinds of candidate, each carrying its own score:
    //   • one per measured peak — the audience's own list of moments, scored on
    //     their measured interest alone;
    //   • the speech windows the audio found, scored on the sound and words
    //     (momentScore) lifted by their measured interest, if any.
    // The model's own picks are respected first (they carry titles and reasons),
    // then one greedy pass places the rest without two clips sharing footage.
    const peakCandidates: Array<{ window: VideoWindow; score: number }> = viewSignals
      ? heatWindows(viewSignals.heat, total, { max: count }).map((w) => {
          const measuredHere = interestOf.get(interestKey(w))?.score ?? windowInterest(w, { signals: viewSignals }).score;
          return { window: w, score: Math.min(1, 1.05 * measuredHere) };
        })
      : [];
    const measuredPeaks = peakCandidates.length > 0;
    const windowCandidates: Array<{ window: VideoWindow; score: number }> = windows.map((w, i) => ({
      window: w,
      score: pickScores[i]!,
    }));
    const modelPreset = withoutOverlaps([...modelPicks], count).map((p) => ({ start: p.start, end: p.end }));
    const ranges = measuredPeaks
      ? selectClips([...peakCandidates, ...windowCandidates], total, count, {
          minSeconds: MIN_CLIP_SECONDS,
          maxSeconds: MAX_CLIP_SECONDS,
          preset: modelPreset,
        })
      : // Nothing measured: the long-standing path, unchanged, topped up by the
        // model's picks as it always was.
        withoutOverlaps([...modelPicks, ...pickMoments(windows, pickScores, total, count)], count).map((p) => ({ start: p.start, end: p.end }));

    /** A range the model chose keeps its title and reason; the rest are ours. */
    const forRange = (range: VideoWindow): ClipPick => {
      const spoken = [...modelPicks, ...localPicks].find((p) => Math.abs(p.start - range.start) <= 3);
      if (spoken) return { ...spoken, start: range.start, end: range.end };
      const index = windows.findIndex((w) => (w.start + w.end) / 2 >= range.start && (w.start + w.end) / 2 <= range.end);
      const reason = index >= 0 && !measuredPeaks ? momentReason(features[index]!) : "";
      return { start: range.start, end: range.end, title: "", reason };
    };

    // A clip begins where the audience's attention was: anchored onto the peak
    // or the comment, then pulled onto a speech boundary when one is within
    // reach so the captions still line up. Anchoring moves the range, so the
    // finished clips are pulled apart once more — a fragment is dropped rather
    // than rendered.
    const anchoredPicks = trimOverlaps(ranges.map(forRange), total, MIN_CLIP_SECONDS)
      .slice(0, count)
      .map((pick) => {
        const anchored = snapToInterest(pick, viewSignals, { minSeconds: MIN_CLIP_SECONDS, maxSeconds: MAX_CLIP_SECONDS, durationSec: total });
        const snapped = snapToSpeech({ ...pick, start: anchored.start, end: anchored.end }, runs, 2.5, total);
        return { ...pick, start: snapped.start, end: snapped.end };
      });
    const contentPicks = trimOverlaps(anchoredPicks, total, MIN_CLIP_SECONDS).slice(0, count);
    // Best measured interest first, so the person watches the strongest clip
    // while the rest render. Videos with no measured data keep the video's own
    // order, exactly as before.
    const rankedPicks = contentPicks
      .map((pick) => ({ pick, interest: interestFor(pick)?.score ?? 0 }))
      .sort((a, b) => b.interest - a.interest || a.pick.start - b.pick.start)
      .map((entry) => entry.pick);
    const finalPicks = rankedPicks.length && Math.max(...rankedPicks.map((p) => interestFor(p)?.score ?? 0)) > 0
      ? rankedPicks
      : inVideoOrder(rankedPicks);
    await all(44, `Cutting ${finalPicks.length === 1 ? "the clip" : `${finalPicks.length} clips`}…`);
    if (finalPicks.length > 1 && finalPicks.some((p) => (interestFor(p)?.score ?? 0) > 0)) {
      say("✂️ Clips arrive strongest first: the order is YouTube's own replay and comment data, then the sound and the words.", {
        actionOutput: "Ordered by measured interest, not by where the moment sits in the video",
      });
    }

    for (let i = 0; i < finalPicks.length; i++) {
      const pick = finalPicks[i]!;
      const measured = interestFor(pick);
      const interestPct = measured ? Math.round(measured.score * 100) : 0;
      const job = jobs[i];
      if (!job) break;
      const length = Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, pick.end - pick.start));
      const range = { start: pick.start, end: pick.start + length };
      const title = pick.title || `${source.name} — ${clock(pick.start)}`;
      const base = job.id;
      const videoOnly = path.join(jobsDir, `${base}_cut.mp4`);
      const audioOnly = path.join(jobsDir, `${base}_cut.m4a`);
      const outPath = path.join(uploads, clipFileName(i, pick.title, base));

      try {
        await store.updateJob(job.id, {
          settings: {
            topic: title,
            resolution: dims,
            range: clockRange(range),
            source: source.url,
            step: "Cutting the moment…",
            // Why this clip and not another: the measured interest (0–100) and
            // the evidence line, so the card can show a badge the person can
            // check against YouTube itself.
            ...(interestPct > 0 ? { interest: interestPct } : {}),
            ...(measured?.evidence.length ? { interestReason: measured.evidence[0]!.slice(0, 200) } : {}),
          } as never,
        });
        await job.report(50, "Cutting the moment…");
        // The cut is an intermediate: keep it visually lossless (crf 18) so the
        // final composite isn't re-compressing an already soft picture.
        await runFfmpeg(["-y", "-ss", pick.start.toFixed(3), "-t", length.toFixed(3), "-i", filePath, "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", videoOnly]);
        await job.report(58, "Taking its sound…");
        await runFfmpeg(["-y", "-ss", pick.start.toFixed(3), "-t", length.toFixed(3), "-i", filePath, "-vn", "-c:a", "aac", "-b:a", "160k", audioOnly]);

        // Captions: the clip's own sound is what they must match, so listen to
        // exactly that stretch. Only when that fails — the engine was busy with
        // the person, or too slow — fall back to an overlapping window's
        // transcript, and say which happened.
        const heard = canListen ? await listen(pcm, pick.start, pick.start + length) : { kind: "failed" as const, reason: engine.problem || "there's no speech engine on this PC" };
        let said = heard.kind === "said" ? heard.text : "";
        let fellBack = false;
        if (!said) {
          const borrowed = snippets.find((text, index) => text && !(windows[index]!.end < range.start || windows[index]!.start > range.end)) ?? "";
          if (borrowed) {
            said = borrowed;
            fellBack = true;
          }
        }
        const cues = said ? captionCues(said, 0, length) : [];
        const note = captionNote(cues.length, heard, { canListen, fellBack });

        await job.report(64, cues.length ? "Burning the captions…" : "Rendering the clip…");
        const settings: ExportSettings = {
          resolution: dims,
          format: "mp4",
          // Clips start life as someone else's compressed footage, so the high
          // tier would only inflate the file — "medium" (crf 23) is the honest
          // ceiling, at 1080p 60fps instead of the old 720p 30fps.
          quality: "medium",
          fps: 60,
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
        const interestLine = measured?.evidence.length
          ? `\n${measured.evidence.slice(0, 2).join("\n")}${interestPct > 0 ? ` — ${interestPct}% measured interest` : ""}`
          : "";
        say(`✂️ Clip ${i + 1} of ${finalPicks.length} — “${title}” (${clockRange(range)} of “${source.name}”)${pick.reason ? `\n${pick.reason}` : ""}${interestLine}`, {
          jobId: job.id,
          jobState: "done",
          topic: title,
          tag: "AUDIO",
          videoUrl: outputUrl,
          downloadUrl: outputUrl,
          ...(interestPct > 0 ? { interest: interestPct } : {}),
          ...(measured?.evidence.length ? { interestReason: measured.evidence.slice(0, 2).join(" · ") } : {}),
          actionOutput: `From ${source.url}\n${note}`,
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
  } finally {
    pcm.dispose();
  }
}

// ── Draining the queue ──────────────────────────────────────────────────────

let pumping = false;

/** Begins whatever is next, until nothing more can run. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const state = loadRunState();
      if (state.active) return; // its own finish() pumps the next one
      const next = nextRunnable(state, rendererFree());
      if (!next) return;
      saveRunState(beginRun(state, next.id));
      try {
        await runClips(next);
      } catch (err) {
        console.error("[clips] run failed:", (err as Error).message);
      } finally {
        saveRunState(finishRun(loadRunState(), next.id));
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * While anything waits, keep offering it to the renderer. Needed because what
 * frees the renderer isn't always a clips run: an ordinary short finishing (or
 * the person's own export) does too, and nothing tells us when.
 */
function schedulePump(): void {
  const state = loadRunState();
  if (!state.waiting.length) {
    if (pumpTimer) {
      clearInterval(pumpTimer);
      pumpTimer = null;
    }
    return;
  }
  if (pumpTimer) return;
  pumpTimer = setInterval(() => {
    void pump().catch((err) => console.warn("[clips] pump failed:", (err as Error).message));
  }, PUMP_INTERVAL_MS);
  pumpTimer.unref?.();
}

/**
 * Asks for a video to be clipped. Starts right away when the renderer is free;
 * otherwise queues it — the person is told where in the queue, rather than
 * refused. Throws only for the things that must be heard immediately: a source
 * that can't be read at all, or a queue that's already full.
 */
export async function startClipsJob(opts: ClipsOptions): Promise<ClipsStarted> {
  const count = Math.max(1, Math.min(MAX_CLIPS, Math.round(opts.count ?? DEFAULT_CLIPS)));
  const source = await checkSource(opts.video);
  // 1080p is the default (720p only when the caller explicitly asks for a
  // faster draft): clips are published, not previewed.
  const resolution = opts.resolution === "720p" ? "720p" : "1080p";
  const userId = opts.userId || "agent-local";

  const store = await getStore();
  const state = loadRunState();
  const free = rendererFree();
  const jobIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const job = await store.createJob({
      projectId: null,
      userId,
      // QUEUED until the renderer is actually theirs — a job that says
      // "processing" while it waits for two other videos is a lie the UI shows.
      status: free ? "PROCESSING" : "QUEUED",
      progress: free ? 4 : 0,
      settings: {
        topic: `${source.name} — clip ${i + 1}`,
        step: free ? "Getting the video…" : "Waiting for the renderer…",
        resolution: resolution === "1080p" ? { width: 1080, height: 1920 } : { width: 720, height: 1280 },
      } as never,
      outputUrl: null,
      errorMessage: null,
      startedAt: free ? new Date().toISOString() : null,
      completedAt: null,
    });
    jobIds.push(job.id);
    if (!free) emitJob(job.id, { status: "QUEUED", progress: 0, step: "Waiting for the renderer…" });
  }

  const run: QueuedClips = {
    id: crypto.randomUUID(),
    jobIds,
    video: opts.video,
    count,
    ...(opts.focus ? { focus: opts.focus } : {}),
    resolution,
    userId,
    sourceName: source.name,
    askedAt: Date.now(),
  };

  const clipsAhead = state.waiting.length;
  const landing = landingPosition(state);
  const next = enqueue(state, run);
  if (!next) {
    // The queue is full: undo the jobs rather than leave them waiting forever.
    for (const id of jobIds) {
      await store.updateJob(id, { status: "FAILED", errorMessage: `The clips queue is full (${MAX_WAITING} videos waiting).`, completedAt: new Date().toISOString() });
      emitJob(id, { status: "FAILED", error: `The clips queue is full (${MAX_WAITING} videos waiting).` });
    }
    throw new Error(`I've already got ${MAX_WAITING} videos waiting to be clipped — ask me again once some of them are done.`);
  }
  saveRunState(next);

  // Queued when something else holds the renderer — another clips run, or an
  // ordinary short — or when this one isn't at the front of the line. The
  // drainer promotes and runs it; nothing here executes it directly, so there's
  // one place that decides a render may begin.
  const queued = !free || landing > 1;
  const position = queued ? landing : 0;
  if (queued) {
    const busyWith = state.active?.sourceName ?? getActiveShortJobs()[0]?.topic ?? null;
    const at = Date.now();
    appendToConversation({
      id: newMessageId(at),
      sender: "assistant",
      text: queuedText(run, { busyWith, clipsAhead }),
      time: chatTime(new Date(at)),
      at,
      tag: "SYS",
      actionOutput: busyText(next) || `Waiting for the renderer${busyWith ? `: “${busyWith}”` : ""}.`,
    });
  }
  void pump().catch((err) => console.error("[clips] failed:", (err as Error).message));

  return { jobIds, sourceName: source.name, count, queued, position, waitingAhead: clipsAhead };
}

/**
 * At startup: settle the clips the last session left behind. The renderer died
 * with the process, so nothing queued can ever finish — the jobs are failed
 * with the truth and the person is told, instead of the Command Center showing
 * "processing" clips that will never appear.
 */
export function initClips(): void {
  const state = loadRunState();
  const orphans = orphanedJobs(state);
  saveRunState(emptyRunState());
  if (!orphans.length) return;
  void (async () => {
    try {
      const store = await getStore();
      const reason = "Soundwave AI was closed before this finished.";
      let settled = 0;
      for (const id of orphans) {
        const job = await store.getJobById(id);
        if (!job || job.status === "COMPLETED" || job.status === "FAILED") continue;
        await store.updateJob(id, { status: "FAILED", progress: 0, errorMessage: reason, completedAt: new Date().toISOString() });
        emitJob(id, { status: "FAILED", error: reason });
        settled++;
      }
      if (settled) {
        const at = Date.now();
        appendToConversation({
          id: newMessageId(at),
          sender: "assistant",
          text: `✂️ ${settled === 1 ? "A clip was" : `${settled} clips were`} still being cut when Soundwave AI closed — ask me again and I'll make ${settled === 1 ? "it" : "them"} now.`,
          time: chatTime(new Date(at)),
          at,
          tag: "SYS",
          actionOutput: reason,
        });
      }
    } catch (err) {
      console.warn(`[clips] couldn't settle the last session's jobs: ${(err as Error).message}`);
    }
  })();
}
