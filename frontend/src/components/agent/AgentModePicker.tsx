import { useEffect, useRef, useState } from "react";
import { BadgeCheck, BarChart3, Briefcase, Check, ChevronDown, Flame, Loader2, Moon, Smile } from "lucide-react";
import { cn } from "../../lib/cn";
import { toast } from "../../store/toast";
import { useAgentModes, type AgentMode, type AgentModeId } from "../../lib/agentModes";

// ── How the agent talks, chosen in one place ────────────────────────────────
// The modes come from the server (brain/core/persona.ts): Executive Assistant
// (formal, “sir”), Friendly, Hype Coach, Analyst, Calm. Picking one saves it
// and the very next reply is in that voice — the agent also switches itself
// when it is asked to (set_mode), and the pill follows within a few seconds.

const ICONS: Record<string, typeof Briefcase> = {
  briefcase: Briefcase,
  smile: Smile,
  flame: Flame,
  chart: BarChart3,
  moon: Moon,
};

export function modeIcon(icon: string): typeof Briefcase {
  return ICONS[icon] ?? Briefcase;
}

/** The pill in the header: the current mode, and the list behind it. */
export function AgentModePicker({ compact = false, align = "right" }: { compact?: boolean; align?: "left" | "right" }) {
  const { modes, current, loading, setMode } = useAgentModes();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<AgentModeId | null>(null);
  const [address, setAddress] = useState("");
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setAddress(current?.address ?? "");
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, current?.address]);

  const active = modes.find((m) => m.id === current?.persona);
  const Icon = modeIcon(active?.icon ?? "smile");

  const pick = async (mode: AgentMode) => {
    if (mode.id === current?.persona) {
      setOpen(false);
      return;
    }
    setBusy(mode.id);
    const state = await setMode(mode.id);
    setBusy(null);
    if (!state) {
      toast.error("Could not change the assistant's mode.");
      return;
    }
    toast.success(`Mode: ${state.current.name}`);
    setOpen(false);
  };

  const saveAddress = async () => {
    const wanted = address.trim();
    if (wanted === (current?.address ?? "")) {
      setOpen(false);
      return;
    }
    const state = await setMode(current?.persona ?? "professional", wanted);
    if (!state) {
      toast.error("Could not save that.");
      return;
    }
    toast.success(wanted ? `The assistant will call you ${wanted}.` : "Title cleared.");
    setOpen(false);
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={active ? `${active.name} — ${active.tagline}` : "How the assistant talks"}
        className={cn(
          "sw-pill sw-pill-button",
          open && "border-cyan-400/50 text-white",
          compact ? "px-2.5 py-1 text-[11px]" : "text-xs",
        )}
      >
        {loading && !active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5 text-cyan-300" />}
        <span className="max-w-[9rem] truncate font-medium">{active?.name ?? "Mode"}</span>
        {!compact && current?.address ? <span className="text-gray-500">· {current.address}</span> : null}
        <ChevronDown className={cn("h-3 w-3 text-gray-500 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Assistant mode"
          className={cn(
            "sw-rise absolute z-40 mt-2 w-[19rem] overflow-hidden rounded-2xl border border-white/10 bg-[#0b0c0f]/98 p-1.5 shadow-2xl shadow-black/70 backdrop-blur-xl",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <p className="px-2.5 pb-1.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-gray-500">How the assistant talks</p>
          {modes.map((mode) => {
            const ModeIcon = modeIcon(mode.icon);
            const isActive = mode.id === current?.persona;
            return (
              <button
                key={mode.id}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => void pick(mode)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
                  isActive ? "bg-cyan-500/10" : "hover:bg-white/[0.05]",
                )}
              >
                <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border", isActive ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-200" : "border-white/10 bg-white/[0.03] text-gray-400")}>
                  {busy === mode.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ModeIcon className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-white">{mode.name}</span>
                    {isActive && <Check className="h-3.5 w-3.5 text-cyan-300" />}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-gray-400">{mode.tagline}</span>
                  <span className="mt-1 block text-[11px] italic leading-snug text-gray-500">“{mode.sample}”</span>
                </span>
              </button>
            );
          })}

          {active?.addresses && (
            <div className="mt-1 border-t border-white/8 px-2.5 pb-1 pt-2.5">
              <label className="sw-label" htmlFor="agent-mode-address">
                How it addresses you
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="agent-mode-address"
                  className="sw-input py-1.5 text-[12px]"
                  value={address}
                  placeholder={active.defaultAddress ?? "sir"}
                  maxLength={24}
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveAddress();
                  }}
                />
                <button type="button" className="sw-btn sw-btn-secondary px-3 py-1.5 text-[12px]" onClick={() => void saveAddress()}>
                  Save
                </button>
              </div>
              <p className="sw-hint mt-1.5">One or two words — “sir”, “boss”, a first name.</p>
            </div>
          )}
          <p className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-2 text-[10px] text-gray-500">
            <BadgeCheck className="h-3 w-3 text-cyan-400/80" />
            Ask in the chat too — “call me sir”, “be more casual” — and it switches.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The modes as a row of chips — for places a dropdown would be clipped (the
 * Make-a-short modal) and where one press should be enough. The title field
 * appears under it only for the mode that uses one.
 */
export function AgentModeChips({ className }: { className?: string }) {
  const { modes, current, setMode } = useAgentModes();
  const [busy, setBusy] = useState<AgentModeId | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const active = modes.find((m) => m.id === current?.persona);

  const pick = async (mode: AgentMode) => {
    if (mode.id === current?.persona) return;
    setBusy(mode.id);
    const state = await setMode(mode.id);
    setBusy(null);
    if (!state) {
      toast.error("Could not change the assistant's mode.");
      return;
    }
    setAddress(mode.addresses ? (state.current.address ?? mode.defaultAddress ?? "") : null);
    toast.success(`Mode: ${state.current.name}`);
  };

  const saveAddress = async () => {
    const wanted = (address ?? "").trim();
    if (!active || wanted === (current?.address ?? "")) {
      setAddress(null);
      return;
    }
    const state = await setMode(active.id, wanted);
    if (!state) {
      toast.error("Could not save that.");
      return;
    }
    toast.success(wanted ? `The assistant will call you ${wanted}.` : "Title cleared.");
    setAddress(null);
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap gap-1.5">
        {modes.map((mode) => {
          const ModeIcon = modeIcon(mode.icon);
          const isActive = mode.id === current?.persona;
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => void pick(mode)}
              aria-pressed={isActive}
              title={mode.tagline}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                isActive
                  ? "border-cyan-400/60 bg-cyan-500/10 text-cyan-100"
                  : "border-white/10 bg-white/[0.02] text-gray-400 hover:border-white/20 hover:text-white",
              )}
            >
              {busy === mode.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ModeIcon className="h-3.5 w-3.5" />}
              {mode.name}
            </button>
          );
        })}
      </div>
      {address !== null && active?.addresses && (
        <div className="flex items-center gap-2">
          <input
            className="sw-input py-1.5 text-[12px]"
            value={address}
            maxLength={24}
            placeholder={active.defaultAddress ?? "sir"}
            aria-label="How the assistant addresses you"
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveAddress();
            }}
          />
          <button type="button" className="sw-btn sw-btn-secondary px-3 py-1.5 text-[12px]" onClick={() => void saveAddress()}>
            Save
          </button>
        </div>
      )}
      {active && <p className="sw-hint">“{active.sample}”</p>}
    </div>
  );
}

/** The mode as one line of text, for cards and modals. */
export function AgentModeNote({ className }: { className?: string }) {
  const { current } = useAgentModes();
  if (!current) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px] text-gray-500", className)}>
      <span className="h-1.5 w-1.5 rounded-full bg-cyan-400/70" />
      {current.name}
      {current.address ? ` · calls you ${current.address}` : ""}
    </span>
  );
}
