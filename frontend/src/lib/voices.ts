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

export function isSoundwaveVoice(voiceId: string | null | undefined): voiceId is string {
  return typeof voiceId === "string" && voiceId in VOICE_BY_ID;
}

export function loadAgentVoice(): string {
  try {
    const saved = localStorage.getItem(AGENT_VOICE_STORAGE_KEY);
    if (isSoundwaveVoice(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_AGENT_VOICE_ID;
}

export function saveAgentVoice(voiceId: string): void {
  if (!isSoundwaveVoice(voiceId)) return;
  try {
    localStorage.setItem(AGENT_VOICE_STORAGE_KEY, voiceId);
  } catch {
    /* storage unavailable */
  }
}

/** "Guy — US male" */
export function agentVoiceLabel(voiceId: string): string {
  const v = VOICE_BY_ID[voiceId];
  if (!v) return voiceId;
  return `${v.displayName} — ${v.accent === "British" ? "UK" : "US"} ${v.gender.toLowerCase()}`;
}

/** Male voices first (the agent's default is male), then female. */
export const AGENT_VOICES: VoiceInfo[] = [...DEFAULT_VOICES].sort((a, b) =>
  a.gender === b.gender ? 0 : a.gender === "Male" ? -1 : 1,
);
