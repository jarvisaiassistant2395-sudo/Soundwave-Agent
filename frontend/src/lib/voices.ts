import type { Accent, Gender, VoiceInfo } from "./types";

// ── The Soundwave voices (Microsoft Edge neural voices) ─────────────────────
// Speech is synthesized server-side (Microsoft's neural voices). This is the
// static list shown by the Voice Library, the Command Center's voice pickers
// and Settings. Samples are pre-generated MP3s served from
// /voice-samples/<voiceId>.mp3.

interface VoiceMeta {
  id: string;
  displayName: string;
  gender: Gender;
  accent: Accent;
}

export const VOICE_META: VoiceMeta[] = [
  // The newest (and most natural-sounding) free voices on Microsoft's Edge
  // service: the "Multilingual" neural generation, noticeably more expressive
  // and human than the older standard set. They're listed first for that
  // reason; CI checks them against the real service on every desktop build
  // (server/scripts/edge-tts-smoke.ts).
  { id: "en-US-AvaMultilingualNeural", displayName: "Ava (most natural)", gender: "Female", accent: "American" },
  { id: "en-US-AndrewMultilingualNeural", displayName: "Andrew (most natural)", gender: "Male", accent: "American" },
  { id: "en-US-EmmaMultilingualNeural", displayName: "Emma (most natural)", gender: "Female", accent: "American" },
  { id: "en-US-BrianMultilingualNeural", displayName: "Brian (most natural)", gender: "Male", accent: "American" },
  { id: "en-US-JennyNeural", displayName: "Jenny", gender: "Female", accent: "American" },
  { id: "en-US-AnaNeural", displayName: "Ana", gender: "Female", accent: "American" },
  { id: "en-GB-SoniaNeural", displayName: "Sonia", gender: "Female", accent: "British" },
  { id: "en-US-ChristopherNeural", displayName: "Christopher", gender: "Male", accent: "American" },
  { id: "en-US-GuyNeural", displayName: "Guy", gender: "Male", accent: "American" },
  { id: "en-GB-RyanNeural", displayName: "Ryan", gender: "Male", accent: "British" },
];

export const DEFAULT_VOICE_ID = "en-US-JennyNeural";

export const VOICE_BY_ID: Record<string, VoiceMeta> = Object.fromEntries(
  VOICE_META.map((v) => [v.id, v]),
);

export function sampleUrlFor(voiceId: string): string {
  return `/voice-samples/${voiceId}.mp3`;
}

export function toVoiceInfo(v: VoiceMeta): VoiceInfo {
  return { ...v, sampleUrl: sampleUrlFor(v.id) };
}

export const DEFAULT_VOICES: VoiceInfo[] = VOICE_META.map(toVoiceInfo);

export function displayNameFor(voiceId: string): string {
  if (isLocalVoiceId(voiceId)) return localVoiceName(voiceId);
  return VOICE_BY_ID[voiceId]?.displayName ?? voiceId;
}

/** Group voices by "Accent Gender" for the picker. */
export function groupVoices(voices: VoiceInfo[]): Record<string, VoiceInfo[]> {
  const groups: Record<string, VoiceInfo[]> = {};
  for (const v of voices) {
    const key = `${v.accent} ${v.gender}`;
    (groups[key] ??= []).push(v);
  }
  return groups;
}

export const SAMPLE_SENTENCE =
  "Welcome to Soundwave AI. This is a sample of my voice. I can help you create professional audio content with natural-sounding speech.";

// ── The agent's voice ───────────────────────────────────────────────────────
// One setting, shared by the Command Center (replies + shorts), Settings and
// the Voice Library's "Use in Command Center". Only Soundwave voices allowed.
export const AGENT_VOICE_STORAGE_KEY = "soundwave_voice";
export const DEFAULT_AGENT_VOICE_ID = "en-US-GuyNeural";

/**
 * A Soundwave voice: one of Microsoft's neural voices, which is what the app
 * speaks with by default. Deliberately NOT true for the on-this-PC engine — use
 * `isKnownVoice` when the question is "can the app speak this?", and this when
 * the question is "is this one of ours?".
 */
export function isSoundwaveVoice(voiceId: string | null | undefined): voiceId is string {
  return typeof voiceId === "string" && voiceId in VOICE_BY_ID;
}

// ── On-this-PC voices (Kokoro-82M, Apache-2.0) ──────────────────────────────
// Same idea as the cloned voices: namespaced ids, so nothing can be confused
// with a Soundwave voice. They exist only when the local voice service is
// running (lib/localVoices.ts asks the server), and they are never the default.
export const LOCAL_VOICE_PREFIX = "kokoro:";

export function isLocalVoiceId(voiceId: string | null | undefined): voiceId is string {
  return typeof voiceId === "string" && voiceId.toLowerCase().startsWith(LOCAL_VOICE_PREFIX);
}

/** Any voice this app can speak: a Soundwave voice or an on-this-PC one. */
export function isKnownVoice(voiceId: string | null | undefined): voiceId is string {
  return isSoundwaveVoice(voiceId) || isLocalVoiceId(voiceId);
}

/** "kokoro:af_heart" → "Heart" (the name Kokoro itself gives that voice). */
export function localVoiceName(voiceId: string): string {
  const short = voiceId.slice(LOCAL_VOICE_PREFIX.length);
  const name = short.split("_")[1] ?? short;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function loadAgentVoice(): string {
  try {
    const saved = localStorage.getItem(AGENT_VOICE_STORAGE_KEY);
    if (isKnownVoice(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_AGENT_VOICE_ID;
}

export function saveAgentVoice(voiceId: string): void {
  if (!isKnownVoice(voiceId)) return;
  try {
    localStorage.setItem(AGENT_VOICE_STORAGE_KEY, voiceId);
  } catch {
    /* storage unavailable */
  }
}

/** "Guy — US male" */
export function agentVoiceLabel(voiceId: string): string {
  if (isLocalVoiceId(voiceId)) return `${localVoiceName(voiceId)} — on this PC (free, offline)`;
  const v = VOICE_BY_ID[voiceId];
  if (!v) return voiceId;
  return `${v.displayName} — ${v.accent === "British" ? "UK" : "US"} ${v.gender.toLowerCase()}`;
}

/** Male voices first (the agent's default is male), then female. */
export const AGENT_VOICES: VoiceInfo[] = [...DEFAULT_VOICES].sort((a, b) =>
  a.gender === b.gender ? 0 : a.gender === "Male" ? -1 : 1,
);
