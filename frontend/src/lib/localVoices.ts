// ── The on-this-PC voices, as the server reports them ───────────────────────
// Kokoro-82M (Apache-2.0) narration voices, served by the optional local voice
// service. The list is never guessed here: it comes from the engine itself via
// GET /api/v1/voices (which proxies the service), so an install without the
// service simply shows nothing, with the server's own sentence saying why.
//
// Cached for the session and refreshed on demand — this is a local HTTP call to
// our own backend, not a Microsoft round trip.

import { useEffect, useState } from "react";
import { getDesktop } from "./desktop";
import { LOCAL_VOICE_PREFIX } from "./voices";
import type { VoiceInfo } from "./types";

export interface LocalVoiceSetupStatus {
  managed: true;
  phase: string;
  message: string;
  progress?: number;
  progressLabel?: string;
  updatedAt?: string;
}

export interface LocalVoiceStatus {
  available: boolean;
  engine: "kokoro";
  /** Why they aren't available, in the server's words. */
  reason?: string;
  /** Progress from the packaged desktop's automatic first-run setup. */
  setup?: LocalVoiceSetupStatus;
  /** Stated so the UI can be honest about the licence. */
  license?: string;
  voices: VoiceInfo[];
}

export const EMPTY_LOCAL_VOICES: LocalVoiceStatus = { available: false, engine: "kokoro", voices: [] };

export function localVoiceSetupLabel(setup?: LocalVoiceSetupStatus): string {
  if (!setup) return "";
  if (setup.phase === "failed") return "Kokoro setup will retry next launch";
  if (setup.phase === "cancelled") return "Kokoro setup was cancelled";
  if (setup.phase === "cancelling") return "Cancelling Kokoro setup…";
  if (typeof setup.progress === "number") return `Kokoro setup — ${Math.round(setup.progress)}%`;
  if (setup.phase === "installing-python") return "Installing Kokoro's Python runtime…";
  if (setup.phase === "installing-packages") return "Installing Kokoro's speech engine…";
  if (setup.phase === "loading-model") return "Downloading and preparing Kokoro…";
  return "Kokoro is preparing in the background…";
}

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
    .then((body: { local?: { available?: boolean; reason?: string; license?: string; setup?: LocalVoiceSetupStatus; voices?: unknown[] } }) => {
      const local = body.local ?? {};
      const voices = (local.voices ?? []).map((v) => toVoiceInfo(v as Parameters<typeof toVoiceInfo>[0]));
      const status: LocalVoiceStatus = {
        available: local.available === true && voices.length > 0,
        engine: "kokoro",
        reason: local.reason,
        setup: local.setup?.managed === true ? local.setup : undefined,
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
export function useLocalVoices(): {
  status: LocalVoiceStatus;
  loading: boolean;
  canCancelSetup: boolean;
  cancellingSetup: boolean;
  cancelSetup: () => Promise<boolean>;
} {
  const [status, setStatus] = useState<LocalVoiceStatus>(cached ?? EMPTY_LOCAL_VOICES);
  const [loading, setLoading] = useState(cached === null);
  const [cancellingSetup, setCancellingSetup] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const refresh = async (fresh: boolean) => {
      const next = await fetchLocalVoices({ fresh });
      if (!alive) return;
      setStatus(next);
      setLoading(false);
      if (next.setup?.managed && !next.available && !["ready", "failed", "cancelled"].includes(next.setup.phase)) {
        timer = window.setTimeout(() => void refresh(true), 4_000);
      }
    };
    void refresh(false);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const phase = status.setup?.phase;
  const canCancelSetup = Boolean(
    getDesktop() &&
      status.setup?.managed &&
      !status.available &&
      phase &&
      !["ready", "failed", "cancelled", "cancelling"].includes(phase),
  );
  const cancelSetup = async (): Promise<boolean> => {
    const desktop = getDesktop();
    if (!desktop || !canCancelSetup || cancellingSetup) return false;
    setCancellingSetup(true);
    try {
      const accepted = await desktop.cancelKokoroSetup();
      if (!accepted) return false;
      const next = await fetchLocalVoices({ fresh: true });
      setStatus(next);
      setLoading(false);
      return true;
    } catch {
      return false;
    } finally {
      setCancellingSetup(false);
    }
  };

  return { status, loading, canCancelSetup, cancellingSetup, cancelSetup };
}
