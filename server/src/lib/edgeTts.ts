// ── Soundwave voices: Microsoft Edge neural TTS ─────────────────────────────
// The free, key-less "Read Aloud" service the Edge browser uses. Soundwave
// talks to it directly over its WebSocket protocol (the same handshake the
// browser and the reference rany2/edge-tts client send: ConnectionId, a
// Sec-MS-GEC token, and a muid cookie) so that audio can be STREAMED to the
// app as it is synthesized — the agent starts speaking within a fraction of a
// second instead of after the whole reply has been rendered.
//
// node-edge-tts stays as a second engine: if Microsoft ever rejects this
// client's handshake while still accepting node-edge-tts's, synthesis keeps
// working (just without streaming).
//
// There is deliberately NO non-neural fallback (no browser voice, no Windows
// SAPI voice): when the service can't be reached, callers get a clear error.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { EdgeTTS as LegacyEdgeTTS } from "node-edge-tts";

export interface EdgeVoiceInput {
  text: string;
  voice: string;
  /** 0.5 .. 2.0 multiplier, mapped to SSML prosody rate. Default 0.95 for human pacing. */
  speed?: number;
  /** -50 .. +50 (%), mapped to SSML prosody pitch. Default 0. */
  pitch?: number;
  /** 0 .. 100 (%), mapped to SSML prosody volume. */
  volume?: number;
}

export interface EdgeWordTiming {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

export interface EdgeSynthResult {
  audioBase64: string;
  mimeType: "audio/mpeg";
  duration: number; // seconds
  wordTimings: EdgeWordTiming[];
}

export interface EdgeSynthOptions {
  /** Whole synthesis attempts (each may also try the second engine). Default 3. */
  attempts?: number;
  /** Apply {@link formatNaturalSpeechPacing}. Default true. */
  pacing?: boolean;
  signal?: AbortSignal;
}

// ── Service constants (mirror the Edge browser's Read Aloud client) ─────────
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const DEFAULT_WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;
/** The format the Edge browser itself requests: 24 kHz mono MP3, 48 kbps CBR. */
export const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const MP3_BYTES_PER_SECOND = 48_000 / 8;
const WIN_EPOCH_SECONDS = 11_644_473_600n;
/** Longest raw text sent in one request; longer text is split at sentence ends. */
const MAX_CHUNK_CHARS = 2000;

function timeouts(): { connectMs: number; firstAudioMs: number; idleMs: number } {
  // EDGE_TTS_TIMEOUT_MS only exists so tests don't wait 12 s for a silent stand-in.
  const override = Number(process.env.EDGE_TTS_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return { connectMs: override, firstAudioMs: override, idleMs: override };
  return { connectMs: 8_000, firstAudioMs: 12_000, idleMs: 12_000 };
}

export const DEFAULT_AGENT_VOICE = "en-US-GuyNeural";

/** Seconds to add to the local clock (learned from the service's Date header on a 403). */
let clockSkewSeconds = 0;

export function _resetClockSkewForTests(): void {
  clockSkewSeconds = 0;
}

function wssUrl(): string {
  // Tests point this at a local stand-in; never set it in production.
  return process.env.EDGE_TTS_WSS_URL || DEFAULT_WSS_URL;
}

/** node-edge-tts only knows Microsoft's real endpoint, so it can't back up a custom one. */
function secondEngineAvailable(): boolean {
  return !process.env.EDGE_TTS_WSS_URL;
}

/** Sec-MS-GEC: SHA-256 of (Windows file-time ticks rounded down to 5 minutes + client token). */
export function generateSecMsGec(nowMs = Date.now()): string {
  const seconds = BigInt(Math.floor(nowMs / 1000 + clockSkewSeconds)) + WIN_EPOCH_SECONDS;
  const ticks = seconds * 10_000_000n;
  const rounded = ticks - (ticks % 3_000_000_000n);
  return createHash("sha256").update(`${rounded}${TRUSTED_CLIENT_TOKEN}`, "ascii").digest("hex").toUpperCase();
}

/** "Sun Sep 28 2026 01:07:42 GMT+0000 (Coordinated Universal Time)" — the format Edge sends. */
function edgeTimestamp(d = new Date()): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

const VOICE_ID = /^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z0-9-]*Neural$/;

/** A well-formed Edge voice id ("en-US-GuyNeural"), else `fallback`. */
export function normalizeVoiceId(voice: unknown, fallback = DEFAULT_AGENT_VOICE): string {
  const v = typeof voice === "string" ? voice.trim() : "";
  return VOICE_ID.test(v) ? v : fallback;
}

/** "en-US-GuyNeural" → "Microsoft Server Speech Text to Speech Voice (en-US, GuyNeural)". */
export function longVoiceName(voice: string): string {
  const m = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(voice);
  if (!m) return voice;
  let region = m[2]!;
  let name = m[3]!;
  const dash = name.indexOf("-");
  if (dash !== -1) {
    region = `${region}-${name.slice(0, dash)}`;
    name = name.slice(dash + 1);
  }
  return `Microsoft Server Speech Text to Speech Voice (${m[1]}-${region}, ${name})`;
}

/** "en-US-ChristopherNeural" → "en-US". */
function langFor(voice: string): string {
  const m = /^[a-z]{2,3}-[A-Z]{2,3}/.exec(voice);
  return m ? m[0] : "en-US";
}

/**
 * A small pause at every sentence end — the single biggest "sounds like a
 * person, not a reader" win in the free Edge voices. Applied to already-escaped
 * text, so the tags survive.
 */
export function withSentencePauses(escaped: string): string {
  return escaped.replace(/([.!?])\s+(?=[^<])/g, '$1 <break time="170ms"/> ');
}

function escapeXml(text: string): string {
  return text
    // Control characters the service rejects.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Format raw script into natural, human-paced conversational delivery:
 * - Adds pauses after provocative hooks ("Did you know that...", "Here's the truth:")
 * - Adds clear breathing marks after numbers and list items
 * - Ensures sentence boundaries have distinct rhythmic cadence
 */
export function formatNaturalSpeechPacing(text: string): string {
  let paced = text
    // Symbols and abbreviations that read badly out loud.
    .replace(/\s*[→➔➜]\s*/g, " to ")
    .replace(/\s*(?:->|=>)\s*/g, " to ")
    .replace(/&/g, " and ")
    .replace(/\b(?:e\.g\.|eg\.)\s*,?/gi, "for example ")
    .replace(/\b(?:i\.e\.|ie\.)\s*,?/gi, "that is ")
    .replace(/\betc\./gi, "and so on")
    .replace(/\bvs\.?\b/gi, "versus")
    // "Settings → Brain" style labels, bullets and em-dashes become pauses.
    .replace(/^\s*[•·▪●︎-]\s+/gm, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/(\d+)\.\s+/g, "$1: ")
    .replace(/\b(Did you know that)\b/gi, "$1...")
    .replace(/\b(Believe it or not)\b/gi, "$1,")
    .replace(/\b(The truth is)\b/gi, "$1...")
    .replace(/\b(Here is why|Here's why)\b/gi, "$1:")
    .replace(/\b(In fact)\b/gi, "$1,")
    .replace(/\b(However)\b/gi, "$1,")
    .replace(/\b(Specifically)\b/gi, "$1,")
    .replace(/\b(Think about this)\b/gi, "$1...")
    .trim();

  if (!/[.!?:]$/.test(paced)) {
    paced += ".";
  }
  return paced;
}

/** Speed multiplier → SSML rate ("+0%", "-5%"). Default 0.95 = relaxed narrator cadence. */
function rateString(speed: number | undefined): string {
  const pct = Math.round(((speed ?? 0.95) - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function pitchString(pitch: number | undefined): string {
  if (pitch == null || pitch === 0) return "+0Hz";
  const pct = Math.round(Math.min(50, Math.max(-50, pitch)));
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function volumeString(volume: number | undefined): string {
  if (volume == null || volume >= 100) return "+0%";
  const pct = Math.round(Math.min(0, Math.max(-100, volume - 100)));
  return `${pct}%`;
}

/** Split long text at sentence (then word) boundaries into service-sized chunks. */
export function splitForSynthesis(text: string, max = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf("\n"));
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut < max * 0.3) cut = max - 1;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ── Errors ──────────────────────────────────────────────────────────────────
export type EdgeTtsErrorKind = "network" | "handshake" | "protocol" | "timeout" | "aborted";

export class EdgeTtsError extends Error {
  constructor(
    public readonly kind: EdgeTtsErrorKind,
    message: string,
    public readonly status?: number,
    public readonly serverDate?: string,
  ) {
    super(message);
    this.name = "EdgeTtsError";
  }
}

function networkError(err: Error & { code?: string }): EdgeTtsError {
  const code = err.code ? ` (${err.code})` : "";
  if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
    return new EdgeTtsError("network", `Microsoft's voice service couldn't be found${code} — is this computer online?`);
  }
  return new EdgeTtsError("network", `Couldn't connect to Microsoft's voice service${code}: ${err.message}`);
}

// ── Voice service health (shown by the app when speech fails) ───────────────
interface VoiceHealth {
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
}

const health: VoiceHealth = { lastError: null, lastErrorAt: null, lastSuccessAt: null };

function noteSuccess(): void {
  health.lastError = null;
  health.lastErrorAt = null;
  health.lastSuccessAt = new Date().toISOString();
}

function noteFailure(err: unknown): void {
  if (err instanceof EdgeTtsError && err.kind === "aborted") return;
  health.lastError = err instanceof Error ? err.message : String(err);
  health.lastErrorAt = new Date().toISOString();
}

export function getVoiceHealth(): VoiceHealth & { ok: boolean } {
  return { ...health, ok: health.lastError === null };
}

// ── One request over the Edge WebSocket protocol ────────────────────────────
interface Prosody {
  rate: string;
  pitch: string;
  volume: string;
}

interface ChunkResult {
  audio: Buffer[];
  bytes: number;
  words: EdgeWordTiming[];
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function synthesizeChunk(
  text: string,
  voice: string,
  prosody: Prosody,
  opts: { signal?: AbortSignal; onAudio?: (chunk: Buffer) => void },
): Promise<ChunkResult> {
  return new Promise<ChunkResult>((resolve, reject) => {
    const connectionId = randomUUID().replace(/-/g, "");
    const url =
      `${wssUrl()}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${connectionId}` +
      `&Sec-MS-GEC=${generateSecMsGec()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    const result: ChunkResult = { audio: [], bytes: 0, words: [] };
    const limits = timeouts();
    let settled = false;
    let opened = false;
    let timer: NodeJS.Timeout | undefined;

    const ws = new WebSocket(url, {
      origin: ORIGIN,
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        "User-Agent": USER_AGENT,
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: `muid=${randomBytes(16).toString("hex").toUpperCase()};`,
      },
      perMessageDeflate: true,
      handshakeTimeout: limits.connectMs,
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      ws.removeAllListeners("message");
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
    };
    const fail = (err: EdgeTtsError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const arm = (ms: number, what: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => fail(new EdgeTtsError(opened ? "timeout" : "network", `Microsoft's voice service didn't respond (${what}).`)),
        ms,
      );
    };
    function onAbort() {
      fail(new EdgeTtsError("aborted", "Speech was cancelled."));
    }

    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    arm(limits.connectMs + 1_000, "connecting");

    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      const date = typeof res.headers.date === "string" ? res.headers.date : undefined;
      res.resume();
      fail(new EdgeTtsError("handshake", `Microsoft's voice service refused the connection (HTTP ${status}).`, status, date));
    });

    ws.on("error", (err) => fail(networkError(err as Error & { code?: string })));

    ws.on("open", () => {
      opened = true;
      const timestamp = edgeTimestamp();
      ws.send(
        `X-Timestamp:${timestamp}\r\n` +
          "Content-Type:application/json; charset=utf-8\r\n" +
          "Path:speech.config\r\n\r\n" +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
          '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
          `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`,
      );
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${langFor(voice)}'>` +
        `<voice name='${longVoiceName(voice)}'>` +
        `<prosody pitch='${prosody.pitch}' rate='${prosody.rate}' volume='${prosody.volume}'>` +
        `${withSentencePauses(escapeXml(text))}` +
        "</prosody></voice></speak>";
      ws.send(
        `X-RequestId:${randomUUID().replace(/-/g, "")}\r\n` +
          "Content-Type:application/ssml+xml\r\n" +
          // The trailing "Z" is what Edge itself sends.
          `X-Timestamp:${timestamp}Z\r\n` +
          "Path:ssml\r\n\r\n" +
          ssml,
      );
      arm(limits.firstAudioMs, "no audio");
    });

    ws.on("message", (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (isBinary) {
        if (buf.length < 2) return;
        const headerLength = buf.readUInt16BE(0);
        const headers = parseHeaders(buf.subarray(2, 2 + headerLength).toString("utf8"));
        if (headers.path !== "audio") return;
        const payload = buf.subarray(2 + headerLength);
        if (payload.length === 0) return;
        result.audio.push(payload);
        result.bytes += payload.length;
        arm(limits.idleMs, "audio stalled");
        try {
          opts.onAudio?.(payload);
        } catch {
          // The listener went away (e.g. the app stopped playback).
          fail(new EdgeTtsError("aborted", "Speech was cancelled."));
        }
        return;
      }
      const message = buf.toString("utf8");
      const split = message.indexOf("\r\n\r\n");
      const headers = parseHeaders(split >= 0 ? message.slice(0, split) : message);
      const body = split >= 0 ? message.slice(split + 4) : "";
      switch (headers.path) {
        case "turn.end":
          if (result.bytes === 0) {
            fail(new EdgeTtsError("protocol", `No audio came back for the voice "${voice}".`));
          } else {
            finish();
          }
          return;
        case "audio.metadata":
          try {
            const meta = JSON.parse(body) as {
              Metadata?: Array<{ Type?: string; Data?: { Offset?: number; Duration?: number; text?: { Text?: string } } }>;
            };
            for (const m of meta.Metadata ?? []) {
              if (m.Type !== "WordBoundary" || !m.Data) continue;
              const word = String(m.Data.text?.Text ?? "").trim();
              if (!word) continue;
              const start = (m.Data.Offset ?? 0) / 1e7;
              result.words.push({ word, start, end: start + (m.Data.Duration ?? 0) / 1e7 });
            }
          } catch {
            /* word timings are best-effort */
          }
          arm(limits.idleMs, "audio stalled");
          return;
        default:
          arm(limits.idleMs, "audio stalled");
      }
    });

    ws.on("close", (code, reason) => {
      if (settled) return;
      const why = reason?.length ? `: ${reason.toString()}` : "";
      fail(new EdgeTtsError(opened ? "protocol" : "network", `Microsoft's voice service closed the connection early (code ${code}${why}).`));
    });
  });
}

/** Learn the clock offset from the service's Date header (Sec-MS-GEC is time-based). */
function adjustClockSkew(serverDate: string | undefined): boolean {
  const server = serverDate ? Date.parse(serverDate) : NaN;
  if (!Number.isFinite(server)) return false;
  clockSkewSeconds = (server - Date.now()) / 1000;
  return true;
}

async function synthesizeChunkWithSkewRetry(
  text: string,
  voice: string,
  prosody: Prosody,
  opts: { signal?: AbortSignal; onAudio?: (chunk: Buffer) => void },
): Promise<ChunkResult> {
  try {
    return await synthesizeChunk(text, voice, prosody, opts);
  } catch (err) {
    // A 403 usually means this PC's clock is off (the token is time-based):
    // retry once with the service's clock, like the Edge client does.
    if (err instanceof EdgeTtsError && err.kind === "handshake" && err.status === 403 && adjustClockSkew(err.serverDate)) {
      return synthesizeChunk(text, voice, prosody, opts);
    }
    throw err;
  }
}

interface RawSynthesis {
  audio: Buffer;
  words: EdgeWordTiming[];
  duration: number;
}

/** Primary engine: direct WebSocket client, streaming each audio chunk to `onAudio`. */
async function synthesizeDirect(
  text: string,
  voice: string,
  prosody: Prosody,
  opts: { signal?: AbortSignal; onAudio?: (chunk: Buffer) => void },
): Promise<RawSynthesis> {
  const parts: Buffer[] = [];
  const words: EdgeWordTiming[] = [];
  let offset = 0;
  for (const chunk of splitForSynthesis(text)) {
    const r = await synthesizeChunkWithSkewRetry(chunk, voice, prosody, opts);
    for (const w of r.words) words.push({ word: w.word, start: w.start + offset, end: w.end + offset });
    parts.push(...r.audio);
    offset += r.bytes / MP3_BYTES_PER_SECOND;
  }
  const audio = Buffer.concat(parts);
  const lastWordEnd = words.length ? words[words.length - 1]!.end : 0;
  return { audio, words, duration: Math.max(audio.length / MP3_BYTES_PER_SECOND, lastWordEnd) };
}

/** Second engine: node-edge-tts (no streaming). */
async function synthesizeLegacy(text: string, voice: string, prosody: Prosody): Promise<RawSynthesis> {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "swtts-"));
  const audioPath = path.join(dir, "out.mp3");
  try {
    const tts = new LegacyEdgeTTS({
      voice,
      lang: langFor(voice),
      outputFormat: OUTPUT_FORMAT,
      saveSubtitles: true,
      rate: prosody.rate,
      pitch: prosody.pitch,
      volume: prosody.volume,
      timeout: 20_000,
    });
    await tts.ttsPromise(text, audioPath);
    const audio = fs.readFileSync(audioPath);
    if (audio.length === 0) throw new Error("the second voice engine returned no audio");
    const words: EdgeWordTiming[] = [];
    try {
      const cues = JSON.parse(fs.readFileSync(`${audioPath}.json`, "utf8")) as Array<{ part: string; start: number; end: number }>;
      for (const c of cues) {
        const word = String(c.part ?? "").trim();
        if (word) words.push({ word, start: c.start / 1000, end: c.end / 1000 });
      }
    } catch {
      /* word timings are best-effort */
    }
    const lastWordEnd = words.length ? words[words.length - 1]!.end : 0;
    return { audio, words, duration: Math.max(audio.length / MP3_BYTES_PER_SECOND, lastWordEnd) };
  } catch (err) {
    throw new EdgeTtsError("protocol", `Second voice engine failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Errors where the second engine might still succeed (the service answered, but not our client). */
function worthSecondEngine(err: unknown): boolean {
  return err instanceof EdgeTtsError && (err.kind === "handshake" || err.kind === "protocol" || err.kind === "timeout");
}

async function synthesizeOnce(
  text: string,
  voice: string,
  prosody: Prosody,
  opts: { signal?: AbortSignal; onAudio?: (chunk: Buffer) => void },
): Promise<RawSynthesis> {
  let streamed = false;
  const onAudio = opts.onAudio
    ? (chunk: Buffer) => {
        streamed = true;
        opts.onAudio!(chunk);
      }
    : undefined;
  try {
    return await synthesizeDirect(text, voice, prosody, { signal: opts.signal, onAudio });
  } catch (err) {
    // Half a reply was already streamed: don't restart it with another engine.
    if (streamed || opts.signal?.aborted || !worthSecondEngine(err) || !secondEngineAvailable()) throw err;
    console.warn(`[voice] direct Edge TTS client failed (${(err as Error).message}); trying node-edge-tts`);
    const legacy = await synthesizeLegacy(text, voice, prosody);
    opts.onAudio?.(legacy.audio);
    return legacy;
  }
}

function friendlyFailure(err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err);
  return new Error(`Couldn't reach the Soundwave voice service (Microsoft neural voices): ${reason}`);
}

/**
 * Synthesize text with a Soundwave (Microsoft Edge neural) voice.
 * Retries with backoff; throws a readable Error when the service can't be used.
 */
export async function synthesizeEdgeTTS(input: EdgeVoiceInput, options: EdgeSynthOptions = {}): Promise<EdgeSynthResult> {
  const voice = normalizeVoiceId(input.voice, "en-US-ChristopherNeural");
  const text = options.pacing === false ? input.text.replace(/\s+/g, " ").trim() : formatNaturalSpeechPacing(input.text);
  const prosody: Prosody = { rate: rateString(input.speed), pitch: pitchString(input.pitch), volume: volumeString(input.volume) };
  const attempts = Math.max(1, options.attempts ?? 3);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await synthesizeOnce(text, voice, prosody, { signal: options.signal });
      noteSuccess();
      return { audioBase64: r.audio.toString("base64"), mimeType: "audio/mpeg", duration: r.duration, wordTimings: r.words };
    } catch (err) {
      lastError = err;
      if (options.signal?.aborted || (err instanceof EdgeTtsError && err.kind === "aborted")) break;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  noteFailure(lastError);
  if (lastError instanceof EdgeTtsError && lastError.kind === "aborted") throw lastError;
  throw friendlyFailure(lastError);
}

/**
 * Stream speech: `onAudio` receives MP3 chunks as Microsoft produces them, so
 * playback can start immediately. One attempt (a live reply shouldn't wait on
 * retries). Resolves once the whole utterance has been delivered.
 */
export async function streamEdgeTTS(
  input: { text: string; voice: string; speed?: number; pacing?: boolean },
  opts: { onAudio: (chunk: Buffer) => void; signal?: AbortSignal },
): Promise<{ bytes: number; duration: number }> {
  const voice = normalizeVoiceId(input.voice);
  const text = input.pacing === false ? input.text.replace(/\s+/g, " ").trim() : formatNaturalSpeechPacing(input.text);
  const prosody: Prosody = { rate: rateString(input.speed), pitch: "+0Hz", volume: "+0%" };
  try {
    const r = await synthesizeOnce(text, voice, prosody, opts);
    noteSuccess();
    return { bytes: r.audio.length, duration: r.duration };
  } catch (err) {
    noteFailure(err);
    throw err;
  }
}

/** Regenerate one voice sample clip (scripts/generate-samples.ts). */
export async function synthesizeSample(text: string, voice: string): Promise<Buffer> {
  const r = await synthesizeEdgeTTS({ text, voice, speed: 0.95 });
  return Buffer.from(r.audioBase64, "base64");
}
