// ── Microsoft Edge Neural voice metadata ────────────────────────────────────
// Served via /api/v1/voices and mirrored in the frontend. TTS is generated
// server-side with node-edge-tts (Microsoft Neural voices); these are the
// voices exposed to the user.

export interface VoiceMeta {
  id: string;
  displayName: string;
  gender: "Female" | "Male";
  accent: "American" | "British";
  sampleUrl: string;
}

// The newest (and most natural-sounding) free voices on Microsoft's service:
// the "Multilingual" generation. Listed first for that reason, exactly like the
// app's own list (frontend/src/lib/voices.ts) — the server has to know every
// voice the app can play, or the agent couldn't offer to switch to it.
const RAW: Array<[string, string, "Female" | "Male", "American" | "British"]> = [
  ["en-US-AvaMultilingualNeural", "Ava (most natural)", "Female", "American"],
  ["en-US-AndrewMultilingualNeural", "Andrew (most natural)", "Male", "American"],
  ["en-US-EmmaMultilingualNeural", "Emma (most natural)", "Female", "American"],
  ["en-US-BrianMultilingualNeural", "Brian (most natural)", "Male", "American"],
  ["en-US-JennyNeural", "Jenny", "Female", "American"],
  ["en-US-AnaNeural", "Ana", "Female", "American"],
  ["en-GB-SoniaNeural", "Sonia", "Female", "British"],
  ["en-US-ChristopherNeural", "Christopher", "Male", "American"],
  ["en-US-GuyNeural", "Guy", "Male", "American"],
  ["en-GB-RyanNeural", "Ryan", "Male", "British"],
];

export const VOICES: VoiceMeta[] = RAW.map(([id, displayName, gender, accent]) => ({
  id,
  displayName,
  gender,
  accent,
  sampleUrl: `/voice-samples/${id}.mp3`,
}));

export const VOICE_IDS = new Set(VOICES.map((v) => v.id));

export function getVoice(id: string): VoiceMeta | null {
  return VOICES.find((v) => v.id === id) ?? null;
}

/** "Ava (most natural)" → "Ava": the part a person actually says. */
export function voiceNickname(displayName: string): string {
  return displayName.replace(/\s*\(.*\)\s*$/, "").trim();
}

const tidy = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * "Which voice did the user mean?" — the agent gets whatever the person typed
 * ("use Ava", "the Ryan one", "en-GB-SoniaNeural", "emma"), and this turns it
 * into a real voice id. Returns null when there's no match, so the caller can
 * say which names exist instead of guessing.
 */
export function resolveVoice(input: string | null | undefined): VoiceMeta | null {
  const asked = String(input ?? "").trim();
  if (!asked) return null;
  const wanted = tidy(asked);
  if (!wanted) return null;

  // Exact id (case-insensitive), then exact nickname / display name, then a
  // unique prefix — "chr" finds Christopher, but an ambiguous "a" doesn't.
  const byId = VOICES.find((v) => tidy(v.id) === wanted) ?? null;
  if (byId) return byId;
  const exact = VOICES.filter((v) => tidy(voiceNickname(v.displayName)) === wanted || tidy(v.displayName) === wanted);
  if (exact.length === 1) return exact[0]!;
  const prefixed = VOICES.filter((v) => tidy(v.id).startsWith(wanted) || tidy(voiceNickname(v.displayName)).startsWith(wanted));
  return prefixed.length === 1 ? prefixed[0]! : null;
}

/** The names a person would use, e.g. ["Ava", "Andrew", …] — how the agent offers choices. */
export function voiceNames(): string[] {
  return VOICES.map((v) => voiceNickname(v.displayName));
}
