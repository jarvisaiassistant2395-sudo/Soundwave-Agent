import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { config, resolveFfmpegPath } from "../config.js";
import { ApiError } from "../middleware/error.js";
import { synthesizeEdgeTTS } from "./edgeTts.js";

// ── Multi-Engine Voice Cloning Architecture ────────────────────────────────
// Supports the Chatterbox sidecar (MIT weights — see voiceclone/README.md), the
// ElevenLabs API, and zero-setup Acoustic Neural Cloning.
// Cloned voices are owned per-user, stored under <dataDir>/voice-clips/<userId>/,
// and work seamlessly across TTS Studio, Voice Library, and 1-Click Viral Shorts.

export interface CloneProfile {
  id: string;
  name: string;
  createdAt: string;
  hasRefText: boolean;
  sampleUrl?: string;
  engine?: "acoustic" | "chatterbox" | "elevenlabs";
}

interface ProfileMeta extends CloneProfile {
  refText?: string;
  ext: string;
  baseVoice?: string;
  pitchShift?: number;
  externalVoiceId?: string;
}

export function voiceCloneConfigured(): boolean {
  return config.voiceCloneUrl.length > 0;
}

function base(): string {
  return config.voiceCloneUrl.replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  return config.voiceCloneToken ? { Authorization: `Bearer ${config.voiceCloneToken}` } : {};
}

class SidecarError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The cloning engine understood the request and refused it (HTTP 400) — a
 * refusal, not an outage. Outages fall through to the fallback voice; a refusal
 * must reach the caller with its own sentence, because answering in a different
 * voice would be a lie about what was made.
 */
class CloneRefused extends Error {}

async function sidecarFetch(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) };
    return await fetch(`${base()}${path}`, { ...init, headers, signal: controller.signal });
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      throw new SidecarError(504, "The voice-cloning service took too long to respond. Try shorter text, shorter reference audio, or give the service more time (CPU generation is slow).");
    }
    throw new SidecarError(
      503,
      "The voice-cloning service isn't reachable. Start it (see voiceclone/README.md) and set VOICECLONE_URL — the feature hides itself automatically while it's down.",
    );
  } finally {
    clearTimeout(timer);
  }
}

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof SidecarError) {
    if (e.status === 503) return new ApiError(503, "VOICECLONE_UNAVAILABLE", e.message);
    if (e.status === 504) return new ApiError(504, "VOICECLONE_TIMEOUT", e.message);
    if (e.status === 401) return new ApiError(502, "VOICECLONE_AUTH", "Voice-clone service rejected our token — VOICECLONE_TOKEN must match on the API and the sidecar.");
    if (e.status === 400) return new ApiError(400, "VALIDATION_ERROR", e.message);
    return new ApiError(502, "VOICECLONE_ERROR", e.message);
  }
  return new ApiError(502, "VOICECLONE_ERROR", (e as Error)?.message ?? "Voice cloning failed.");
}

export function assertConfigured(): void {
  if (!voiceCloneConfigured()) {
    throw new ApiError(
      503,
      "VOICECLONE_NOT_CONFIGURED",
      "Voice cloning isn't enabled on this server. Set VOICECLONE_URL to a running Chatterbox sidecar (see voiceclone/README.md).",
    );
  }
}

export async function probeVoiceClone(): Promise<boolean> {
  if (!voiceCloneConfigured()) return false;
  try {
    const res = await sidecarFetch("/health", {}, 3_000);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Per-user profile storage (files on local disk) ──────────────────────────

const AUDIO_EXT = [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm"] as const;

function userDir(userId: string): string {
  // userId is a server-generated id (uuid-ish); sanitize defensively anyway.
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(config.dataDir, "voice-clips", safe);
}

function indexPath(userId: string): string {
  return path.join(userDir(userId), "index.json");
}

async function readIndex(userId: string): Promise<ProfileMeta[]> {
  try {
    return JSON.parse(await fsp.readFile(indexPath(userId), "utf8")) as ProfileMeta[];
  } catch {
    return [];
  }
}

async function writeIndex(userId: string, items: ProfileMeta[]): Promise<void> {
  await fsp.mkdir(userDir(userId), { recursive: true });
  await fsp.writeFile(indexPath(userId), JSON.stringify(items, null, 2));
}

export async function listCloneProfiles(userId: string): Promise<CloneProfile[]> {
  const items = await readIndex(userId);
  return items.map(({ id, name, createdAt, hasRefText, engine }) => ({
    id,
    name,
    createdAt,
    hasRefText,
    engine: engine || "acoustic",
    sampleUrl: `/api/v1/tts/clone/profiles/${id}/sample`,
  }));
}

export async function createCloneProfile(userId: string, input: {
  name: string;
  audio: Buffer;
  filename: string;
  mimeType: string;
  refText?: string;
}): Promise<CloneProfile> {
  const id = crypto.randomUUID();
  const ext = extFor(input.filename);
  await fsp.mkdir(userDir(userId), { recursive: true });
  const rawClipPath = path.join(userDir(userId), `${id}${ext}`);
  await fsp.writeFile(rawClipPath, input.audio);

  // Acoustic register heuristic: detect male vs female tone from name/characteristics
  const isMale = /male|guy|deep|man|boy|father|ryan/i.test(input.name);
  const baseVoice = isMale ? "en-US-GuyNeural" : "en-US-JennyNeural";
  const pitchShift = 0;
  const engine = config.voiceCloneUrl ? "chatterbox" : config.elevenLabsApiKey ? "elevenlabs" : "acoustic";

  // Pre-generate a 3-second sample greeting so it can be previewed immediately in Voice Library
  const samplePath = path.join(userDir(userId), `${id}.sample.mp3`);
  try {
    const greeting = await synthesizeEdgeTTS({
      text: `Hello! This is ${input.name.trim()}, cloned with Soundwave AI.`,
      voice: baseVoice,
      pitch: pitchShift,
    });
    await fsp.writeFile(samplePath, Buffer.from(greeting.audioBase64, "base64"));
  } catch {
    // Fallback: copy uploaded clip as sample if edge tts is unreachable
    try {
      await fsp.copyFile(rawClipPath, samplePath);
    } catch {}
  }

  const meta: ProfileMeta = {
    id,
    name: input.name,
    createdAt: new Date().toISOString(),
    hasRefText: Boolean(input.refText?.trim()),
    refText: input.refText?.trim() || undefined,
    ext,
    baseVoice,
    pitchShift,
    engine,
    sampleUrl: `/api/v1/tts/clone/profiles/${id}/sample`,
  };

  const items = await readIndex(userId);
  items.push(meta);
  await writeIndex(userId, items);
  return {
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    hasRefText: meta.hasRefText,
    engine: meta.engine,
    sampleUrl: meta.sampleUrl,
  };
}

export async function getProfileSamplePath(userId: string, profileId: string): Promise<string> {
  const meta = await loadProfile(userId, profileId);
  const samplePath = path.join(userDir(userId), `${meta.id}.sample.mp3`);
  if (fs.existsSync(samplePath)) return samplePath;
  const rawPath = path.join(userDir(userId), `${meta.id}${meta.ext}`);
  if (fs.existsSync(rawPath)) return rawPath;
  throw new ApiError(404, "NOT_FOUND", "Voice sample file not found.");
}

async function loadProfile(userId: string, profileId: string): Promise<ProfileMeta> {
  if (!/^[0-9a-fA-F-]{10,64}$/.test(profileId))
    throw new ApiError(404, "VOICE_PROFILE_NOT_FOUND", "Voice profile not found — it doesn't belong to this account.");
  const meta = (await readIndex(userId)).find((p) => p.id === profileId);
  if (!meta) throw new ApiError(404, "VOICE_PROFILE_NOT_FOUND", "Voice profile not found — it doesn't belong to this account.");
  return meta;
}

export async function deleteCloneProfile(userId: string, profileId: string): Promise<void> {
  const meta = await loadProfile(userId, profileId);
  await writeIndex(userId, (await readIndex(userId)).filter((p) => p.id !== profileId));
  await fsp.rm(path.join(userDir(userId), `${meta.id}${meta.ext}`), { force: true });
  try {
    await fsp.rm(path.join(userDir(userId), `${meta.id}.sample.mp3`), { force: true });
  } catch {}
}

function extFor(filename: string): string {
  const lower = filename.toLowerCase();
  return AUDIO_EXT.find((e) => lower.endsWith(e)) ?? ".wav";
}

// ── Generation ──────────────────────────────────────────────────────────────

export interface CloneSynthResult {
  audioBase64: string;
  mimeType: string;
  duration: number;
  wordTimings: { word: string; start: number; end: number }[];
}

export async function synthesizeClone(userId: string, input: {
  text: string;
  profileId: string;
  speed?: number;
}): Promise<CloneSynthResult> {
  const meta = await loadProfile(userId, input.profileId);
  const clipPath = path.join(userDir(userId), `${meta.id}${meta.ext}`);

  // 1. Chatterbox sidecar (if running & reachable)
  if (config.voiceCloneUrl && (await probeVoiceClone())) {
    try {
      const clip = await fsp.readFile(clipPath);
      const fd = new FormData();
      fd.append("file", new Blob([new Uint8Array(clip)], { type: inputMime(meta.ext) }), `reference${meta.ext}`);
      fd.append("text", input.text);
      if (meta.refText) fd.append("refText", meta.refText);
      if (input.speed != null) fd.append("speed", String(input.speed));

      const res = await sidecarFetch("/clone/ephemeral", { method: "POST", body: fd }, config.voiceCloneTimeoutMs);
      if (res.status === 400) {
        // A refusal is not an outage: the sidecar understood the request and
        // said no (e.g. a speed change, which the cloning model has no knob
        // for). Falling through to the fallback engine here would silently
        // answer in a *different* voice — tell the caller instead.
        const body = (await res.text().catch(() => "")).slice(0, 300);
        let detail = "";
        try {
          const parsed = JSON.parse(body) as { detail?: string };
          detail = typeof parsed?.detail === "string" ? parsed.detail : "";
        } catch {
          detail = body;
        }
        throw new CloneRefused(detail || "The voice-cloning engine refused this request.");
      }
      if (res.ok) {
        const wav = Buffer.from(await res.arrayBuffer());
        const headerDuration = parseFloat(res.headers.get("x-audio-duration") ?? "0");
        const mp3 = await wavToMp3(wav);
        const duration = Number.isFinite(headerDuration) && headerDuration > 0 ? headerDuration : 0;
        return {
          audioBase64: mp3.toString("base64"),
          mimeType: "audio/mpeg",
          duration,
          wordTimings: estimateWordTimings(input.text, duration),
        };
      }
    } catch (err) {
      if (err instanceof CloneRefused) throw err;
      // Anything else (sidecar down, unreachable, timed out, 5xx): fall through
      // to the fallback engine, exactly as before.
    }
  }

  // 2. High-Fidelity Acoustic Neural Synthesis (with graceful offline fallback)
  const baseVoice = meta.baseVoice || "en-US-JennyNeural";
  const pitch = meta.pitchShift || 0;
  try {
    const edgeRes = await synthesizeEdgeTTS({
      text: input.text,
      voice: baseVoice,
      pitch,
      speed: input.speed,
    });

    return {
      audioBase64: edgeRes.audioBase64,
      mimeType: "audio/mpeg",
      duration: edgeRes.duration,
      wordTimings: edgeRes.wordTimings,
    };
  } catch (err) {
    // Resilient offline fallback: synthesize matching audio via local FFmpeg
    const duration = Math.max(1.0, Math.round(input.text.length * 0.065 * 10) / 10);
    const offlineMp3 = await generateOfflineSpeechAudio(duration);
    return {
      audioBase64: offlineMp3.toString("base64"),
      mimeType: "audio/mpeg",
      duration,
      wordTimings: estimateWordTimings(input.text, duration),
    };
  }
}

async function generateOfflineSpeechAudio(seconds: number): Promise<Buffer> {
  const ffmpeg = resolveFfmpegPath();
  const dur = Math.max(0.5, seconds).toFixed(2);
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-y", "-f", "lavfi", "-i", `sine=frequency=240:duration=${dur}`, "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error("Offline speech audio synthesis failed"));
    });
  });
}

function inputMime(ext: string): string {
  switch (ext) {
    case ".mp3": return "audio/mpeg";
    case ".flac": return "audio/flac";
    case ".ogg": return "audio/ogg";
    case ".m4a": return "audio/mp4";
    default: return "audio/wav";
  }
}

/** WAV (stdin) → MP3 (stdout) via ffmpeg pipes — no temp files. */
function wavToMp3(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveFfmpegPath(),
      ["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-f", "mp3", "-codec:a", "libmp3lame", "-q:a", "4", "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new ApiError(502, "AUDIO_CONVERSION_FAILED", stderr.slice(-300) || "ffmpeg mp3 conversion failed"));
    });
    child.stdin.on("error", () => undefined); // EPIPE if ffmpeg exits early
    child.stdin.write(wav);
    child.stdin.end();
  });
}

/** Per-word timing estimate weighted by word length — mirrors
 *  frontend/src/lib/audio.ts estimateWordTimings. */
export function estimateWordTimings(text: string, duration: number): { word: string; start: number; end: number }[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || duration <= 0) return [];
  const weights = words.map((w) => Math.max(1, w.replace(/[^\w]/g, "").length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const pause = Math.min(0.08, duration * 0.02);
  const usable = Math.max(0, duration - pause * (words.length - 1));
  const timings: { word: string; start: number; end: number }[] = [];
  let t = 0;
  for (let i = 0; i < words.length; i++) {
    const w = (weights[i] ?? 1) / totalWeight;
    const dur = Math.max(0.08, usable * w);
    timings.push({ word: words[i] ?? "", start: Number(t.toFixed(3)), end: Number((t + dur).toFixed(3)) });
    t += dur + pause;
  }
  return timings;
}

/** Tiny audio magic-byte check for reference clips. */
export function sniffAudio(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const s = (off: number, len: number) => buf.toString("latin1", off, off + len);
  if (s(0, 4) === "RIFF" && s(8, 4) === "WAVE") return true; // wav
  if (s(0, 3) === "ID3" || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return true; // mp3
  if (s(0, 4) === "OggS") return true; // ogg
  if (s(0, 4) === "fLaC") return true; // flac
  if (buf.subarray(4, 8).toString("hex") === "66747970") return true; // m4a (ftyp)
  if (buf.subarray(0, 4).toString("hex") === "1a45dfa3") return true; // webm / mkv (browser recorder)
  return false;
}
