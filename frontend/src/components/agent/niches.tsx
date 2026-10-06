import { Clock, Compass, Cpu, Eye, Flame, HeartPulse, Info, Search, Sparkles, TrendingUp } from "lucide-react";

export interface NicheInfo {
  id: string;
  name: string;
  desc: string;
  iconName: "sparkles" | "compass" | "clock" | "trending" | "cpu" | "flame" | "eye" | "search" | "heart";
  /** True for one the agent found going viral and the person accepted. */
  discovered?: boolean;
}

/**
 * The researched nine: the ones that hold a scrolling audience, and the floor
 * the script engine is built on (server/src/lib/brain/core/viral.ts is the same
 * list for the script writer and the API).
 *
 * The Generate tab renders what GET /api/v1/agent/niches returns — these, plus
 * any niche the agent found going viral and the person accepted. This copy is
 * what shows while that loads and if the server can't be reached at all, and
 * server/tests/viral.test.ts pins it to the engine's own list so it cannot
 * quietly drift out of date.
 */
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
        selected ? "border-cyan-400 bg-cyan-500/10" : "border-surface-border bg-surface-subtle"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex w-full cursor-pointer items-center gap-2 px-2 py-2 pr-7 text-left"
      >
        {getNicheIcon(niche.discovered ? "trending" : niche.iconName)}
        <span className="min-w-0 flex-1 truncate text-2xs font-bold text-white">{niche.name}</span>
        {niche.discovered && (
          <span
            className="shrink-0 rounded bg-fuchsia-500/15 px-1 py-px text-3xs font-bold text-fuchsia-300"
            title="The agent found this one going viral and you accepted it — it isn't part of the researched nine."
            data-testid={`niche-discovered-${niche.id}`}
          >
            NEW
          </span>
        )}
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
        <p className="px-2 pb-2 text-3xs leading-snug text-gray-400">{niche.desc}</p>
      )}
    </div>
  );
}

/**
 * What the server's catalog entry looks like as a picker button. The server owns
 * the niche (its audience, angles and the trap that kills it all go to the script
 * writer); the picker only needs a name, a line and a glyph.
 */
export function nicheInfoFrom(view: { id: string; name: string; description: string; discovered?: boolean }): NicheInfo {
  return {
    id: view.id,
    name: view.name,
    desc: view.description,
    // The researched nine keep the glyph they were given; anything the agent
    // found is a rising topic, so it gets the trending one.
    iconName: view.discovered ? "trending" : (BUILTIN_ICONS[view.id] ?? "sparkles"),
    ...(view.discovered ? { discovered: true } : {}),
  };
}

const BUILTIN_ICONS: Record<string, NicheInfo["iconName"]> = Object.fromEntries(NICHES.map((n) => [n.id, n.iconName]));
