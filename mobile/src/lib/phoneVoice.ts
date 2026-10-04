// ── The Soundwave voices on the phone itself ────────────────────────────────
// When the PC is off, replies and the morning briefing are spoken by the
// native EdgeTts plugin (android/…/EdgeTtsPlugin.java): Microsoft's neural
// voices, the same ones the PC uses, synthesized right on the phone. In a
// desktop browser (development) there's no plugin: the text stays on screen.

import { Capacitor, registerPlugin } from "@capacitor/core";

interface EdgeTtsPlugin {
  synthesize(opts: { text: string; voice?: string; rate?: string; url?: string }): Promise<{ audio: string; mime: string; bytes: number }>;
}

const EdgeTts = registerPlugin<EdgeTtsPlugin>("EdgeTts");

export const DEFAULT_PHONE_VOICE_ID = "en-US-AndrewMultilingualNeural";

export function phoneVoiceAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("EdgeTts");
}

/**
 * The key the emulator test writes to point the phone's own voice at the local
 * stand-in the Android workflow starts. Microsoft's service is reachable from a
 * CI runner *sometimes*, and a red build that way says nothing about Soundwave
 * (the same reason the workflow stands in for Gemini and Open-Meteo). Nothing
 * in the shipped app ever writes this key — delete it and the voice is
 * Microsoft's, which is what every real phone does.
 */
const TEST_TTS_URL_KEY = "soundwave.test.ttsUrl";

/** The stand-in's URL, when the test put one in this app's own storage. */
export function testTtsUrl(): string | undefined {
  try {
    return localStorage.getItem(TEST_TTS_URL_KEY) || undefined;
  } catch {
    return undefined; // no storage (a plain browser page, a locked-down WebView)
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One piece of speech (≤ ~2000 characters) in a Soundwave voice, as MP3. */
export async function synthesizeOnPhone(text: string, voice: string | null | undefined): Promise<{ audio: Uint8Array; mime: string }> {
  if (!phoneVoiceAvailable()) throw new Error("Speaking without the PC works in the Android app.");
  const r = await EdgeTts.synthesize({ text, voice: voice || DEFAULT_PHONE_VOICE_ID, rate: "-5%", url: testTtsUrl() });
  return { audio: fromBase64(r.audio), mime: r.mime || "audio/mpeg" };
}
