// ── The hidden page that listens for "Hey Soundwave" ───────────────────────
// The desktop shell loads this in a small, never-shown window while the wake
// word is on. It keeps the microphone open, cuts what it hears into utterances
// (lib/wakeCapture), transcribes each one **on this PC** with whisper.cpp
// (POST /api/v1/agent/transcribe) and hands the text to the shell, which decides
// whether the phrase was in it (desktop/src/wake.cjs). Nothing is uploaded, the
// audio is never written to disk, and a transcript that isn't the phrase is
// dropped on the spot — that is the whole privacy story, and it is true.
//
// It listens for the phrase only: ordinary speech costs a little CPU to check
// and is then thrown away. That is why the shell pauses it while Soundwave is
// itself recording or speaking.
//
// Rendered as nothing: the window is hidden.

import { useEffect, useRef } from "react";
import { getDesktop } from "../lib/desktop";
import { fetchVoiceInputStatus, transcribeRecording } from "../lib/voiceInput";
import { MAX_UTTERANCE_MS, startWakeListener, type WakeListener, type WakeUtterance } from "../lib/wakeCapture";

type WakeState = "starting" | "listening" | "paused" | "off" | "error";

export function WakeListener() {
  const desktop = getDesktop();
  const listenerRef = useRef<WakeListener | null>(null);
  const busyRef = useRef(false);
  const stoppedRef = useRef(false);
  const stateRef = useRef<WakeState>("starting");
  const problemRef = useRef<string | null>(null);

  useEffect(() => {
    const bridge = desktop;
    if (!bridge) return;
    stoppedRef.current = false;

    const report = (state: WakeState, detail?: string) => {
      if (stateRef.current === state && problemRef.current === (detail ?? null)) return;
      stateRef.current = state;
      problemRef.current = detail ?? null;
      bridge.wakeState({ state, ...(detail ? { detail } : {}) });
    };

    const stopListening = () => {
      listenerRef.current?.stop();
      listenerRef.current = null;
    };

    /** One utterance → local transcription → the shell decides what it means. */
    const check = async (utterance: WakeUtterance) => {
      if (stoppedRef.current) return;
      if (busyRef.current) return; // whisper is already working: don't queue the world
      busyRef.current = true;
      try {
        const heard = await transcribeRecording(utterance.wav, undefined, { background: true });
        if (stoppedRef.current) return;
        const text = heard.text?.trim();
        if (text) bridge.wakeHeard({ text });
      } catch (err) {
        const message = (err as Error)?.message || "The speech engine didn't answer.";
        // "Busy" is the normal, designed answer while the person's own
        // recording is being transcribed (the engine serves them first): that
        // utterance is simply dropped and the next one is checked. Anything
        // else is worth saying once in the state line, and we keep listening.
        if (!/busy/i.test(message)) report("error", message);
        return;
      } finally {
        busyRef.current = false;
      }
      if (stateRef.current === "error") report("listening");
    };

    const startListening = async () => {
      if (stoppedRef.current || listenerRef.current) return;
      report("starting");
      try {
        listenerRef.current = await startWakeListener({
          onUtterance: (utterance) => void check(utterance),
          onError: (err) => report("error", err.message),
        });
        if (stoppedRef.current) {
          stopListening();
          return;
        }
        report("listening");
      } catch (err) {
        report("error", (err as Error)?.message || "The microphone couldn't be opened.");
      }
    };

    // Is there an engine at all? Without whisper.cpp there is nothing to hear with.
    void (async () => {
      const status = await fetchVoiceInputStatus();
      if (stoppedRef.current) return;
      if (!status?.available) {
        report("error", status?.reason ?? "The speech engine isn't available, so “Hey Soundwave” can't be heard.");
        return;
      }
      await startListening();
    })();

    const offControl = bridge.onWakeControl((command) => {
      if (command === "pause") {
        stopListening();
        report("paused");
        return;
      }
      void startListening();
    });

    return () => {
      stoppedRef.current = true;
      offControl();
      stopListening();
      report("off");
    };
  }, [desktop]);

  // Nothing to show: this window is never visible.
  return <div aria-hidden className="hidden" data-wake-state={stateRef.current} data-max-utterance={MAX_UTTERANCE_MS} />;
}
