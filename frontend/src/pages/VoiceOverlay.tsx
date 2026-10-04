import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Mic, Settings2, Square, X } from "lucide-react";
import { ThinkingOrbVisualizer } from "../components/agent/ThinkingOrbVisualizer";
import { useVoiceCapture } from "../hooks/useVoiceCapture";
import { DEFAULT_HOTKEY, getDesktop, hotkeyLabel } from "../lib/desktop";
import {
  appendToChatHistory,
  chatTime,
  historyForRequest,
  loadChatHistory,
  newMessageId,
  replyToMessage,
  sendChat,
  type ChatMessage,
} from "../lib/agentChat";
import { speak, stopSpeaking, voiceProblemReason } from "../lib/speech";
import { loadAgentVoice } from "../lib/voices";
import { VoiceInputError, loadVoicePrefs } from "../lib/voiceInput";

type Stage = "idle" | "thinking" | "speaking" | "done" | "error";

/**
 * The desktop app's floating voice bar (its own always-on-top window, shown
 * by the global shortcut or the tray's "Talk to Soundwave"). Listens, shows
 * what it heard, asks the agent, speaks the answer, then tucks itself away.
 * The turn lands in the Command Center's conversation too.
 */
export function VoiceOverlay() {
  const desktop = getDesktop();
  const [stage, setStage] = useState<Stage>("idle");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [problem, setProblem] = useState<{ text: string; micSettings: boolean } | null>(null);
  /** The reply couldn't be spoken (voice service down) — it's still shown. */
  const [voiceWarning, setVoiceWarning] = useState<string | null>(null);
  const [hotkey, setHotkey] = useState(DEFAULT_HOTKEY);
  const stageRef = useRef<Stage>("idle");
  const hideTimer = useRef<number | undefined>(undefined);

  const setStageNow = (next: Stage) => {
    stageRef.current = next;
    setStage(next);
  };

  // Transparent window: no page background at all.
  useEffect(() => {
    document.documentElement.classList.add("sw-overlay");
    document.title = "Soundwave AI — Voice";
    return () => document.documentElement.classList.remove("sw-overlay");
  }, []);

  const hideSoon = useCallback(
    (ms: number) => {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        setStageNow("idle");
        setHeard("");
        setReply("");
        setProblem(null);
        setVoiceWarning(null);
        desktop?.hideOverlay();
      }, ms);
    },
    [desktop],
  );

  const showProblem = useCallback(
    (text: string, error?: unknown) => {
      const micSettings = error instanceof VoiceInputError && (error.code === "denied" || error.code === "busy") && Boolean(desktop);
      setProblem({ text, micSettings });
      setStageNow("error");
      desktop?.setVoiceState("idle");
      hideSoon(micSettings ? 15_000 : 7000);
    },
    [desktop, hideSoon],
  );

  const finishReply = useCallback(
    (ms: number) => {
      setStageNow("done");
      desktop?.setVoiceState("idle");
      hideSoon(ms);
    },
    [desktop, hideSoon],
  );

  const answer = useCallback(
    async (text: string) => {
      setHeard(text);
      setReply("");
      setProblem(null);
      setVoiceWarning(null);
      setStageNow("thinking");
      desktop?.setVoiceState("working");
      const earlier = loadChatHistory() ?? [];
      const said: ChatMessage = { id: newMessageId(), sender: "user", text, time: chatTime(), at: Date.now(), viaVoice: true };
      appendToChatHistory(said);
      try {
        const data = await sendChat({ message: text, history: historyForRequest(earlier), voice: loadAgentVoice(), resolution: "720p" });
        const answered = replyToMessage(data, text);
        appendToChatHistory(answered);
        setReply(answered.text);
        if (!loadVoicePrefs().speakReplies) {
          finishReply(7000);
          return;
        }
        setStageNow("speaking");
        const speaking = speak(answered.text, loadAgentVoice(), {
          onEnd: () => finishReply(2500),
          onBlocked: () => finishReply(7000),
          onError: () => {
            finishReply(9000);
            void voiceProblemReason().then((why) => setVoiceWarning(`Couldn't speak the reply: ${why}`));
          },
        });
        if (!speaking) finishReply(5000);
      } catch (err) {
        showProblem((err as Error).message || "The agent couldn't answer.");
      }
    },
    [desktop, finishReply, showProblem],
  );

  const [holdHint, setHoldHint] = useState(false);

  const capture = useVoiceCapture({
    onTranscript: (text) => void answer(text),
    onNothingHeard: () => showProblem("I didn't catch anything. Press the shortcut and try again."),
    onError: (err) => showProblem(err.message, err),
  });
  const { phase, level, phaseRef } = capture;

  const listen = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    stopSpeaking();
    setStageNow("idle");
    setHeard("");
    setReply("");
    setProblem(null);
    setVoiceWarning(null);
    desktop?.setVoiceState("listening");
    void capture.start();
  }, [capture, desktop]);

  // While a hold is down the bar says so; a released tap falls back to
  // "pause to send" by itself (the "hold-end" command above).
  useEffect(() => {
    if (phase !== "listening" && phase !== "starting") setHoldHint(false);
  }, [phase]);

  const close = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    capture.cancel();
    stopSpeaking();
    setStageNow("idle");
    setHeard("");
    setReply("");
    setProblem(null);
    setVoiceWarning(null);
    desktop?.setVoiceState("idle");
    desktop?.hideOverlay();
  }, [capture, desktop]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  // The shortcut: tap = start, tap again = send. With hold-to-talk on, the
  // shell says hold-start when the keys go down and hold-end when they come up,
  // so releasing sends — but a quick tap still behaves like a tap (it keeps
  // listening and sends when you stop talking).
  const holdRef = useRef(false);
  const onCommand = useRef<(cmd: string) => void>(() => undefined);
  onCommand.current = (cmd: string) => {
    const p = phaseRef.current;
    if (cmd === "cancel") return close();
    if (cmd === "hold-start" || cmd === "wake-listen") {
      window.clearTimeout(hideTimer.current);
      holdRef.current = cmd === "hold-start";
      setHoldHint(holdRef.current);
      listen();
      if (holdRef.current) capture.holdStarted();
      return;
    }
    if (cmd === "hold-end") {
      if (!holdRef.current) return;
      if (p !== "listening" && p !== "starting") {
        holdRef.current = false;
        return;
      }
      if (capture.hasSpeech()) {
        holdRef.current = false;
        void capture.finish("manual");
        return;
      }
      // Let go before saying anything: that was a tap, not a hold. Keep
      // listening and send when they stop talking (auto-stop is back on).
      holdRef.current = false;
      capture.tapConfirmed();
      setHoldHint(false);
      return;
    }
    if (p === "listening" || p === "starting") {
      if (cmd === "toggle" || cmd === "stop") void capture.finish("manual");
      return;
    }
    if (cmd === "stop" || p === "transcribing" || stageRef.current === "thinking") return;
    listen();
  };

  // The shell heard "Hey Soundwave, …" and sends what came after it.
  useEffect(() => {
    if (!desktop) return;
    return desktop.onWakeHit(({ text }) => {
      const said = String(text ?? "").trim();
      if (!said) return;
      window.clearTimeout(hideTimer.current);
      stopSpeaking();
      void answer(said);
    });
  }, [desktop, answer]);

  useEffect(() => {
    if (!desktop) return;
    desktop
      .getState()
      .then((s) => setHotkey(s.hotkey))
      .catch(() => undefined);
    return desktop.onVoiceCommand((cmd) => onCommand.current(cmd));
  }, [desktop]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const listening = phase === "listening" || phase === "starting";
  const title = listening
    ? phase === "starting"
      ? "Starting microphone…"
      : "Listening…"
    : phase === "transcribing"
      ? "Transcribing…"
      : stage === "thinking"
        ? "Thinking…"
        : stage === "speaking"
          ? "Soundwave"
          : stage === "error"
            ? "Voice input"
            : stage === "done"
              ? "Soundwave"
              : "Ready";
  const body = problem
    ? problem.text
    : stage === "speaking" || stage === "done"
      ? reply
      : stage === "thinking" || phase === "transcribing"
        ? heard || "…"
        : listening
          ? "I'm listening — try “make a short about black holes”."
          : `Press ${hotkeyLabel(hotkey)} to talk to Soundwave.`;
  const orbState = listening ? "LISTENING" : phase === "transcribing" || stage === "thinking" ? "THINKING" : stage === "speaking" ? "SPEAKING" : "STANDBY";

  return (
    <div className="fixed inset-0 flex items-end justify-center p-2.5 select-none">
      <div
        className={`flex w-full items-center gap-3 rounded-2xl border bg-[#081022]/95 px-3 py-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-xl transition-colors ${
          stage === "error" ? "border-amber-500/40" : listening ? "border-emerald-400/40" : "border-cyan-500/25"
        }`}
        role="status"
        aria-live="polite"
      >
        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center">
          <div
            className={`absolute inset-0 rounded-full blur-md transition-all duration-150 ${listening ? "bg-emerald-400/25" : "bg-cyan-500/15"}`}
            style={listening ? { transform: `scale(${0.85 + level * 0.5})` } : undefined}
          />
          <ThinkingOrbVisualizer assistantState={orbState} size={46} bare className="relative" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`font-mono text-[10px] font-bold uppercase tracking-[0.22em] ${
                stage === "error" ? "text-amber-300" : listening ? "text-emerald-300" : "text-cyan-300"
              }`}
            >
              {title}
            </span>
            {(phase === "transcribing" || stage === "thinking") && <Loader2 className="h-3 w-3 animate-spin text-cyan-300" />}
            {listening && (
              <span className="h-1 w-16 overflow-hidden rounded-full bg-white/10" aria-hidden>
                <span className="block h-full rounded-full bg-emerald-400 transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
              </span>
            )}
          </div>
          <p
            className={`mt-0.5 text-[13px] leading-snug ${stage === "speaking" || stage === "done" ? "line-clamp-3" : "line-clamp-2"} ${
              stage === "thinking" || phase === "transcribing" ? "text-cyan-100" : "text-gray-100"
            }`}
          >
            {stage === "thinking" || phase === "transcribing" ? (heard ? `“${heard}”` : body) : body}
          </p>
          {listening && (
            <p className="mt-0.5 font-mono text-[10px] text-gray-500">
              {holdHint ? `Release ${hotkeyLabel(hotkey)} to send` : `Pause to send · ${hotkeyLabel(hotkey)} sends now`}
            </p>
          )}
          {voiceWarning && stage === "done" && <p className="mt-0.5 line-clamp-1 text-[10px] text-amber-300/90" title={voiceWarning}>{voiceWarning}</p>}
          {problem?.micSettings && (
            <button
              type="button"
              onClick={() => desktop?.openMicrophoneSettings()}
              className="mt-1 inline-flex items-center gap-1 rounded-md border border-amber-500/40 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/10"
            >
              <Settings2 className="h-3 w-3" /> Open microphone settings
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {listening ? (
            <button
              type="button"
              onClick={() => void capture.finish("manual")}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-400/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
              title="Send"
              aria-label="Stop listening and send"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            (stage === "idle" || stage === "done" || stage === "error" || stage === "speaking") &&
            phase === "idle" && (
              <button
                type="button"
                onClick={listen}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
                title="Talk"
                aria-label="Talk"
              >
                <Mic className="h-4 w-4" />
              </button>
            )
          )}
          {desktop && (
            <button
              type="button"
              onClick={() => {
                desktop.showApp("/agent");
                close();
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-white/10 hover:text-white"
              title="Open the Command Center"
              aria-label="Open the Command Center"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-white/10 hover:text-white"
            title="Close"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
