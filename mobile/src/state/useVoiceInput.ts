// ── Mic → the PC's speech engine → a message ────────────────────────────────
// Same behaviour as the desktop Command Center's mic: tap to talk (it sends
// by itself when you stop), or hold to talk and release to send.

import { useCallback, useEffect, useRef, useState } from "react";
import { micProblem, playEarcon, startPhoneRecording, stopSpeaking, type Recorder, type StopReason } from "../lib/voice";
import { tap } from "../lib/native";

export type MicPhase = "idle" | "starting" | "listening" | "transcribing";

/** A press shorter than this is a tap; longer is push-to-talk. */
export const HOLD_MS = 350;

interface Handlers {
  transcribe: (wav: Uint8Array, signal: AbortSignal) => Promise<{ text: string; noSpeech: boolean }>;
  onText: (text: string) => void;
  onNothingHeard: () => void;
  onError: (message: string) => void;
}

export function useVoiceInput(handlers: Handlers) {
  const [phase, setPhase] = useState<MicPhase>("idle");
  const [level, setLevel] = useState(0);
  const phaseRef = useRef<MicPhase>("idle");
  const recorderRef = useRef<Recorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingStop = useRef<StopReason | null>(null);
  const cancelled = useRef(false);
  const held = useRef(false);
  const h = useRef(handlers);
  h.current = handlers;

  const go = useCallback((p: MicPhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const finish = useCallback(
    async (reason: StopReason = "manual") => {
      const recorder = recorderRef.current;
      if (!recorder) {
        if (phaseRef.current === "starting") pendingStop.current = reason;
        return;
      }
      recorderRef.current = null;
      go("transcribing");
      setLevel(0);
      playEarcon("stop");
      tap();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const rec = await recorder.stop(reason);
        if (controller.signal.aborted) return;
        if (!rec.hadSpeech && (reason === "no-speech" || rec.durationMs < 400)) {
          go("idle");
          h.current.onNothingHeard();
          return;
        }
        const wav = new Uint8Array(await rec.wav.arrayBuffer());
        const heard = await h.current.transcribe(wav, controller.signal);
        if (controller.signal.aborted) return;
        go("idle");
        if (heard.text.trim()) h.current.onText(heard.text.trim());
        else h.current.onNothingHeard();
      } catch (err) {
        if (controller.signal.aborted) return;
        go("idle");
        playEarcon("error");
        h.current.onError((err as Error).message || "Couldn't understand that.");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [go],
  );

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    cancelled.current = false;
    held.current = false;
    pendingStop.current = null;
    stopSpeaking();
    go("starting");
    tap("medium");
    try {
      const recorder = await startPhoneRecording({
        autoStop: true,
        onLevel: setLevel,
        onAutoStop: (reason) => void finish(reason),
      });
      if (cancelled.current) {
        recorder.cancel();
        return;
      }
      recorderRef.current = recorder;
      if (held.current) recorder.setAutoStop(false);
      go("listening");
      playEarcon("start");
      const pending = pendingStop.current;
      if (pending) {
        pendingStop.current = null;
        void finish(pending);
      }
    } catch (err) {
      if (cancelled.current) return;
      go("idle");
      h.current.onError(micProblem(err));
    }
  }, [finish, go]);

  const cancel = useCallback(() => {
    cancelled.current = true;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    setLevel(0);
    go("idle");
  }, [go]);

  /** Still held after HOLD_MS: push-to-talk (ends on release). */
  const holdStarted = useCallback(() => {
    held.current = true;
    recorderRef.current?.setAutoStop(false);
  }, []);

  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      abortRef.current?.abort();
    },
    [],
  );

  // Press handling for the mic button: tap toggles, hold = push-to-talk.
  const press = useRef<{ at: number; wasActive: boolean; timer?: number } | null>(null);
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      const wasActive = phaseRef.current !== "idle";
      const p: { at: number; wasActive: boolean; timer?: number } = { at: e.timeStamp, wasActive };
      press.current = p;
      if (!wasActive) {
        void start();
        p.timer = window.setTimeout(holdStarted, HOLD_MS);
      }
    },
    [holdStarted, start],
  );
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const p = press.current;
      press.current = null;
      if (!p) return;
      window.clearTimeout(p.timer);
      const heldFor = e.timeStamp - p.at;
      if (p.wasActive) {
        if (phaseRef.current === "listening" || phaseRef.current === "starting") void finish("manual");
        return;
      }
      if (heldFor >= HOLD_MS) void finish("manual"); // released after push-to-talk
      else {
        held.current = false; // a tap: keep listening until they stop talking
        recorderRef.current?.setAutoStop(true);
      }
    },
    [finish],
  );
  const onPointerCancel = useCallback(() => {
    const p = press.current;
    press.current = null;
    if (p) window.clearTimeout(p.timer);
  }, []);

  return { phase, level, start, finish, cancel, onPointerDown, onPointerUp, onPointerCancel };
}
