import { Clock, Compass, Cpu, Eye, Flame, HeartPulse, Info, Search, Sparkles, TrendingUp } from "lucide-react";

export interface NicheInfo {
  id: string;
  name: string;
  desc: string;
  iconName: "sparkles" | "compass" | "clock" | "trending" | "cpu" | "flame" | "eye" | "search" | "heart";
}

// Researched niches (server/src/lib/brain/core/viral.ts is the same list for
// the script writer and the API): the ones that hold a scrolling audience.
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

function getNicheIcon(iconName: string) {
  switch (iconName) {
    case "sparkles": return <Sparkles className="h-4 w-4 text-cyan-400" />;
    case "compass": return <Compass className="h-4 w-4 text-emerald-400" />;
    case "clock": return <Clock className="h-4 w-4 text-amber-400" />;
    case "trending": return <TrendingUp className="h-4 w-4 text-purple-400" />;
    case "cpu": return <Cpu className="h-4 w-4 text-cyan-300" />;
    case "flame": return <Flame className="h-4 w-4 text-rose-400" />;
    case "search": return <Search className="h-4 w-4 text-orange-400" />;
    case "eye": return <Eye className="h-4 w-4 text-indigo-400" />;
    case "heart": return <HeartPulse className="h-4 w-4 text-emerald-400" />;
    default: return <Sparkles className="h-4 w-4 text-cyan-400" />;
  }
}

/**
 * One niche, one button: the title and an “i” at the right end. Pressing the
 * “i” grows the button and shows the description under the title; pressing the
 * button itself picks the niche. Nothing else is written on the grid.
 */

export function NicheButton({
  niche,
  selected,
  expanded,
  onSelect,
  onToggleInfo,
}: {
  niche: NicheInfo;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggleInfo: () => void;
}) {
  return (
    <div
      className={`relative flex flex-col rounded-lg border transition-all ${
        selected ? "border-cyan-400 bg-cyan-500/10" : "border-[#24252D] bg-[#050506]"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex w-full items-center gap-2 px-2 py-2 pr-7 text-left cursor-pointer"
      >
        {getNicheIcon(niche.iconName)}
        <span className="truncate text-[11px] font-bold text-white">{niche.name}</span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleInfo();
        }}
        aria-label={`What “${niche.name}” is about`}
        aria-expanded={expanded}
        title={expanded ? "Hide the description" : "What this niche is about"}
        className={`absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border transition-colors cursor-pointer ${
          expanded
            ? "border-cyan-400/70 text-cyan-300"
            : "border-white/10 text-gray-500 hover:border-cyan-400/60 hover:text-cyan-300"
        }`}
      >
        <Info className="h-3 w-3" />
      </button>
      {expanded && (
        <p className="px-2 pb-2 text-[10px] leading-snug text-gray-400">{niche.desc}</p>
      )}
    </div>
  );
}
