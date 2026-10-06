import { useCallback, useEffect, useRef, useState } from "react";
import { getDesktop } from "../lib/desktop";
import { stopSpeaking } from "../lib/speech";
import {
  VoiceInputError,
  loadVoicePrefs,
  playEarcon,
  startRecording,
  transcribeRecording,
  type Recorder,
  type StopReason,
} from "../lib/voiceInput";

export type CapturePhase = "idle" | "starting" | "listening" | "transcribing";

export interface VoiceCaptureHandlers {
  /** What the person said. */
  onTranscript: (text: string) => void;
  /** The recording held no speech. */
  onNothingHeard: () => void;
  onError: (error: VoiceInputError | Error) => void;
}

/** A tap shorter than this toggles listening; holding longer is push-to-talk. */
export const HOLD_MS = 350;

/**
 * Microphone → local transcription, as a React state machine:
 * idle → starting → listening → transcribing → idle.
 *
 * `start()` interrupts the agent if it's talking. In tap-to-talk (the
 * default) the recording ends by itself when the person stops speaking
 * (Settings → Voice & Desktop can turn that off); `holdStarted()` switches a
 * recording to push-to-talk, which ends on `finish()` (button released).
 */
export function useVoiceCapture(handlers: VoiceCaptureHandlers) {
  const [phase, setPhase] = useState<CapturePhase>("idle");
  const [level, setLevel] = useState(0);
  const phaseRef = useRef<CapturePhase>("idle");
  const recorderRef = useRef<Recorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopWhenReadyRef = useRef<StopReason | null>(null);
  const cancelledRef = useRef(false);
  const holdRef = useRef(false);
  const speechRef = useRef(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const go = useCallback((next: CapturePhase) => {
    phaseRef.current = next;
    setPhase(next);
    // This PC has one speech engine, and the hidden wake listener wants it too:
    // while this window is recording or transcribing, the shell keeps that
    // listener quiet (source "mic" — the voice bar reports separately as
    // "voice", so neither cancels the other's pause).
    getDesktop()?.setVoiceState(next === "idle" ? "idle" : next === "transcribing" ? "working" : "listening", "mic");
  }, []);

  const finish = useCallback(
    async (reason: StopReason = "manual") => {
      const recorder = recorderRef.current;
      if (!recorder) {
        // Released before the microphone was even ready.
        if (phaseRef.current === "starting") stopWhenReadyRef.current = reason;
        return;
      }
      recorderRef.current = null;
      go("transcribing");
      setLevel(0);
      playEarcon("stop");
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const recording = await recorder.stop(reason);
        if (controller.signal.aborted) return;
        if (!recording.hadSpeech && (reason === "no-speech" || recording.durationMs < 400)) {
          console.warn(`[voice] nothing heard (${reason}, ${Math.round(recording.durationMs)} ms)`);
          go("idle");
          handlersRef.current.onNothingHeard();
          return;
        }
        const transcript = await transcribeRecording(recording.wav, controller.signal);
        if (controller.signal.aborted) return;
        go("idle");
        if (transcript.text.trim()) handlersRef.current.onTranscript(transcript.text.trim());
        else {
          // The engine answered, but with nothing in it: say so with the shape
          // of the recording, so "I didn't catch that" is diagnosable.
          console.warn(`[voice] nothing heard in ${(recording.durationMs / 1000).toFixed(1)} s of audio (${Math.round(recording.wav.size / 1024)} KB)`);
          handlersRef.current.onNothingHeard();
        }
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === "AbortError") return;
        // A toast disappears in seconds and a run's screenshot may not be
        // readable: the reason also goes to the console, where it stays.
        console.warn(`[voice] transcription failed: ${(err as Error)?.message ?? String(err)}`);
        go("idle");
        playEarcon("error");
        handlersRef.current.onError(err as Error);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [go],
  );

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    cancelledRef.current = false;
    holdRef.current = false;
    speechRef.current = false;
    stopWhenReadyRef.current = null;
    stopSpeaking();
    go("starting");
    try {
      const recorder = await startRecording({
        autoStop: loadVoicePrefs().autoStop,
        onLevel: setLevel,
        onSpeech: () => {
          speechRef.current = true;
        },
        onAutoStop: (reason) => void finish(reason),
      });
      if (cancelledRef.current) {
        recorder.cancel();
        return;
      }
      recorderRef.current = recorder;
      if (holdRef.current) recorder.setAutoStop(false);
      go("listening");
      playEarcon("start");
      const pending = stopWhenReadyRef.current;
      if (pending) {
        stopWhenReadyRef.current = null;
        void finish(pending);
      }
    } catch (err) {
      if (cancelledRef.current) return;
      go("idle");
      playEarcon("error");
      handlersRef.current.onError(err as Error);
    }
  }, [finish, go]);

  /** Drop the recording / transcription without sending anything. */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    setLevel(0);
    go("idle");
  }, [go]);

  /** The button is still held: this recording is push-to-talk (ends on release). */
  const holdStarted = useCallback(() => {
    holdRef.current = true;
    recorderRef.current?.setAutoStop(false);
  }, []);

  /** It was a tap after all (the release arrived late): end-of-speech detection back on. */
  const tapConfirmed = useCallback(() => {
    holdRef.current = false;
    recorderRef.current?.setAutoStop(loadVoicePrefs().autoStop);
  }, []);

  /** Shortcut / tap semantics: start when idle, send when listening. */
  const toggle = useCallback(() => {
    if (phaseRef.current === "idle") void start();
    else if (phaseRef.current === "listening" || phaseRef.current === "starting") void finish("manual");
  }, [finish, start]);

  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      abortRef.current?.abort();
      // This window is going away: the shell must not keep the wake listener
      // paused on its behalf.
      getDesktop()?.setVoiceState("idle", "mic");
    },
    [],
  );

  return { phase, level, phaseRef, start, finish, cancel, toggle, holdStarted, tapConfirmed, hasSpeech: () => speechRef.current };
}
