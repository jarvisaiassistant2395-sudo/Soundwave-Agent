import { useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, Square, X } from "lucide-react";
import type { MicPhase } from "../state/useVoiceInput";
import { cn, IconButton } from "./ui";

interface VoiceControls {
  phase: MicPhase;
  level: number;
  finish: () => void;
  cancel: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: () => void;
}

/** Level meter: bars that follow the microphone. */
function Bars({ level }: { level: number }) {
  const history = useRef<number[]>(Array(24).fill(0));
  const [, force] = useState(0);
  useEffect(() => {
    history.current = [...history.current.slice(1), level];
    force((n) => n + 1);
  }, [level]);
  return (
    <div className="flex h-7 flex-1 items-center gap-[3px] overflow-hidden" aria-hidden="true">
      {history.current.map((v, i) => (
        <span
          key={i}
          className="w-[3px] shrink-0 rounded-full bg-gradient-to-t from-cyan-400 to-violet-400"
          style={{ height: `${Math.max(12, Math.min(100, v * 260))}%`, opacity: 0.35 + (i / history.current.length) * 0.65 }}
        />
      ))}
    </div>
  );
}

export function Composer({
  disabled,
  disabledHint,
  voice,
  voiceUnavailable,
  onSend,
}: {
  disabled: boolean;
  disabledHint: string;
  voice: VoiceControls;
  /** Why voice input can't work on this PC (null when it can). */
  voiceUnavailable: string | null;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const active = voice.phase !== "idle";

  // Grow with the text (up to 5 lines).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    setText("");
    onSend(t);
  };

  return (
    <div className="border-t border-line bg-navy/95 px-3 pt-2.5 pb-[calc(var(--sab)+10px)] backdrop-blur">
      <div className="flex items-end gap-2">
        {active ? (
          <div className="flex min-h-[52px] flex-1 items-center gap-3 rounded-[26px] border border-violet-400/30 bg-violet-500/10 pl-2 pr-4" data-testid="listening-bar">
            <IconButton label="Cancel" onClick={voice.cancel} className="h-10 w-10 text-gray-300">
              <X className="h-5 w-5" />
            </IconButton>
            {voice.phase === "transcribing" ? (
              <span className="flex flex-1 items-center gap-2 text-[15px] text-violet-100">
                <span className="sw-dots flex gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                </span>
                Understanding…
              </span>
            ) : (
              <>
                <Bars level={voice.level} />
                <span className="shrink-0 text-[13px] font-medium text-violet-100">{voice.phase === "starting" ? "Starting…" : "Listening"}</span>
              </>
            )}
          </div>
        ) : (
          <div className={cn("flex min-h-[52px] flex-1 items-end rounded-[26px] border border-line bg-panel px-4", disabled && "opacity-60")}>
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={disabled ? disabledHint : "Message Soundwave"}
              disabled={disabled}
              enterKeyHint="send"
              className="selectable max-h-[132px] w-full resize-none bg-transparent py-[14px] text-[16px] leading-6 text-white outline-none placeholder:text-gray-500"
              data-testid="composer-input"
            />
          </div>
        )}

        {!active && text.trim() ? (
          <button
            type="button"
            onClick={submit}
            disabled={disabled}
            aria-label="Send"
            className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-[0_6px_20px_-6px_rgba(99,102,241,0.9)] active:scale-95 disabled:opacity-50"
            data-testid="send-button"
          >
            <ArrowUp className="h-6 w-6" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={active ? "Send what I said" : voiceUnavailable ? "Voice input unavailable" : "Talk (tap, or hold and release)"}
            disabled={disabled || (!active && Boolean(voiceUnavailable)) || voice.phase === "transcribing"}
            onPointerDown={voice.onPointerDown}
            onPointerUp={voice.onPointerUp}
            onPointerCancel={voice.onPointerCancel}
            onContextMenu={(e) => e.preventDefault()}
            className={cn(
              "relative flex h-[52px] w-[52px] shrink-0 touch-none items-center justify-center rounded-full text-white transition active:scale-95 disabled:opacity-40",
              active ? "sw-ring bg-violet-600" : "bg-gradient-to-br from-blue-600 to-violet-600 shadow-[0_6px_20px_-6px_rgba(99,102,241,0.9)]",
            )}
            data-testid="mic-button"
          >
            <span className="relative z-10">{active ? <Square className="h-5 w-5 fill-current" /> : <Mic className="h-6 w-6" />}</span>
          </button>
        )}
      </div>
      {!active && !disabled && voiceUnavailable && <p className="mt-1.5 px-2 text-[11px] text-gray-500">Voice input: {voiceUnavailable}</p>}
    </div>
  );
}
