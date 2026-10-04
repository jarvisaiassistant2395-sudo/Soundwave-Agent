// ── The on-this-PC voices, as the server reports them ───────────────────────
// Kokoro-82M (Apache-2.0) narration voices, served by the optional local voice
// service. The list is never guessed here: it comes from the engine itself via
// GET /api/v1/voices (which proxies the service), so an install without the
// service simply shows nothing, with the server's own sentence saying why.
//
// Cached for the session and refreshed on demand — this is a local HTTP call to
// our own backend, not a Microsoft round trip.

import { useEffect, useState } from "react";
import { LOCAL_VOICE_PREFIX } from "./voices";
import type { VoiceInfo } from "./types";

export interface LocalVoiceStatus {
  available: boolean;
  engine: "kokoro";
  /** Why they aren't available, in the server's words. */
  reason?: string;
  /** Stated so the UI can be honest about the licence. */
  license?: string;
  voices: VoiceInfo[];
}

export const EMPTY_LOCAL_VOICES: LocalVoiceStatus = { available: false, engine: "kokoro", voices: [] };

let cached: LocalVoiceStatus | null = null;
let inflight: Promise<LocalVoiceStatus> | null = null;

function toVoiceInfo(raw: {
  id: string;
  voiceId?: string;
  displayName?: string;
  gender?: VoiceInfo["gender"];
  accent?: VoiceInfo["accent"];
}): VoiceInfo {
  const id = raw.voiceId ?? `${LOCAL_VOICE_PREFIX}${raw.id}`;
  return {
    id,
    displayName: raw.displayName ?? raw.id,
    gender: raw.gender ?? "Female",
    accent: raw.accent ?? "American",
    // No MP3 samples are pre-generated for these: the Voice Library previews
    // them through /api/v1/agent/speak/stream, which the local engine serves.
    sampleUrl: "",
  };
}

export async function fetchLocalVoices(options: { fresh?: boolean } = {}): Promise<LocalVoiceStatus> {
  if (!options.fresh && cached) return cached;
  if (!options.fresh && inflight) return inflight;
  inflight = fetch("/api/v1/voices")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((body: { local?: { available?: boolean; reason?: string; license?: string; voices?: unknown[] } }) => {
      const local = body.local ?? {};
      const voices = (local.voices ?? []).map((v) => toVoiceInfo(v as Parameters<typeof toVoiceInfo>[0]));
      const status: LocalVoiceStatus = {
        available: local.available === true && voices.length > 0,
        engine: "kokoro",
        reason: local.reason,
        license: local.license,
        voices,
      };
      cached = status;
      return status;
    })
    .catch(() => cached ?? EMPTY_LOCAL_VOICES)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** React hook: the local voices, or an empty list while unknown/unavailable. */
export function useLocalVoices(): { status: LocalVoiceStatus; loading: boolean } {
  const [status, setStatus] = useState<LocalVoiceStatus>(cached ?? EMPTY_LOCAL_VOICES);
  const [loading, setLoading] = useState(cached === null);
  useEffect(() => {
    let alive = true;
    void fetchLocalVoices().then((s) => {
      if (alive) {
        setStatus(s);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return { status, loading };
}
