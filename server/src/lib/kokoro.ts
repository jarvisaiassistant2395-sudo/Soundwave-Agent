// ── Kokoro: narration voices that run on the person's own PC ────────────────
// The Soundwave voices (Microsoft Edge neural) stay the default — this is the
// second engine, for when someone wants a voice that needs no internet, costs
// nothing per character, and never leaves their machine. Kokoro-82M is
// Apache-2.0 for code *and* weights (verified 2026-10-04), and its English G2P
// (misaki, Apache-2.0) runs without espeak-ng — which matters, because
// espeak-ng is GPL-3.0 and would otherwise be pulled into our service.
//
// It lives in the same optional local service as cloning (voiceclone/), so one
// process serves both engines. When the service isn't configured, nothing here
// touches the network and the app simply doesn't offer these voices.
//
// Voice ids are namespaced: "kokoro:af_heart". Anything without that prefix is
// a Microsoft voice and never reaches this module.

import fs from "node:fs";
import { config } from "../config.js";
import { ApiError } from "../middleware/error.js";
import { estimateWordTimings } from "./voiceclone.js";

export const LOCAL_VOICE_PREFIX = "kokoro:";

export interface LocalVoice {
  /** Short engine id, e.g. "af_heart". */
  id: string;
  /** Namespaced id used across the app, e.g. "kokoro:af_heart". */
  voiceId: string;
  displayName: string;
  gender: "Female" | "Male";
  accent: "American" | "British";
  /** The model's own default voice. */
  isDefault?: boolean;
}

export interface LocalVoiceSetupStatus {
  managed: true;
  phase: "checking" | "installing-python" | "installing-packages" | "loading-model" | "ready" | "failed" | string;
  message: string;
  progress?: number;
  progressLabel?: string;
  updatedAt?: string;
}

export interface LocalVoiceStatus {
  available: boolean;
  engine: "kokoro";
  /** Why it isn't available, in a sentence the UI can show as-is. */
  reason?: string;
  /** Packaged desktop setup progress, if it owns the local service. */
  setup?: LocalVoiceSetupStatus;
  /** Apache-2.0, stated where the UI can see it. */
  license?: string;
  voices: LocalVoice[];
}

export function isLocalVoiceId(voiceId: string | null | undefined): boolean {
  return typeof voiceId === "string" && voiceId.toLowerCase().startsWith(LOCAL_VOICE_PREFIX);
}

export function localVoiceShortId(voiceId: string): string {
  return isLocalVoiceId(voiceId) ? voiceId.slice(LOCAL_VOICE_PREFIX.length) : voiceId;
}

/** "kokoro:af_heart" → "Heart" — the name Kokoro itself gives that voice. */
export function localVoiceLabel(voiceId: string): string {
  const short = localVoiceShortId(voiceId);
  const name = short.split("_")[1] ?? short;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function serviceUrl(): string {
  return config.localVoiceUrl.replace(/\/+$/, "");
}

/** Is a local voice service configured at all? (No network call.) */
export function localEngineConfigured(): boolean {
  return serviceUrl().length > 0;
}

function authHeaders(): Record<string, string> {
  const token = config.localVoiceToken || config.voiceCloneToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function readManagedSetup(): LocalVoiceSetupStatus | undefined {
  if (!config.localVoiceStatusFile) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(config.localVoiceStatusFile, "utf8")) as Partial<LocalVoiceSetupStatus>;
    if (value.managed !== true || typeof value.phase !== "string" || typeof value.message !== "string") return undefined;
    return {
      managed: true,
      phase: value.phase,
      message: value.message.slice(0, 400),
      ...(Number.isFinite(value.progress) ? { progress: Math.max(0, Math.min(100, Number(value.progress))) } : {}),
      ...(typeof value.progressLabel === "string" ? { progressLabel: value.progressLabel.slice(0, 80) } : {}),
      ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

const UNCONFIGURED: LocalVoiceStatus = {
  available: false,
  engine: "kokoro",
  reason: "No local voice service is running. Start it with voiceclone/ (see the README) and set LOCAL_VOICE_URL.",
  voices: [],
};

let cached: { at: number; status: LocalVoiceStatus } | null = null;
const CACHE_MS = 5_000;

/**
 * Which local voices this install offers. Never throws: a service that is down
 * is a normal state the UI reports, not an error page.
 */
export async function getLocalVoiceStatus(options: { fresh?: boolean } = {}): Promise<LocalVoiceStatus> {
  const setup = readManagedSetup();
  if (!localEngineConfigured()) {
    return setup ? { ...UNCONFIGURED, reason: setup.message, setup } : UNCONFIGURED;
  }
  if (setup && setup.phase !== "ready") {
    // Failed/cancelled installs stay actionable in the UI instead of falling
    // through to a stale service cache or a second sidecar request.
    return { available: false, engine: "kokoro", reason: setup.message, setup, voices: [] };
  }
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.status;

  const fail = (reason: string): LocalVoiceStatus => {
    const status: LocalVoiceStatus = {
      available: false,
      engine: "kokoro",
      reason,
      ...(setup ? { setup } : {}),
      voices: [],
    };
    cached = { at: Date.now(), status };
    return status;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const res = await fetch(`${serviceUrl()}/tts/kokoro/voices`, { headers: authHeaders(), signal: controller.signal });
    if (!res.ok) return fail(`The local voice service answered ${res.status}. Check its log (voiceclone/).`);
    // The sidecar lists them as { id, name, gender, accent } — "name" is its
    // field; displayName is accepted too so either spelling works.
    type EngineVoice = { id: string; name?: string; displayName?: string; gender?: "Female" | "Male"; accent?: "American" | "British"; default?: boolean };
    const body = (await res.json()) as { available?: boolean; voices?: EngineVoice[] };
    const voices = (body.voices ?? []).map((v) => ({
      id: v.id,
      voiceId: `${LOCAL_VOICE_PREFIX}${v.id}`,
      displayName: v.displayName ?? v.name ?? v.id,
      gender: v.gender ?? "Female",
      accent: v.accent ?? "American",
      isDefault: v.default === true,   // the sidecar's field is `default`
    }));
    const status: LocalVoiceStatus = {
      available: body.available === true && voices.length > 0,
      engine: "kokoro",
      license: "Kokoro-82M — Apache-2.0 (code and weights)",
      ...(setup ? { setup } : {}),
      voices,
      ...(body.available === true && voices.length > 0
        ? {}
        : { reason: "The local voice service is running but the narration model isn't loaded on it (KOKORO_OFF, or its load failed — see its log)." }),
    };
    cached = { at: Date.now(), status };
    return status;
  } catch (err) {
    const reason =
      (err as Error)?.name === "AbortError"
        ? "The local voice service didn't answer in time. Is it still running?"
        : `The local voice service couldn't be reached (${(err as Error).message}).`;
    return fail(reason);
  } finally {
    clearTimeout(timer);
  }
}

export interface LocalSpeech {
  audioBase64: string;
  mimeType: string;
  duration: number;
  wordTimings: { word: string; start: number; end: number }[];
}

/**
 * Generate one clip on the local engine. Unlike cloning, a failure here is
 * simply a failure: the app says the local voice didn't work — it never
 * substitutes a different voice, because the person chose this one.
 */
export async function synthesizeLocalVoice(input: {
  text: string;
  voiceId: string;
  speed?: number;
}): Promise<LocalSpeech> {
  if (!localEngineConfigured()) {
    throw new ApiError(503, "LOCAL_VOICE_UNAVAILABLE", "No local voice service is running. Start it with voiceclone/ and set LOCAL_VOICE_URL.");
  }
  const voice = localVoiceShortId(input.voiceId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.voiceCloneTimeoutMs);
  let res: Response;
  try {
    res = await fetch(`${serviceUrl()}/tts/kokoro`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ text: input.text, voice, speed: input.speed ?? 1 }),
      signal: controller.signal,
    });
  } catch (err) {
    const message =
      (err as Error)?.name === "AbortError"
        ? "The local voice took too long to answer."
        : `The local voice service couldn't be reached (${(err as Error).message}).`;
    throw new ApiError(502, "LOCAL_VOICE_UNAVAILABLE", message);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: unknown) => (b as { detail?: string })?.detail)
      .catch(() => undefined);
    // 400/422 = the engine itself refused this request; say why, verbatim.
    throw new ApiError(res.status === 400 || res.status === 422 ? 400 : 502, "LOCAL_VOICE_FAILED", detail ?? `The local voice engine answered ${res.status}.`);
  }

  const audio = Buffer.from(await res.arrayBuffer());
  const duration = Number(res.headers.get("X-Audio-Duration")) || Math.max(0.5, input.text.length / 14);
  return {
    audioBase64: audio.toString("base64"),
    mimeType: res.headers.get("Content-Type") ?? "audio/wav",
    duration,
    // Kokoro doesn't return timings; the same weighted estimate cloning uses
    // keeps subtitle auto-cueing working.
    wordTimings: estimateWordTimings(input.text, duration),
  };
}
