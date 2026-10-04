import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, RefreshCw, Settings2, Smartphone, Sparkles, Square, Sunrise, VolumeX, WifiOff } from "lucide-react";
import type { ChatMessage, ConnectionState } from "../lib/client";
import type { BriefingPhase, Companion, PhoneChat } from "../state/useCompanion";
import { useVoiceInput } from "../state/useVoiceInput";
import { toast } from "../lib/toast";
import { Composer } from "./Composer";
import { JobCard, MessageBubble, Typing } from "./Message";
import { VideoSheet } from "./VideoSheet";
import { cn, IconButton, Logo } from "./ui";

const SUGGESTIONS = ["Make a YouTube short about black holes", "How do I link my YouTube channel?", "How's my PC doing?"];
const PHONE_SUGGESTIONS = ["What did we work on last time?", "Give me three short ideas", "How do I link my YouTube channel?"];

function statusLine(state: ConnectionState, pcName: string, phoneMode: boolean): string {
  if (phoneMode && state.kind !== "online") return `${pcName} is off — chatting on your phone`;
  switch (state.kind) {
    case "online":
      return `Connected to ${pcName}`;
    case "connecting":
      return `Connecting to ${pcName}…`;
    case "searching":
      return `Looking for ${pcName} on your network…`;
    case "offline":
      return `${pcName} is offline`;
    case "forgotten":
      return "Not paired";
  }
}

function phoneChatHint(chat: PhoneChat): string {
  if (chat.ready) return "";
  switch (chat.reason) {
    case "sharing_off":
      return " To chat without the PC, turn on “Chat from the phone when this PC is off” in Soundwave AI → Settings → Phone.";
    case "no_key":
      return " To chat without the PC, add a Gemini key in Soundwave AI → Settings → Brain.";
    case "old_pc":
      return " Update Soundwave AI on your PC to chat from the phone while it's off.";
    default:
      return "";
  }
}

/** The morning briefing being prepared or spoken (it starts by itself when the app opens). */
function BriefingBar({ phase, onStop }: { phase: BriefingPhase; onStop: () => void }) {
  if (phase.kind === "idle") return null;
  const preparing = phase.kind === "preparing";
  return (
    <div className="mx-3 mb-1 mt-2 flex items-center gap-3 rounded-3xl border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3" role="status" data-testid="briefing-bar" data-phase={phase.kind}>
      {preparing ? <Loader2 className="h-5 w-5 shrink-0 animate-spin text-amber-300" /> : <Sunrise className="h-5 w-5 shrink-0 text-amber-300" />}
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] font-semibold text-amber-50">{preparing ? "Getting your morning briefing ready…" : "Your morning briefing"}</p>
        <p className="truncate text-[12.5px] text-amber-100/70">
          {preparing
            ? `${phase.by === "phone" ? "Researching on the phone" : "Researching"}${phase.topics.length ? `: ${phase.topics.join(" · ")}` : ""}`
            : "Tap Stop to stop it"}
        </p>
      </div>
      <button
        type="button"
        onClick={onStop}
        className="flex items-center gap-1.5 rounded-full bg-amber-300/15 px-3 py-2 text-[13px] font-semibold text-amber-100 active:bg-amber-300/25"
        data-testid="briefing-stop"
      >
        <Square className="h-3.5 w-3.5 fill-current" /> {preparing ? "Skip" : "Stop"}
      </button>
    </div>
  );
}

/** The PC is off but the phone answers by itself — calm, not an error. */
function PhoneModeBanner({ pcName, pending, onRetry }: { pcName: string; pending: number; onRetry: () => void }) {
  return (
    <div className="mx-3 mt-3 animate-rise-in rounded-3xl border border-violet-400/25 bg-violet-500/[0.08] p-4" role="status" data-testid="phone-mode-banner">
      <div className="flex items-start gap-3">
        <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-violet-300" />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-violet-50">{pcName} is off — I'm here on your phone</p>
          <p className="mt-1 text-[13.5px] leading-snug text-violet-100/75">
            Keep chatting: I remember our conversation. Making shorts, videos and anything on the PC wait until it's back
            {pending ? ` — ${pending} message${pending === 1 ? "" : "s"} will sync then.` : "."}
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button type="button" onClick={onRetry} className="flex items-center gap-1.5 rounded-full bg-violet-300/15 px-3.5 py-2 text-[13px] font-semibold text-violet-100 active:bg-violet-300/25">
          <RefreshCw className="h-3.5 w-3.5" /> Look for the PC
        </button>
      </div>
    </div>
  );
}

function OfflineBanner({ state, pcName, onRetry, chat }: { state: ConnectionState; pcName: string; onRetry: () => void; chat: PhoneChat }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (state.kind !== "offline") return null;
  const secs = state.retryAt ? Math.max(0, Math.ceil((state.retryAt - now) / 1000)) : 0;
  return (
    <div className="mx-3 mt-3 animate-rise-in rounded-3xl border border-amber-400/25 bg-amber-400/[0.08] p-4" role="status" data-testid="offline-banner">
      <div className="flex items-start gap-3">
        <WifiOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-amber-50">Can't reach {pcName}</p>
          <p className="mt-1 text-[13.5px] leading-snug text-amber-100/75">
            {state.detail === "error" && state.message
              ? state.message
              : `Make sure Soundwave AI is running on your PC (the tray counts), phone access is on in Settings → Phone, and your phone is on the same Wi-Fi.${phoneChatHint(chat)}`}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between pl-8">
        <span className="text-[12px] text-amber-100/60">{secs > 0 ? `Trying again in ${secs} s` : "Trying…"}</span>
        <button type="button" onClick={onRetry} className="flex items-center gap-1.5 rounded-full bg-amber-300/15 px-3.5 py-2 text-[13px] font-semibold text-amber-100 active:bg-amber-300/25">
          <RefreshCw className="h-3.5 w-3.5" /> Try now
        </button>
      </div>
    </div>
  );
}

export function Chat({ companion, onOpenSettings }: { companion: Companion; onOpenSettings: () => void }) {
  const { state, conversation, jobs, pc, record, client, speaking, phoneMode } = companion;
  const pcName = record?.pcName ?? "your PC";
  const messages = useMemo(() => conversation?.messages ?? [], [conversation]);
  const online = state.kind === "online";
  const canChat = online || phoneMode;
  const [pending, setPending] = useState<{ text: string; viaVoice: boolean } | null>(null);
  const [video, setVideo] = useState<{ jobId: string; topic: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const send = useCallback(
    async (text: string, viaVoice = false) => {
      setPending({ text, viaVoice });
      stick.current = true;
      try {
        await companion.send(text, { viaVoice });
      } catch (err) {
        toast(`Couldn't send that: ${(err as Error).message}`, "error");
      } finally {
        setPending(null);
      }
    },
    [companion],
  );

  const runMorning = useCallback(async () => {
    setPending({ text: "🌅 Morning Setup", viaVoice: false });
    stick.current = true;
    try {
      await companion.morning();
    } catch (err) {
      toast(`Morning Setup didn't run: ${(err as Error).message}`, "error");
    } finally {
      setPending(null);
    }
  }, [companion]);

  const voice = useVoiceInput({
    transcribe: (wav, signal) => {
      if (!client) throw new Error("Not connected to your PC.");
      return companion.transcribe(wav, signal);
    },
    onText: (text) => void send(text, true),
    onNothingHeard: () => toast("I didn't catch that — try again, a little closer to the phone."),
    onError: (message) => toast(message, "error", 6000),
  });

  // Keep the newest message in view (unless you scrolled up to read).
  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);
  useLayoutEffect(() => {
    if (stick.current) scrollToEnd(false);
  }, [messages.length, pending, jobs.length, scrollToEnd]);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // The keyboard opening shrinks the list: stay at the bottom.
    const ro = new ResizeObserver(() => stick.current && scrollToEnd(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToEnd]);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = atEnd;
    setShowJump(!atEnd);
  };

  const voiceUnavailable = online ? (pc && !pc.voiceInput.available ? pc.voiceInput.reason || "not set up on your PC." : null) : phoneMode ? null : "voice input needs your PC.";
  const dot = online ? "bg-emerald-400" : phoneMode ? "bg-violet-400" : state.kind === "offline" ? "bg-amber-400" : "bg-sky-400 animate-pulse";

  return (
    <div className="flex h-full flex-col" data-testid="chat">
      <header className="flex items-center gap-3 border-b border-line bg-navy/95 px-4 pb-3 pt-[calc(var(--sat)+12px)] backdrop-blur">
        <div className="relative">
          <Logo size={42} />
          <span className={cn("absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-[3px] border-navy", dot)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-semibold leading-tight">Soundwave</p>
          <p className="truncate text-[13px] text-gray-400" data-testid="status-line">
            {statusLine(state, pcName, phoneMode)}
          </p>
        </div>
        {speaking && (
          <IconButton
            label="Stop reading"
            onClick={() => {
              companion.stopBriefing();
              companion.stopSpeaking();
            }}
            className="text-cyan-300"
          >
            <VolumeX className="h-5 w-5" />
          </IconButton>
        )}
        <IconButton label="Settings" onClick={onOpenSettings} data-testid="settings-button">
          <Settings2 className="h-5 w-5" />
        </IconButton>
      </header>

      {phoneMode ? (
        <PhoneModeBanner pcName={pcName} pending={companion.pendingForPc} onRetry={companion.retry} />
      ) : (
        <OfflineBanner state={state} pcName={pcName} onRetry={companion.retry} chat={companion.phoneChat} />
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={listRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain px-4 pb-4 pt-4" data-testid="message-list">
          {messages.length === 0 && !pending && (
            <div className="flex flex-col items-center px-6 pt-16 text-center">
              <Logo size={64} glow />
              <p className="mt-5 text-[17px] font-semibold">{online ? `Connected to ${pcName}` : phoneMode ? "Your PC is off — say hello anyway" : "Say hello"}</p>
              <p className="mt-1.5 text-[14px] text-gray-400">This is the same conversation as the Command Center on your PC.</p>
            </div>
          )}
          <div className="space-y-2.5">
            {messages.map((m: ChatMessage, i) => {
              const prev = messages[i - 1];
              const side = (x?: ChatMessage) => (x ? (x.sender === "user" ? (x.via === "phone" ? "phone" : "pc") : "agent") : "");
              return (
                <MessageBubble
                  key={m.id}
                  m={m}
                  first={side(prev) !== side(m)}
                  onWatch={(jobId, topic) => (online ? setVideo({ jobId, topic }) : toast("Watching shorts needs your PC — it's off right now."))}
                  onSpeak={(msg) => (online ? void companion.speak(msg) : toast("Reading aloud needs your PC (its Soundwave voices)."))}
                />
              );
            })}
            {pending && (
              <>
                <div className="flex flex-col items-end opacity-70">
                  <div className="max-w-[86%] whitespace-pre-wrap rounded-[22px] rounded-br-md bg-gradient-to-br from-blue-600 to-violet-600 px-4 py-2.5 text-[15.5px] text-white">{pending.text}</div>
                  <span className="mt-1 px-1.5 text-[11px] text-gray-500">Sending…</span>
                </div>
                <Typing />
              </>
            )}
            {jobs
              .filter((j) => j.status === "PROCESSING" || j.status === "QUEUED")
              .map((j) => (
                <JobCard key={j.id} job={j} />
              ))}
          </div>
          {!messages.some((m) => m.sender === "user") && !pending && canChat && (
            <div className="mt-6 space-y-2">
              <p className="flex items-center gap-1.5 px-1 text-[12px] font-medium text-gray-500">
                <Sparkles className="h-3.5 w-3.5" /> Try
              </p>
              {(online ? SUGGESTIONS : PHONE_SUGGESTIONS).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="block w-full rounded-2xl border border-line bg-white/[0.03] px-4 py-3 text-left text-[15px] text-gray-200 active:bg-white/[0.07]"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
        {showJump && (
          <button
            type="button"
            onClick={() => scrollToEnd(true)}
            aria-label="Newest messages"
            className="absolute bottom-3 right-4 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-elevated text-gray-200 shadow-lg"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        )}
      </div>

      <BriefingBar phase={companion.briefing} onStop={companion.stopBriefing} />

      {canChat && (
        <div className="flex gap-2 overflow-x-auto border-t border-line bg-navy/95 px-3 pt-2" data-testid="quick-actions">
          <button
            type="button"
            onClick={() => void runMorning()}
            disabled={Boolean(pending)}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-amber-300/25 bg-amber-300/[0.07] px-3.5 text-[13.5px] font-medium text-amber-100 active:bg-amber-300/15 disabled:opacity-50"
            data-testid="morning-chip"
          >
            <Sunrise className="h-4 w-4 text-amber-300" /> Morning Setup
          </button>
        </div>
      )}

      <Composer
        disabled={!canChat}
        disabledHint={state.kind === "offline" ? `Waiting for ${pcName}…` : "Connecting…"}
        voice={voice}
        voiceUnavailable={voiceUnavailable}
        onSend={(t) => void send(t)}
      />

      <VideoSheet client={client} video={video} onClose={() => setVideo(null)} />
    </div>
  );
}
