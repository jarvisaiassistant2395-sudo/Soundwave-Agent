import { useState } from "react";
import { AlarmClock, Bell, Brain, Check, Laptop, Lock, Play, Sunrise, Unlink } from "lucide-react";
import { VOICE_META } from "../../../frontend/src/lib/voices";
import type { Companion } from "../state/useCompanion";
import type { SpeakMode } from "../lib/storage";
import { useBackHandler } from "../lib/back";
import { APP_VERSION } from "../lib/native";
import { cn, GhostButton, Sheet } from "./ui";

const SPEAK_MODES: Array<{ id: SpeakMode; label: string }> = [
  { id: "voice", label: "When I talk" },
  { id: "always", label: "Always" },
  { id: "never", label: "Never" },
];

function phoneChatLine(companion: Companion): { title: string; detail: string; ok: boolean } {
  const chat = companion.phoneChat;
  if (chat.ready) {
    const notes = companion.memory?.notes.length ?? 0;
    const synced = companion.memory ? new Date(companion.memory.takenAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : null;
    return {
      ok: true,
      title: `Ready — ${chat.modelLabel}`,
      detail: `When the PC is off, Gemini answers right here with your conversation and the agent's memory${synced ? ` (${notes} note${notes === 1 ? "" : "s"}, from ${synced})` : ""}.${
        companion.pendingForPc ? ` ${companion.pendingForPc} thing${companion.pendingForPc === 1 ? "" : "s"} will sync to the PC when it's back.` : ""
      }`,
    };
  }
  switch (chat.reason) {
    case "sharing_off":
      return { ok: false, title: "Off on the PC", detail: "Turn on “Chat from the phone when this PC is off” in Soundwave AI → Settings → Phone." };
    case "no_key":
      return { ok: false, title: "Needs a Gemini key", detail: "Add your free Gemini key in Soundwave AI → Settings → Brain on the PC." };
    case "old_pc":
      return { ok: false, title: "Update the PC app", detail: "Soundwave AI 1.4 or newer on the PC lets the phone chat while the PC is off." };
    default:
      return { ok: false, title: "Not set up yet", detail: "Connect to your PC once and it's set up automatically." };
  }
}

export function SettingsSheet({ open, onClose, companion }: { open: boolean; onClose: () => void; companion: Companion }) {
  const { record, pc, state, settings, updateSettings } = companion;
  const [confirming, setConfirming] = useState(false);
  const [delayDraft, setDelayDraft] = useState<string | null>(null);
  useBackHandler(open, onClose);
  if (!record) return null;
  const pcVoice = pc?.voice ?? null;
  const pcVoiceName = VOICE_META.find((v) => v.id === pcVoice)?.displayName;

  // Plays with the voice just picked (settings apply immediately).
  const preview = () => void companion.speak({ id: "preview", sender: "assistant", text: "Hi! This is how I'll sound on your phone.", time: "" });

  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <section className="rounded-3xl border border-line bg-navy/60 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/[0.06]">
            <Laptop className="h-5 w-5 text-gray-200" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[16px] font-semibold">{record.pcName}</p>
            <p className="text-[13px] text-gray-400">
              {state.kind === "online" ? <span className="text-emerald-400">Connected</span> : state.kind === "offline" ? "Offline" : "Connecting…"} · {record.hosts[0]}
              {record.port !== 47800 ? `:${record.port}` : ""}
            </p>
          </div>
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[12px] text-gray-500">
          <Lock className="h-3.5 w-3.5 text-emerald-400" /> End-to-end encrypted · paired {new Date(record.pairedAt).toLocaleDateString()}
        </p>
      </section>

      <section className="mt-6" data-testid="phone-chat-status">
        <h3 className="px-1 text-[13px] font-semibold uppercase tracking-[0.12em] text-gray-500">Chat without the PC</h3>
        {(() => {
          const line = phoneChatLine(companion);
          return (
            <div className="mt-2 flex items-start gap-3 rounded-3xl border border-line bg-navy/60 p-4">
              <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl", line.ok ? "bg-violet-500/15 text-violet-300" : "bg-white/[0.06] text-gray-400")}>
                <Brain className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className={cn("text-[15px] font-semibold", line.ok ? "text-violet-100" : "text-gray-200")}>{line.title}</p>
                <p className="mt-0.5 text-[13px] leading-snug text-gray-400">{line.detail}</p>
              </div>
            </div>
          );
        })()}
      </section>

      <section className="mt-6" data-testid="briefing-settings">
        <h3 className="px-1 text-[13px] font-semibold uppercase tracking-[0.12em] text-gray-500">Morning briefing</h3>
        <div className="mt-2 rounded-3xl border border-line bg-navy/60 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-300/10 text-amber-300">
              <Sunrise className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-gray-100">
                {companion.briefingPlan?.auto ? `Every morning at ${companion.briefingPlan.time}` : "Only when you start it"}
              </p>
              <p className="mt-0.5 text-[13px] leading-snug text-gray-400">
                {companion.briefingPlan?.topics.length
                  ? `Researched with Gemini: ${companion.briefingPlan.topics.join(" · ")}`
                  : "Weather, your shorts and ideas. Add your own topics — tell me (“brief me on trending GitHub repos”) or use Settings → Morning Setup on the PC."}
              </p>
            </div>
          </div>
          <label className="mt-4 flex items-center justify-between gap-3">
            <span className="text-[14.5px] text-gray-200">Talk when I open the app</span>
            <input
              type="checkbox"
              checked={settings.talkOnOpen}
              onChange={(e) => updateSettings({ talkOnOpen: e.target.checked })}
              className="h-6 w-11 cursor-pointer accent-violet-500"
              data-testid="talk-on-open"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              onClose();
              void companion.hearBriefing();
            }}
            className="mt-3 h-11 w-full rounded-2xl bg-amber-300/15 text-[14.5px] font-semibold text-amber-100 active:bg-amber-300/25"
            data-testid="hear-briefing"
          >
            Hear today's briefing now
          </button>
        </div>
      </section>

      <section className="mt-6" data-testid="alarm-settings">
        <h3 className="px-1 text-[13px] font-semibold uppercase tracking-[0.12em] text-gray-500">Alarm &amp; the briefing</h3>
        <div className="mt-2 rounded-3xl border border-line bg-navy/60 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-400/10 text-sky-300">
              <AlarmClock className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-gray-100">
                {companion.alarms.length === 0
                  ? "No alarm set"
                  : `Next alarm ${new Date(companion.alarms[0]!.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${companion.alarms[0]!.label ? ` — ${companion.alarms[0]!.label}` : ""}${companion.alarms.length > 1 ? ` (+${companion.alarms.length - 1} more)` : ""}`}
              </p>
              <p className="mt-0.5 text-[13px] leading-snug text-gray-400">
                Ask me: “set an alarm for 6:30”. The alarm rings here, and after you turn it off your morning briefing starts by itself.
              </p>
            </div>
          </div>

          <label className="mt-4 flex items-center justify-between gap-3">
            <span className="text-[14.5px] text-gray-200">Start my briefing</span>
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={600}
                inputMode="numeric"
                value={delayDraft ?? String(companion.briefingDelaySeconds)}
                onChange={(e) => setDelayDraft(e.target.value)}
                onBlur={() => {
                  if (delayDraft !== null) {
                    void companion.setBriefingDelaySeconds(Number(delayDraft) || 0);
                    setDelayDraft(null);
                  }
                }}
                className="h-10 w-20 rounded-xl border border-line bg-black/30 px-3 text-center text-[15px] text-gray-100 outline-none focus:border-violet-400"
                data-testid="alarm-delay-input"
              />
              <span className="text-[14.5px] text-gray-400">s after</span>
            </span>
          </label>
          <p className="mt-1 text-[12.5px] text-gray-500">seconds after I turn the alarm off (0–600)</p>

          {companion.alarmOutput && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-black/20 px-3 py-2.5" data-testid="alarm-output">
              <span className="min-w-0 flex-1 text-[13px] leading-snug text-gray-300">
                {companion.alarmOutput.bluetooth && companion.alarmOutput.useEarbuds ? (
                  <>
                    Rings on <span className="font-semibold text-gray-100">{companion.alarmOutput.bluetooth}</span> (Bluetooth)
                  </>
                ) : companion.alarmOutput.bluetooth ? (
                  <>
                    Rings on the phone speaker — <span className="text-gray-100">{companion.alarmOutput.bluetooth}</span> are connected, but ringing in them is off.
                  </>
                ) : (
                  <>Rings on the phone speaker — connect your earbuds and it rings there instead.</>
                )}
              </span>
              {companion.alarmOutput.bluetooth && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={companion.alarmOutput.useEarbuds}
                  aria-label="Ring in my Bluetooth earbuds"
                  onClick={() => void companion.setAlarmEarbuds(!companion.alarmOutput!.useEarbuds)}
                  data-testid="alarm-earbuds"
                  className={`h-8 w-14 shrink-0 rounded-full text-[12px] font-semibold transition ${companion.alarmOutput.useEarbuds ? "bg-violet-500 text-white" : "bg-white/10 text-gray-300"}`}
                >
                  {companion.alarmOutput.useEarbuds ? "On" : "Off"}
                </button>
              )}
            </div>
          )}

          {companion.alarms.length > 0 && (
            <button
              type="button"
              onClick={() => void companion.cancelAlarm(companion.alarms[0]!.id)}
              className="mt-3 h-11 w-full rounded-2xl bg-white/[0.06] text-[14.5px] font-semibold text-gray-200 active:bg-white/10"
              data-testid="alarm-cancel"
            >
              Cancel the next alarm
            </button>
          )}

          {!companion.notifications && (
            <button
              type="button"
              onClick={() => void companion.allowNotifications()}
              className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-sky-400/15 text-[14.5px] font-semibold text-sky-100 active:bg-sky-400/25"
              data-testid="alarm-notifications"
            >
              <Bell className="h-4 w-4" /> Allow notifications (alarms need this)
            </button>
          )}
        </div>
      </section>

      <section className="mt-6">
        <h3 className="px-1 text-[13px] font-semibold uppercase tracking-[0.12em] text-gray-500">Read replies aloud</h3>
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-2xl border border-line bg-navy/60 p-1">
          {SPEAK_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => updateSettings({ speak: mode.id })}
              className={cn(
                "h-11 rounded-xl text-[14px] font-medium transition",
                settings.speak === mode.id ? "bg-gradient-to-r from-blue-600 to-violet-600 text-white" : "text-gray-400 active:bg-white/5",
              )}
              aria-pressed={settings.speak === mode.id}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h3 className="px-1 text-[13px] font-semibold uppercase tracking-[0.12em] text-gray-500">Voice</h3>
        <div className="mt-2 overflow-hidden rounded-3xl border border-line bg-navy/60">
          {[{ id: null as string | null, label: `Same as the PC${pcVoiceName ? ` (${pcVoiceName})` : ""}`, sub: "Follows the voice picked in the Command Center" }, ...VOICE_META.map((v) => ({ id: v.id as string | null, label: v.displayName, sub: `${v.accent} · ${v.gender}` }))].map(
            (v) => {
              const selected = settings.voice === v.id;
              return (
                <div key={v.id ?? "pc"} className="flex items-center border-b border-line last:border-b-0">
                  <button type="button" onClick={() => updateSettings({ voice: v.id })} className="flex min-h-[56px] flex-1 items-center gap-3 px-4 text-left active:bg-white/5">
                    <span className={cn("flex h-5 w-5 items-center justify-center rounded-full border", selected ? "border-violet-400 bg-violet-500" : "border-gray-600")}>
                      {selected && <Check className="h-3 w-3 text-white" />}
                    </span>
                    <span>
                      <span className="block text-[15px] text-gray-100">{v.label}</span>
                      <span className="block text-[12px] text-gray-500">{v.sub}</span>
                    </span>
                  </button>
                  {selected && (
                    <button type="button" onClick={preview} aria-label="Hear it" className="mr-2 flex h-10 w-10 items-center justify-center rounded-full text-cyan-300 active:bg-white/10">
                      <Play className="h-4 w-4 fill-current" />
                    </button>
                  )}
                </div>
              );
            },
          )}
        </div>
      </section>

      <section className="mt-8">
        {confirming ? (
          <div className="rounded-3xl border border-red-400/25 bg-red-500/10 p-4">
            <p className="text-[15px] text-red-100">Unpair from {record.pcName}? You'll need to scan a new code on the PC to use it again.</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <GhostButton onClick={() => setConfirming(false)}>Keep</GhostButton>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  void companion.unpair();
                }}
                className="h-12 rounded-2xl bg-red-500/90 text-[15px] font-semibold text-white active:bg-red-500"
                data-testid="confirm-unpair"
              >
                Unpair
              </button>
            </div>
          </div>
        ) : (
          <GhostButton onClick={() => setConfirming(true)} icon={<Unlink className="h-4 w-4 text-red-300" />} className="text-red-200" data-testid="unpair-button">
            Unpair this phone
          </GhostButton>
        )}
      </section>

      <p className="mt-6 text-center text-[12px] text-gray-600">Soundwave companion {APP_VERSION} · the full agent while Soundwave AI runs on your PC, chat when it's off</p>
    </Sheet>
  );
}
