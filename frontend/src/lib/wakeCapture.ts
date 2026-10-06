// ── Listening for "Hey Soundwave" without sending anything anywhere ─────────
// The hidden wake window (pages/WakeListener.tsx) keeps the microphone open and
// this turns the stream into utterances: speech starts, speech stops, and there
// is one short 16 kHz WAV. That WAV goes to whisper.cpp *on this PC* (the same
// local engine voice input uses); the transcript is handed to the shell, which
// decides whether the wake phrase was in it. Nothing is uploaded, nothing is
// stored, and an utterance that wasn't the phrase is thrown away.
//
// It is deliberately a phrase check on a real transcript rather than a trained
// wake-word model: no extra download, no account, and what it heard is a
// sentence you could read. The cost is a little CPU while you talk (whisper
// base.en on a few seconds of audio), so the shell pauses the whole listener
// whenever Soundwave itself is recording or speaking.

import { encodeWav, resampleAudio, VoiceInputError } from "./voiceInput";

const TARGET_RATE = 16_000;
const WORKLET_URL = "/audio/soundwave-recorder.worklet.js";

/** Speech shorter than this isn't a phrase; a pause this long ends an utterance. */
const SPEECH_MIN_MS = 250;
const SPEECH_END_MS = 600;
/** An utterance is cut at this length and checked in pieces (a long monologue). */
export const MAX_UTTERANCE_MS = 8000;
const IGNORE_FIRST_MS = 300;

export interface WakeUtterance {
  wav: Blob;
  seconds: number;
}

export interface WakeListenerHandlers {
  /** One utterance, ready to be transcribed locally. */
  onUtterance: (utterance: WakeUtterance) => void;
  onError: (error: Error) => void;
}

export interface WakeListener {
  /** The microphone and the audio graph are released; the microphone light goes out. */
  stop: () => void;
  /** True while the microphone is really open and audio is flowing. */
  running: () => boolean;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function microphoneError(err: unknown): VoiceInputError {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return new VoiceInputError(
      "denied",
      "Windows is blocking the microphone. Windows Settings → Privacy & security → Microphone → turn on “Microphone access” and “Let desktop apps access your microphone”.",
    );
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return new VoiceInputError("no-device", "No microphone found, so “Hey Soundwave” can't work. Plug one in, or turn the wake word off.");
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return new VoiceInputError("busy", "The microphone is being used by another app and Windows wouldn't share it.");
  }
  return new VoiceInputError("failed", (err as Error)?.message || "The microphone couldn't be opened.");
}

/**
 * Open the microphone and call `onUtterance` for each burst of speech. Throws a
 * VoiceInputError with a sentence a person can act on when it can't listen.
 */
export async function startWakeListener(handlers: WakeListenerHandlers): Promise<WakeListener> {
  const Ctor = audioContextCtor();
  if (!navigator.mediaDevices?.getUserMedia || !Ctor) {
    throw new VoiceInputError("unsupported", "Listening for the wake word needs the Soundwave desktop app.");
  }

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

  let stopped = false;
  // Adaptive noise floor, as in the recorder: a room's hum is not speech.
  let floorDb = -55;
  let speechRunMs = 0;
  let speechStart = -1;
  let lastSpeech = -1;
  let total = 0;
  const chunks: Float32Array[] = [];

  const releaseGraph = () => {
    if (stopped) return;
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

  const cut = async (fromSample: number, toSample: number) => {
    const from = Math.max(0, fromSample);
    const to = Math.min(total, Math.max(from, toSample));
    if (to - from < (rate * SPEECH_MIN_MS) / 1000) return;
    const audio = take(from, to);
    const pcm = await resampleAudio(audio, rate, TARGET_RATE);
    if (stopped || pcm.length < (TARGET_RATE * SPEECH_MIN_MS) / 1000) return;
    handlers.onUtterance({ wav: encodeWav(pcm, TARGET_RATE), seconds: pcm.length / TARGET_RATE });
  };

  /** Slice of everything heard so far (the buffer is trimmed as it's consumed). */
  let bufferStart = 0;
  function take(from: number, to: number): Float32Array {
    const out = new Float32Array(to - from);
    let written = 0;
    let index = bufferStart;
    for (const chunk of chunks) {
      const chunkStart = index;
      const chunkEnd = index + chunk.length;
      index = chunkEnd;
      if (chunkEnd <= from || chunkStart >= to) continue;
      const sliceStart = Math.max(0, from - chunkStart);
      const sliceEnd = Math.min(chunk.length, to - chunkStart);
      out.set(chunk.subarray(sliceStart, sliceEnd), written);
      written += sliceEnd - sliceStart;
    }
    return out;
  }

  function forget(upTo: number) {
    // Drop whole chunks that are entirely behind `upTo`.
    let index = bufferStart;
    while (chunks.length && index + chunks[0]!.length <= upTo) {
      index += chunks[0]!.length;
      chunks.shift();
    }
    bufferStart = index;
  }

  const onChunk = (data: Float32Array) => {
    if (stopped || data.length === 0) return;
    chunks.push(data);
    total += data.length;
    // Never hold more than the longest utterance (+ a little) in memory.
    const keep = Math.round((rate * (MAX_UTTERANCE_MS + 2000)) / 1000);
    if (total - bufferStart > keep) forget(total - keep);

    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
    const db = 10 * Math.log10(sum / data.length + 1e-12);
    const ms = (data.length / rate) * 1000;
    const threshold = Math.max(floorDb + 12, -48);
    const isSpeech = (total / rate) * 1000 > IGNORE_FIRST_MS && db > threshold;

    if (isSpeech) {
      speechRunMs += ms;
      lastSpeech = total;
      if (speechStart < 0 && speechRunMs >= 120) speechStart = Math.max(bufferStart, total - Math.round((speechRunMs / 1000) * rate));
      floorDb = floorDb * 0.998 + db * 0.002;
    } else {
      speechRunMs = Math.max(0, speechRunMs - ms * 0.5);
      floorDb = db < floorDb ? floorDb * 0.7 + db * 0.3 : floorDb * 0.95 + db * 0.05;
    }
    floorDb = Math.max(-80, Math.min(-30, floorDb));

    if (speechStart >= 0) {
      const quietMs = ((total - lastSpeech) / rate) * 1000;
      const speechMs = ((lastSpeech - speechStart) / rate) * 1000;
      const longEnough = speechMs >= SPEECH_MIN_MS;
      const ended = quietMs >= SPEECH_END_MS || ((total - speechStart) / rate) * 1000 >= MAX_UTTERANCE_MS;
      if (ended && longEnough) {
        const from = Math.max(0, speechStart - Math.round(rate * 0.2));
        const to = Math.min(total, lastSpeech + Math.round(rate * 0.3));
        speechStart = -1;
        lastSpeech = -1;
        speechRunMs = 0;
        void cut(from, to);
      } else if (ended) {
        // A cough, a door: not speech worth sending anywhere.
        speechStart = -1;
        lastSpeech = -1;
        speechRunMs = 0;
      }
    }
  };

  let node: AudioNode;
  try {
    await ctx.audioWorklet.addModule(WORKLET_URL);
    const worklet = new AudioWorkletNode(ctx, "soundwave-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    worklet.port.onmessage = (e: MessageEvent<Float32Array>) => onChunk(e.data);
    node = worklet;
  } catch {
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    node = processor;
  }
  source.connect(node);
  node.connect(mute);
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);

  // A hidden window can have its audio context suspended by the engine; nudge it
  // back so the microphone keeps flowing while nobody is looking at it.
  const keeper = window.setInterval(() => {
    if (stopped) return;
    if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
  }, 2000);

  return {
    stop: () => {
      window.clearInterval(keeper);
      releaseGraph();
    },
    running: () => !stopped && ctx.state === "running",
  };
}
