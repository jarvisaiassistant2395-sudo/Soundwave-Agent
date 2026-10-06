import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Clapperboard, Search, Sparkles } from "lucide-react";
import { EmptyState } from "../components/ui/EmptyState";
import { SkeletonCard } from "../components/ui/Skeleton";
import { ShortCard } from "../components/agent/ShortCard";
import { shortTitle, useAgentShorts } from "../lib/agentShorts";

/** Projects — every short the agent has made (it's the only one that makes videos). */
export function Projects() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const { shorts, loading, error } = useAgentShorts(200);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return shorts;
    return shorts.filter((s) =>
      [shortTitle(s), s.settings?.topic ?? "", s.settings?.background?.title ?? ""].some((t) => t.toLowerCase().includes(q)),
    );
  }, [shorts, query]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-white">Projects</h1>
        </div>
        <Link
          to="/agent?tab=generator"
          className="inline-flex h-11 items-center gap-2 rounded-btn bg-gradient-to-r from-blue-500 to-violet-500 px-5 font-semibold text-white hover:from-blue-400 hover:to-violet-400"
        >
          <Sparkles className="h-4 w-4" /> Generate a short
        </Link>
      </div>

      {/* Toolbar */}
      <div className="mt-5 flex flex-wrap items-center gap-3 rounded-card border border-gray-800 bg-panel p-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setParams(e.target.value ? { q: e.target.value } : {}, { replace: true });
            }}
            placeholder="Search"
            className="w-full rounded-input border border-gray-700 bg-gray-900 py-2 pl-9 pr-3 text-sm text-white placeholder-gray-500"
            aria-label="Search shorts"
          />
        </div>
        <span className="ml-auto text-xs text-gray-500">
          {loading ? "Loading…" : `${filtered.length} of ${shorts.length} short${shorts.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* Content */}
      <div className="mt-5">
        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-card border border-gray-800 bg-panel">
            <EmptyState
              icon={<Clapperboard className="h-8 w-8" />}
              title={error ? "Couldn't load the shorts" : query ? "No matching shorts" : "No shorts yet"}
              description={
                error
                  ? `The app's server didn't answer (${error}).`
                  : query
                    ? "Try a different search."
                    : "Ask the agent in the Command Center."
              }
              action={
                !error && !query ? (
                  <Link
                    to="/agent?tab=generator"
                    className="inline-flex h-11 items-center rounded-btn bg-gradient-to-r from-blue-500 to-violet-500 px-5 font-semibold text-white hover:from-blue-400 hover:to-violet-400"
                  >
                    Generate a short
                  </Link>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((s) => (
              <ShortCard key={s.id} short={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
