// ── Voice input: microphone → 16 kHz WAV → text ─────────────────────────────
// Records from the microphone (AudioWorklet), watches the level to notice
// when the speaker starts and stops talking, and encodes the speech as a
// 16 kHz mono WAV. The server transcribes it locally with whisper.cpp
// (POST /api/v1/agent/transcribe) — nothing goes to a cloud service.

import { getDesktop } from "./desktop";

const WORKLET_URL = "/audio/soundwave-recorder.worklet.js";
const TARGET_RATE = 16_000;

// ── Preferences (shared by the Command Center, the voice bar and Settings) ──

export interface VoicePrefs {
  /** Tap-to-talk sends by itself once you stop talking. */
  autoStop: boolean;
  /** Short tones when listening starts / stops. */
  earcons: boolean;
  /** The agent reads its replies aloud. */
  speakReplies: boolean;
}

const PREF_KEYS: Record<keyof VoicePrefs, string> = {
  autoStop: "soundwave_voice_autostop",
  earcons: "soundwave_voice_earcons",
  speakReplies: "soundwave_speak_replies",
};
export const VOICE_PREFS_EVENT = "soundwave:voice-prefs";

export function loadVoicePrefs(): VoicePrefs {
  const read = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  return {
    autoStop: read(PREF_KEYS.autoStop) !== "0",
    earcons: read(PREF_KEYS.earcons) !== "0",
    speakReplies: read(PREF_KEYS.speakReplies) !== "0",
  };
}

export function saveVoicePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
  for (const [k, v] of Object.entries(patch) as Array<[keyof VoicePrefs, boolean]>) {
    try {
      localStorage.setItem(PREF_KEYS[k], v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }
  const prefs = loadVoicePrefs();
  window.dispatchEvent(new CustomEvent(VOICE_PREFS_EVENT, { detail: prefs }));
  return prefs;
}

/** Keys whose change (in any window) means the prefs changed. */
export function isVoicePrefKey(key: string | null): boolean {
  return key !== null && Object.values(PREF_KEYS).includes(key);
}

// ── Errors a person can act on ──────────────────────────────────────────────

export type VoiceErrorCode = "unsupported" | "denied" | "no-device" | "busy" | "engine" | "failed";

export class VoiceInputError extends Error {
  constructor(
    readonly code: VoiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VoiceInputError";
  }
}

function microphoneError(err: unknown): VoiceInputError {
  const name = (err as { name?: string })?.name ?? "";
  const desktop = Boolean(getDesktop());
  const privacy = "Windows Settings → Privacy & security → Microphone → turn on “Microphone access” and “Let desktop apps access your microphone”.";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return new VoiceInputError(
      "denied",
      desktop
        ? `Windows is blocking the microphone. ${privacy}`
        : "Microphone access was blocked. Allow it for this site (the icon left of the address bar), then try again.",
    );
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return new VoiceInputError("no-device", "No microphone found. Plug one in, or enable it in Windows sound settings.");
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return new VoiceInputError(
      "busy",
      desktop
        ? `The microphone couldn't start — another app may be using it, or Windows privacy settings block it (${privacy})`
        : "The microphone couldn't start — another app may be using it.",
    );
  }
  return new VoiceInputError("failed", `The microphone couldn't start: ${(err as Error)?.message || name || "unknown error"}`);
}

// ── Recording ───────────────────────────────────────────────────────────────

export type StopReason = "manual" | "silence" | "max" | "no-speech";

export interface RecorderOptions {
  /** Where the recorder worklet is served (the phone app bundles its own copy). */
  workletUrl?: string;
  /** Stop by itself once the speaker goes quiet (tap-to-talk). Push-to-talk passes false. */
  autoStop?: boolean;
  /** Quiet time after speech that ends a tap-to-talk command. */
  silenceMs?: number;
  /** Hard limit for one recording. */
  maxMs?: number;
  /** Tap-to-talk gives up after this long without any speech. */
  noSpeechMs?: number;
  /** Microphone level 0…1, about 15× a second. */
  onLevel?: (level: number) => void;
  /** Speech was detected for the first time. */
  onSpeech?: () => void;
  /** The recorder wants to stop (silence / time limit) — call `stop(reason)`. */
  onAutoStop?: (reason: StopReason) => void;
}

export interface Recording {
  wav: Blob;
  durationMs: number;
  hadSpeech: boolean;
  reason: StopReason;
}

export interface Recorder {
  stop(reason?: StopReason): Promise<Recording>;
  cancel(): void;
  /** Switch end-of-speech detection on/off mid-recording (a tap that became a hold). */
  setAutoStop(on: boolean): void;
}

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function voiceInputSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(audioContextCtor());
}

export async function startRecording(opts: RecorderOptions = {}): Promise<Recorder> {
  const Ctor = audioContextCtor();
  if (!navigator.mediaDevices?.getUserMedia || !Ctor) {
    throw new VoiceInputError("unsupported", "Voice input needs the Soundwave desktop app or a secure (https) page in a modern browser.");
  }
  let autoStop = Boolean(opts.autoStop);
  const silenceMs = opts.silenceMs ?? 1300;
  const maxMs = opts.maxMs ?? 30_000;
  const noSpeechMs = opts.noSpeechMs ?? 7000;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    throw microphoneError(err);
  }

  const ctx = new Ctor();
  const rate = ctx.sampleRate;
  const source = ctx.createMediaStreamSource(stream);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  const chunks: Float32Array[] = [];
  let total = 0;
  let stopped = false;
  let autoStopSent = false;
  // Level / speech tracking (dBFS).
  let floorDb = -55;
  let speechRunMs = 0;
  let speechStart = -1;
  let lastSpeech = -1;
  let lastLevelAt = 0;
  const ignoreFirst = Math.round(rate * 0.18); // the start tone / click
  // localStorage.soundwave_voice_debug = "1" → level/decision trace in the console.
  const debug = (() => {
    try {
      return localStorage.getItem("soundwave_voice_debug") === "1";
    } catch {
      return false;
    }
  })();
  let lastDebugAt = 0;

  const requestStop = (reason: StopReason) => {
    if (autoStopSent) return;
    autoStopSent = true;
    opts.onAutoStop?.(reason);
  };

  const onChunk = (data: Float32Array) => {
    if (stopped || data.length === 0) return;
    chunks.push(data);
    total += data.length;

    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
    const db = 10 * Math.log10(sum / data.length + 1e-12);
    const ms = (data.length / rate) * 1000;

    const now = performance.now();
    if (opts.onLevel && now - lastLevelAt > 60) {
      lastLevelAt = now;
      opts.onLevel(Math.max(0, Math.min(1, (db + 60) / 48)));
    }

    const threshold = Math.max(floorDb + 12, -48);
    const isSpeech = total > ignoreFirst && db > threshold;
    if (isSpeech) {
      speechRunMs += ms;
      lastSpeech = total;
      if (speechStart < 0 && speechRunMs >= 120) {
        speechStart = Math.max(0, total - Math.round((speechRunMs / 1000) * rate));
        opts.onSpeech?.();
      }
      floorDb = floorDb * 0.998 + db * 0.002;
    } else {
      speechRunMs = Math.max(0, speechRunMs - ms * 0.5);
      floorDb = db < floorDb ? floorDb * 0.7 + db * 0.3 : floorDb * 0.95 + db * 0.05;
    }
    floorDb = Math.max(-80, Math.min(-30, floorDb));

    const elapsed = (total / rate) * 1000;
    if (debug && now - lastDebugAt > 250) {
      lastDebugAt = now;
      console.debug(
        `[voice] t=${Math.round(elapsed)}ms db=${db.toFixed(1)} floor=${floorDb.toFixed(1)} thr=${threshold.toFixed(1)} speech=${isSpeech} started=${speechStart >= 0} quietFor=${lastSpeech >= 0 ? Math.round(((total - lastSpeech) / rate) * 1000) : -1}ms autoStop=${autoStop}`,
      );
    }
    if (elapsed >= maxMs) requestStop("max");
    else if (autoStop && speechStart >= 0 && ((total - lastSpeech) / rate) * 1000 >= silenceMs) requestStop("silence");
    else if (autoStop && speechStart < 0 && elapsed >= noSpeechMs) requestStop("no-speech");
  };

  let node: AudioNode;
  if (debug) console.debug(`[voice] microphone open (${rate} Hz, context ${ctx.state})`);
  try {
    await ctx.audioWorklet.addModule(opts.workletUrl ?? WORKLET_URL);
    const worklet = new AudioWorkletNode(ctx, "soundwave-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    worklet.port.onmessage = (e: MessageEvent<Float32Array>) => onChunk(e.data);
    node = worklet;
  } catch {
    // Older engines: the deprecated ScriptProcessor still works everywhere.
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    node = processor;
  }
  source.connect(node);
  node.connect(mute);
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  if (debug) console.debug(`[voice] recording (${node instanceof AudioWorkletNode ? "AudioWorklet" : "ScriptProcessor"}, context ${ctx.state})`);

  const release = () => {
    stopped = true;
    try {
      source.disconnect();
      node.disconnect();
      mute.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const track of stream.getTracks()) track.stop();
    void ctx.close().catch(() => undefined);
  };

  return {
    cancel: release,
    setAutoStop(on: boolean) {
      autoStop = on;
    },
    async stop(reason: StopReason = "manual"): Promise<Recording> {
      if (stopped) throw new VoiceInputError("failed", "This recording was already finished.");
      release();
      const all = new Float32Array(total);
      let offset = 0;
      for (const c of chunks) {
        all.set(c, offset);
        offset += c.length;
      }
      const hadSpeech = speechStart >= 0;
      // Keep a little air around the speech; drop long leading/trailing silence.
      const from = hadSpeech ? Math.max(0, speechStart - Math.round(rate * 0.3)) : 0;
      const to = hadSpeech ? Math.min(total, lastSpeech + Math.round(rate * 0.45)) : total;
      const speech = all.subarray(from, Math.max(from, to));
      const pcm16k = await resample(speech, rate, TARGET_RATE);
      return {
        wav: encodeWav(pcm16k, TARGET_RATE),
        durationMs: Math.round((pcm16k.length / TARGET_RATE) * 1000),
        hadSpeech,
        reason,
      };
    },
  };
}

/** High-quality resampling through the browser's own resampler. */
export async function resampleAudio(samples: Float32Array, from: number, to: number): Promise<Float32Array> {
  return resample(samples, from, to);
}

async function resample(samples: Float32Array, from: number, to: number): Promise<Float32Array> {
  if (samples.length === 0) return new Float32Array(0);
  if (from === to) return samples.slice();
  const frames = Math.max(1, Math.ceil((samples.length * to) / from));
  const offline = new OfflineAudioContext(1, frames, to);
  const buffer = offline.createBuffer(1, samples.length, from);
  buffer.getChannelData(0).set(samples);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

// ── Transcription (local whisper.cpp on the server) ─────────────────────────

export interface Transcript {
  text: string;
  noSpeech: boolean;
  durationMs: number;
  elapsedMs: number;
  model: string;
}

export interface VoiceInputStatus {
  available: boolean;
  engine: string;
  model: string | null;
  reason: string | null;
  lastError: string | null;
}

export async function transcribeRecording(wav: Blob, signal?: AbortSignal): Promise<Transcript> {
  let res: Response;
  try {
    res = await fetch("/api/v1/agent/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav, signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new VoiceInputError("failed", "Couldn't reach Soundwave's speech engine.");
  }
  const data = (await res.json().catch(() => null)) as (Transcript & { error?: { message?: string } }) | null;
  if (!res.ok || !data) {
    const message = data?.error?.message || `Transcription failed (HTTP ${res.status}).`;
    throw new VoiceInputError(res.status === 503 ? "engine" : "failed", message);
  }
  return data;
}

export async function fetchVoiceInputStatus(): Promise<VoiceInputStatus | null> {
  try {
    const res = await fetch("/api/v1/agent/transcribe/status");
    return res.ok ? ((await res.json()) as VoiceInputStatus) : null;
  } catch {
    return null;
  }
}

// ── Sound cues ──────────────────────────────────────────────────────────────

let cueContext: AudioContext | null = null;

/** A soft two-note chime: rising = listening, falling = got it, low = problem. */
export function playEarcon(kind: "start" | "stop" | "error"): void {
  if (!loadVoicePrefs().earcons) return;
  try {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    cueContext ??= new Ctor();
    const ctx = cueContext;
    void ctx.resume().catch(() => undefined);
    const notes = kind === "start" ? [660, 990] : kind === "stop" ? [880, 660] : [330, 247];
    const now = ctx.currentTime + 0.01;
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.085;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.15);
    });
  } catch {
    /* sound cues are optional */
  }
}
