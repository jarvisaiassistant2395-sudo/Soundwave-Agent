// ── Voice input: local speech-to-text ───────────────────────────────────────
// The agent's microphone (Command Center mic button, the desktop app's
// Ctrl+Shift+Space voice bar) records a short clip and posts it here. It is
// transcribed ON THIS PC by whisper.cpp's CLI (whisper-cli) with a bundled
// English model — no account, no API key, and the audio never leaves the
// machine.
//
// Windows notes: whisper-cli reads its command line in the ANSI code page, so
// a model path containing non-ASCII characters (e.g. a Serbian user name in
// C:\Users\…) would not open. We therefore never pass absolute paths to it:
// the child runs with its working directory set to the model's folder (Node
// passes that to Windows as UTF-16), gets the model by file name, the audio on
// stdin and prints the text on stdout.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFfmpegPath } from "../config.js";

/** whisper.cpp wants 16 kHz mono 16-bit PCM. */
export const STT_SAMPLE_RATE = 16_000;
/** Longest clip we transcribe (seconds). Voice commands are short. */
export const MAX_AUDIO_SECONDS = 60;
/** Upper bound for one whisper run, when the caller doesn't say otherwise. */
const WHISPER_TIMEOUT_MS = Number.parseInt(process.env.WHISPER_TIMEOUT_MS ?? "", 10) || 90_000;
/** Longest any single whisper run may take, however long the audio is. */
const MAX_WHISPER_TIMEOUT_MS = 10 * 60_000;
/** Requests allowed to wait while one transcription runs. */
const MAX_QUEUED = 2;

/**
 * How long a transcription of `seconds` of audio may take.
 *
 * A person waiting on a voice command should not sit through more than
 * WHISPER_TIMEOUT_MS, so short recordings keep that cap. Background work with
 * nobody waiting (clipping a long video — see lib/videoClips.ts) transcribes
 * windows up to a minute long, and on a modest CPU whisper.cpp can run slower
 * than real time: killing it at 90 s turned a slow machine into clips with no
 * captions and no honest reason. Such a caller asks for a budget proportional
 * to the audio instead, still under MAX_WHISPER_TIMEOUT_MS.
 */
export function whisperBudgetMs(audioSeconds: number, floorMs = WHISPER_TIMEOUT_MS): number {
  const seconds = Number.isFinite(audioSeconds) ? Math.max(0, audioSeconds) : 0;
  // Four times the audio's own length: slower than real time on the weakest
  // CPU we ship on, generous enough that a slow machine still finishes.
  return Math.min(MAX_WHISPER_TIMEOUT_MS, Math.max(floorMs, seconds * 4_000));
}

/** Model files we look for, best first (English models suit the agent). */
export const MODEL_PREFERENCE = [
  "ggml-base.en-q5_1.bin",
  "ggml-base.en-q8_0.bin",
  "ggml-base.en.bin",
  "ggml-small.en-q5_1.bin",
  "ggml-small.en.bin",
  "ggml-tiny.en-q5_1.bin",
  "ggml-tiny.en-q8_0.bin",
  "ggml-tiny.en.bin",
  "ggml-base-q5_1.bin",
  "ggml-base.bin",
  "ggml-tiny-q5_1.bin",
  "ggml-tiny.bin",
];

export type SttErrorCode = "STT_UNAVAILABLE" | "BAD_AUDIO" | "STT_BUSY" | "STT_FAILED" | "STT_ABORTED";

export class SttError extends Error {
  constructor(
    readonly code: SttErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SttError";
  }
}

export interface WhisperSetup {
  /** whisper-cli executable. */
  cli: string;
  /** ggml model file. */
  model: string;
  /** "base.en", "tiny", … */
  modelName: string;
}

export interface TranscriptResult {
  /** What was said ("" when nothing was). */
  text: string;
  /** True when the clip held no speech (nothing was sent to whisper, or it heard none). */
  noSpeech: boolean;
  /** Length of the clip. */
  durationMs: number;
  /** Time spent transcribing (0 when skipped). */
  elapsedMs: number;
  model: string;
}

export interface SttStatus {
  available: boolean;
  engine: "whisper.cpp";
  model: string | null;
  /** Why voice input can't work, when it can't. */
  reason: string | null;
  lastError: string | null;
  lastTranscribedAt: string | null;
  lastElapsedMs: number | null;
}

// ── Finding whisper-cli and a model ─────────────────────────────────────────

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function firstFile(candidates: string[]): string | null {
  for (const c of candidates) if (isFile(c)) return c;
  return null;
}

/** "ggml-base.en-q5_1.bin" → "base.en" */
export function modelLabel(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file)
    .replace(/^ggml-/, "")
    .replace(/\.bin$/, "")
    .replace(/-q\d_\d$/, "");
}

/**
 * Where the speech engine lives:
 *  1. WHISPER_CLI_PATH / WHISPER_MODEL_PATH (the desktop app sets both to its
 *     bundled copies in resources/bin/whisper);
 *  2. vendor/whisper/ next to the server (dev machines; git-ignored).
 * The model is looked up next to the CLI, then in vendor/whisper(/models).
 */
export function resolveWhisper(): { setup: WhisperSetup | null; problem: string | null } {
  const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const vendorDirs = [path.resolve(process.cwd(), "..", "vendor", "whisper"), path.resolve(process.cwd(), "vendor", "whisper")];

  const envCli = (process.env.WHISPER_CLI_PATH ?? "").trim();
  const envModel = (process.env.WHISPER_MODEL_PATH ?? "").trim();
  if (envCli && !isFile(envCli)) return { setup: null, problem: `The speech engine is missing (WHISPER_CLI_PATH: ${envCli}).` };
  if (envModel && !isFile(envModel)) return { setup: null, problem: `The speech model is missing (WHISPER_MODEL_PATH: ${envModel}).` };

  const cli =
    envCli ||
    firstFile(
      vendorDirs.flatMap((d) => [path.join(d, exe), path.join(d, "bin", exe), path.join(d, "build", "bin", exe), path.join(d, "Release", exe)]),
    );
  const modelDirs = [...(cli ? [path.dirname(cli)] : []), ...vendorDirs, ...vendorDirs.map((d) => path.join(d, "models"))];
  const model = envModel || firstFile(modelDirs.flatMap((d) => MODEL_PREFERENCE.map((f) => path.join(d, f))));

  if (!cli) {
    return {
      setup: null,
      problem: "The speech engine (whisper.cpp) isn't installed. The desktop app ships it; on a dev machine put whisper-cli in vendor/whisper.",
    };
  }
  if (!model) {
    return {
      setup: null,
      problem: "The speech model for voice input is missing. The desktop app ships it; on a dev machine put a ggml model (e.g. ggml-base.en-q5_1.bin) in vendor/whisper.",
    };
  }
  return { setup: { cli, model, modelName: modelLabel(model) }, problem: null };
}

// ── Audio helpers ───────────────────────────────────────────────────────────

export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

/** Reads a RIFF/WAVE header (tolerates streamed files with unknown sizes). */
export function parseWav(buf: Buffer): WavInfo | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let fmt: Omit<WavInfo, "dataOffset" | "dataLength"> | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) return null;
      let audioFormat = buf.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first word.
      if (audioFormat === 0xfffe && size >= 40 && body + 26 <= buf.length) audioFormat = buf.readUInt16LE(body + 24);
      fmt = {
        audioFormat,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) return null;
      const remaining = buf.length - body;
      // Streamed WAVs (ffmpeg to a pipe, some recorders) leave the size at 0 or 0xFFFFFFFF.
      let length = size === 0 || size === 0xffffffff ? remaining : Math.min(size, remaining);
      const frame = Math.max(1, (fmt.channels * fmt.bitsPerSample) / 8);
      length -= length % frame;
      return { ...fmt, dataOffset: body, dataLength: length };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** 16 kHz mono 16-bit PCM WAV around `pcm`. */
export function encodeWav(pcm: Int16Array, sampleRate = STT_SAMPLE_RATE): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, 44 + i * 2);
  return buf;
}

function pcmFromWav(buf: Buffer, info: WavInfo): Int16Array {
  const pcm = new Int16Array(info.dataLength / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(info.dataOffset + i * 2);
  return pcm;
}

export interface AudioLevels {
  durationMs: number;
  /** Loudest sample, dBFS. */
  peakDb: number;
  /** Roughly how long someone was talking (20 ms frames clearly above the noise floor). */
  voicedMs: number;
}

/** Energy analysis that decides whether a clip is worth transcribing at all. */
export function analyzePcm(pcm: Int16Array, sampleRate = STT_SAMPLE_RATE): AudioLevels {
  const durationMs = (pcm.length / sampleRate) * 1000;
  const frameLen = Math.max(1, Math.round(sampleRate * 0.02));
  const frames: number[] = [];
  let peak = 0;
  for (let start = 0; start + frameLen <= pcm.length; start += frameLen) {
    let sum = 0;
    for (let i = start; i < start + frameLen; i++) {
      const v = pcm[i]! / 32768;
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    frames.push(10 * Math.log10(sum / frameLen + 1e-12));
  }
  if (frames.length === 0) return { durationMs, peakDb: -120, voicedMs: 0 };
  const sorted = [...frames].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)]!;
  const threshold = Math.max(floor + 10, -50);
  const voiced = frames.filter((db) => db > threshold).length;
  return { durationMs, peakDb: 20 * Math.log10(peak + 1e-12), voicedMs: voiced * 20 };
}

/** Any audio ffmpeg understands (webm/opus, mp3, other WAVs …) → 16 kHz mono PCM WAV. */
function convertWithFfmpeg(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(STT_SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      "-t",
      String(MAX_AUDIO_SECONDS),
      "-f",
      "wav",
      "pipe:1",
    ];
    let child;
    try {
      child = spawn(resolveFfmpegPath(), args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      reject(new SttError("BAD_AUDIO", `This recording format needs ffmpeg to convert it (${(err as Error).message}).`));
      return;
    }
    const out: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new SttError("BAD_AUDIO", `This recording format needs ffmpeg to convert it (${err.message}).`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length > 0) resolve(Buffer.concat(out));
      else reject(new SttError("BAD_AUDIO", `That recording couldn't be read${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : "."}`));
    });
    child.stdin.on("error", () => undefined); // ffmpeg may exit before reading everything
    child.stdin.end(input);
  });
}

// ── Transcript clean-up ─────────────────────────────────────────────────────

/** Whisper's usual inventions on (near-)silent audio. */
const SILENCE_HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching and see you next time",
  "please subscribe",
  "subscribe",
  "bye",
]);

/**
 * Drops whisper's non-speech annotations — "[BLANK_AUDIO]", "(upbeat music)",
 * "*laughs*", "♪" — and joins the segments into one line.
 */
export function cleanTranscript(raw: string, levels?: Pick<AudioLevels, "voicedMs">): string {
  let text = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
  if (/^[\s.,!?;:'"-]*$/.test(text)) return "";
  const bare = text.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (SILENCE_HALLUCINATIONS.has(bare) && (!levels || levels.voicedMs < 1200)) return "";
  // A stray leading dash/ellipsis from segment joins.
  text = text.replace(/^[-–—.\s]+/, "");
  return text;
}

// ── Running whisper-cli ─────────────────────────────────────────────────────

function whisperThreads(): number {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length || 2;
  return Math.max(1, Math.min(cores, 8, Math.max(2, cores - 1)));
}

/** Windows NTSTATUS exit codes worth translating for a person. */
function describeExit(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  if (code === 3221225781 || code === -1073741515) {
    return "A Windows component the speech engine needs is missing (Microsoft Visual C++ runtime). Reinstalling Soundwave AI puts it back.";
  }
  if (code === 3221225501 || code === -1073741795) {
    return "This PC's processor can't run the bundled speech engine (unsupported CPU instructions).";
  }
  const detail = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(whisper_|ggml_|load_backend|system_info|main:|read_audio_data)/.test(l))
    .pop();
  if (/failed to (open|load|initialize).*model|invalid model|failed to read/i.test(stderr)) {
    return "The speech model couldn't be loaded — it may be damaged. Reinstalling Soundwave AI fixes that.";
  }
  return `The speech engine stopped (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : "."}`;
}

let queued = 0;
let chain: Promise<unknown> = Promise.resolve();

/**
 * One whisper at a time — with the person's request ahead of anything else.
 *
 * `background` marks work nobody is waiting for: the hidden wake listener
 * checking what it just heard ("Hey Soundwave"). Such a request is refused the
 * moment *anything* is queued, and the listener throws that utterance away and
 * checks the next one — so a person's recording can never sit in a queue behind
 * it, or fail because a background check filled the queue. Whisper is a single
 * process on a single PC, and both callers want it: the person goes first.
 */
function enqueue<T>(task: () => Promise<T>, opts: { background?: boolean } = {}): Promise<T> {
  if (opts.background && queued > 0) {
    return Promise.reject(new SttError("STT_BUSY", "The speech engine is busy with something you asked for."));
  }
  if (queued > MAX_QUEUED) {
    return Promise.reject(new SttError("STT_BUSY", "Still working on your last voice command — try again in a moment."));
  }
  queued++;
  const run = chain.then(task, task).finally(() => {
    queued--;
  });
  chain = run.catch(() => undefined);
  return run;
}

function runWhisper(setup: WhisperSetup, wav: Buffer, signal?: AbortSignal, timeoutMs = WHISPER_TIMEOUT_MS): Promise<string> {
  const language = (process.env.WHISPER_LANGUAGE ?? "").trim() || "en";
  const args = [
    "-m",
    path.basename(setup.model),
    "-f",
    "-", // audio on stdin
    // A basename other than "-" keeps results on stdout (no output files are
    // written without an --output-* flag). "-" would open CON on Windows.
    "-of",
    "soundwave-stt",
    "-l",
    language,
    "-t",
    String(whisperThreads()),
    "-nt", // no timestamps
    "-np", // results only
    "-sns", // suppress non-speech tokens ([Music], ♪ …)
  ];

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SttError("STT_ABORTED", "Cancelled."));
      return;
    }
    let child;
    try {
      child = spawn(setup.cli, args, { cwd: path.dirname(setup.model), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      reject(new SttError("STT_FAILED", `The speech engine couldn't start: ${(err as Error).message}`));
      return;
    }
    const out: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new SttError("STT_ABORTED", "Cancelled.")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new SttError("STT_FAILED", `The speech engine took longer than ${Math.round(timeoutMs / 1000)} s.`)));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-6000);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      const why =
        err.code === "ENOENT"
          ? "The speech engine is missing — reinstalling Soundwave AI puts it back."
          : err.code === "EACCES" || err.code === "EPERM"
            ? "Windows blocked the speech engine from running (antivirus or permissions)."
            : `The speech engine couldn't start: ${err.message}`;
      finish(() => reject(new SttError("STT_FAILED", why)));
    });
    child.on("close", (code, sig) => {
      if (code === 0) finish(() => resolve(Buffer.concat(out).toString("utf8")));
      else finish(() => reject(new SttError("STT_FAILED", describeExit(code, sig, stderr))));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(wav);
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

const health: { lastError: string | null; lastTranscribedAt: string | null; lastElapsedMs: number | null } = {
  lastError: null,
  lastTranscribedAt: null,
  lastElapsedMs: null,
};

export function getSttStatus(): SttStatus {
  const { setup, problem } = resolveWhisper();
  return {
    available: Boolean(setup),
    engine: "whisper.cpp",
    model: setup?.modelName ?? null,
    reason: problem,
    ...health,
  };
}

/**
 * Transcribe a recording. Takes 16 kHz mono PCM WAV as-is (what the app's
 * recorder sends); anything else is converted with ffmpeg first. Near-silent
 * clips come back as `{ text: "", noSpeech: true }` without running whisper.
 * `background: true` is for work nobody is waiting on (the wake listener, the
 * video clipper): it is refused rather than queued when the engine is already
 * busy, so a person's recording always goes first — such a caller must treat
 * STT_BUSY as "try again", never as "there was nothing said".
 * `timeoutMs` overrides the 90 s cap for long background audio (see
 * whisperBudgetMs); it is clamped, and short recordings keep the default.
 */
export async function transcribe(
  audio: Buffer,
  opts: { signal?: AbortSignal; background?: boolean; timeoutMs?: number } = {},
): Promise<TranscriptResult> {
  const { setup, problem } = resolveWhisper();
  if (!setup) throw new SttError("STT_UNAVAILABLE", problem ?? "Voice input isn't available.");
  if (!audio || audio.length < 64) throw new SttError("BAD_AUDIO", "The recording was empty.");

  let info = parseWav(audio);
  let wav = audio;
  const ready = (i: WavInfo | null) => Boolean(i && i.audioFormat === 1 && i.channels === 1 && i.sampleRate === STT_SAMPLE_RATE && i.bitsPerSample === 16);
  if (!ready(info)) {
    wav = await convertWithFfmpeg(audio);
    info = parseWav(wav);
    if (!ready(info)) throw new SttError("BAD_AUDIO", "That recording couldn't be converted for the speech engine.");
  }

  let pcm = pcmFromWav(wav, info!);
  const maxSamples = MAX_AUDIO_SECONDS * STT_SAMPLE_RATE;
  if (pcm.length > maxSamples) pcm = pcm.subarray(0, maxSamples);
  const levels = analyzePcm(pcm);
  const base = { durationMs: Math.round(levels.durationMs), model: setup.modelName };
  if (levels.durationMs < 250 || levels.peakDb < -45 || levels.voicedMs < 150) {
    return { ...base, text: "", noSpeech: true, elapsedMs: 0 };
  }

  const started = Date.now();
  const budget = Number.isFinite(opts.timeoutMs)
    ? Math.min(MAX_WHISPER_TIMEOUT_MS, Math.max(1_000, Math.round(opts.timeoutMs as number)))
    : WHISPER_TIMEOUT_MS;
  try {
    const raw = await enqueue(() => runWhisper(setup, encodeWav(pcm), opts.signal, budget), { background: opts.background });
    const text = cleanTranscript(raw, levels);
    const elapsedMs = Date.now() - started;
    health.lastError = null;
    health.lastTranscribedAt = new Date().toISOString();
    health.lastElapsedMs = elapsedMs;
    return { ...base, text, noSpeech: text.length === 0, elapsedMs };
  } catch (err) {
    if (err instanceof SttError && err.code !== "STT_ABORTED" && err.code !== "STT_BUSY") health.lastError = err.message;
    throw err;
  }
}
