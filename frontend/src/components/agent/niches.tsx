import { useState } from "react";
import { Clock, Compass, Cpu, Eye, Flame, HeartPulse, Info, Plus, Search, Sparkles, TrendingUp, Trash2, X } from "lucide-react";
import { cn } from "../../lib/cn";
import type { NicheSuggestion } from "../../lib/agentNiches";

export interface NicheInfo {
  id: string;
  name: string;
  desc: string;
  iconName: string;
  /** Added by the assistant (a subject it found climbing) rather than researched. */
  added?: boolean;
  /** Still new enough to badge. */
  fresh?: boolean;
  /** Who added it. */
  source?: "agent" | "user";
  /** The evidence, shown under the tile. */
  why?: string;
}

// The researched niches — the same list as the script engine
// (server/src/lib/brain/core/viral.ts), which is what actually writes the
// scripts. It is kept here as the grid's fallback so the picker is complete
// before the server answers; the live list (including whatever Soundwave has
// added since) arrives from GET /api/v1/agent/niches.
export const NICHES: NicheInfo[] = [
  { id: "psychology", name: "Psychology & Mind", desc: "Why people act the way they do", iconName: "sparkles" },
  { id: "facts", name: "Mind-Bending Facts", desc: "Science and scale that sounds fake", iconName: "compass" },
  { id: "history", name: "Untold History", desc: "Forgotten events, impossible timelines", iconName: "clock" },
  { id: "finance", name: "Money & Wealth", desc: "Rules of money, traps, quiet math", iconName: "trending" },
  { id: "ai", name: "AI & Future Tech", desc: "What the tools actually change", iconName: "cpu" },
  { id: "motivation", name: "Discipline & Mindset", desc: "Habits that survive a bad day", iconName: "flame" },
  { id: "horror", name: "Unexplained Horror", desc: "True eerie events told straight", iconName: "eye" },
  { id: "crime", name: "True Crime & Cold Cases", desc: "Cases solved by one detail", iconName: "search" },
  { id: "health", name: "Body & Mind Hacks", desc: "Evidence-based fixes for energy", iconName: "heart" },
];

const ICONS: Record<string, { Icon: typeof Sparkles; tone: string }> = {
  sparkles: { Icon: Sparkles, tone: "text-violet-300 border-violet-400/25 bg-violet-500/10" },
  compass: { Icon: Compass, tone: "text-emerald-300 border-emerald-400/25 bg-emerald-500/10" },
  clock: { Icon: Clock, tone: "text-amber-300 border-amber-400/25 bg-amber-500/10" },
  trending: { Icon: TrendingUp, tone: "text-sky-300 border-sky-400/25 bg-sky-500/10" },
  cpu: { Icon: Cpu, tone: "text-cyan-300 border-cyan-400/25 bg-cyan-500/10" },
  flame: { Icon: Flame, tone: "text-rose-300 border-rose-400/25 bg-rose-500/10" },
  eye: { Icon: Eye, tone: "text-indigo-300 border-indigo-400/25 bg-indigo-500/10" },
  search: { Icon: Search, tone: "text-orange-300 border-orange-400/25 bg-orange-500/10" },
  heart: { Icon: HeartPulse, tone: "text-teal-300 border-teal-400/25 bg-teal-500/10" },
  radar: { Icon: TrendingUp, tone: "text-cyan-300 border-cyan-400/30 bg-cyan-500/10" },
};

function nicheIcon(iconName: string) {
  return ICONS[iconName] ?? ICONS.sparkles!;
}

/**
 * One niche in the grid: an icon in its own tinted square, the name, and an “i”
 * that opens what the niche is about. The whole tile picks it; pressed state is
 * a cyan ring, so the chosen one is obvious at a glance.
 */
export function NicheButton({
  niche,
  selected,
  expanded,
  onSelect,
  onToggleInfo,
  onRemove,
}: {
  niche: NicheInfo;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggleInfo: () => void;
  /** Added niches can be taken back out of the picker. */
  onRemove?: () => void;
}) {
  const { Icon, tone } = nicheIcon(niche.iconName);
  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-xl border transition-all",
        selected
          ? "border-cyan-400/70 bg-cyan-500/[0.09] shadow-[0_0_0_1px_rgba(34,211,238,0.25)]"
          : "border-white/8 bg-[#0b0c0f] hover:border-white/16 hover:bg-white/[0.02]",
      )}
    >
      <button type="button" onClick={onSelect} aria-pressed={selected} className="flex w-full items-center gap-2.5 px-2.5 py-2.5 pr-7 text-left">
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border", tone)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-semibold text-white">{niche.name}</span>
            {niche.added && (
              <span className={cn("sw-badge shrink-0", niche.fresh ? "sw-badge-new" : "")} title={niche.why ?? "Added by the assistant"}>
                {niche.fresh ? "New" : "Added"}
              </span>
            )}
          </span>
          {!expanded && <span className="mt-0.5 block truncate text-[11px] text-gray-500">{niche.desc}</span>}
        </span>
      </button>

      <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            aria-label={`Remove “${niche.name}”`}
            title="Remove from the picker"
            className="flex h-5 w-5 items-center justify-center rounded-md border border-transparent text-gray-600 opacity-0 transition-all hover:border-rose-400/40 hover:text-rose-300 focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleInfo();
          }}
          aria-label={`What “${niche.name}” is about`}
          aria-expanded={expanded}
          title={expanded ? "Hide the description" : "What this niche is about"}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-md border transition-colors",
            expanded ? "border-cyan-400/50 text-cyan-300" : "border-transparent text-gray-600 group-hover:border-white/12 group-hover:text-gray-300",
          )}
        >
          {expanded ? <X className="h-3 w-3" /> : <Info className="h-3 w-3" />}
        </button>
      </div>

      {expanded && (
        <div className="space-y-1 px-2.5 pb-2.5">
          <p className="text-[11px] leading-snug text-gray-400">{niche.desc}</p>
          {niche.added && niche.why && (
            <p className="border-t border-white/6 pt-1.5 text-[10px] leading-snug text-cyan-200/70">
              <span className="font-semibold text-cyan-300/90">{niche.source === "user" ? "You added this: " : "Soundwave found this: "}</span>
              {niche.why}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Something climbing on Shorts that no niche covers yet. The scan (free, no AI)
 * found it; adding it puts it in the grid, where the script engine can write
 * for it like any other niche.
 */
export function NicheSuggestionCard({
  suggestion,
  onAdd,
  busy,
  disabled,
}: {
  suggestion: NicheSuggestion;
  onAdd: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-2.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-500/10 text-cyan-300">
          <TrendingUp className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-semibold text-white">{suggestion.name}</span>
            <span className="sw-badge sw-badge-new shrink-0">Trending</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-gray-400">{suggestion.why}</p>
          {open && suggestion.evidence.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 border-t border-white/6 pt-1.5">
              {suggestion.evidence.map((line, i) => (
                <li key={i} className="truncate text-[10px] text-gray-500" title={line}>
                  • {line}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {suggestion.evidence.length > 0 && (
            <button type="button" onClick={() => setOpen((was) => !was)} className="sw-chip px-1.5 py-1 text-[10px]" title="The Shorts this came from" aria-expanded={open}>
              <Info className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={onAdd}
            disabled={busy || disabled}
            className="sw-btn sw-btn-secondary gap-1 px-2.5 py-1 text-[11px]"
            title={disabled ? "Remove an added niche first" : "Add it to the picker"}
          >
            {busy ? <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" /> : <Plus className="h-3 w-3" />}
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
