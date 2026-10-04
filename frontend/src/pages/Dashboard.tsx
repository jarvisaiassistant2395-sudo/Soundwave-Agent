import { Link } from "react-router-dom";
import { ArrowUpRight, Bot, Clapperboard, Mic, Sparkles, Youtube } from "lucide-react";
import { useAuth } from "../store/auth";
import { SkeletonCard } from "../components/ui/Skeleton";
import { EmptyState } from "../components/ui/EmptyState";
import { ShortCard } from "../components/agent/ShortCard";
import { useAgentShorts, useOrbitalSummary } from "../lib/agentShorts";
import { displayNameFor, loadAgentVoice } from "../lib/voices";

/** Overview — what the agent has been making. It's the only one that makes videos. */
export function Dashboard() {
  const { user } = useAuth();
  const { shorts, loading } = useAgentShorts(60);
  const orbital = useOrbitalSummary();
  const voice = loadAgentVoice();

  const firstName = (user?.name ?? "there").split(" ")[0];
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const onYouTube = shorts.filter((s) => s.settings?.youtubeUrl).length;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Welcome back, {firstName}</h1>
          <p className="mt-1 text-sm text-gray-400">{today}</p>
        </div>
        <Link
          to="/agent"
          className="inline-flex h-11 items-center justify-center gap-2 rounded-btn bg-gradient-to-r from-blue-500 to-violet-500 px-5 font-semibold text-white shadow-glow transition-all duration-200 hover:from-blue-400 hover:to-violet-400"
        >
          <Bot className="h-4 w-4" /> Command Center
        </Link>
      </div>

      {/* Stats */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Shorts made" value={loading ? "…" : String(shorts.length)} icon={<Clapperboard className="h-5 w-5" />} />
        <StatCard title="Posted to YouTube" value={loading ? "…" : String(onYouTube)} icon={<Youtube className="h-5 w-5" />} />
        <StatCard
          title="Backgrounds left"
          value={orbital?.available != null ? String(orbital.available) : "—"}
          icon={<ArrowUpRight className="h-5 w-5" />}
          footer={
            <p className="mt-1 text-xs text-gray-500">
              {orbital ? `${orbital.usedCount} used` : "First check on Generate"}
            </p>
          }
        />
        <StatCard
          title="Agent voice"
          value={displayNameFor(voice)}
          icon={<Mic className="h-5 w-5" />}
          footer={
            <Link to="/voices" className="mt-1 inline-block text-sm text-blue-400 hover:text-blue-300">
              Change →
            </Link>
          }
        />
      </div>

      {/* Quick actions */}
      <h2 className="mt-10 text-lg font-semibold text-white">Quick actions</h2>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <QuickAction
          icon={<Sparkles className="h-6 w-6" />}
          title="Generate a short"
          desc="Written, narrated and rendered by the agent."
          to="/agent?tab=generator"
        />
        <QuickAction
          icon={<Bot className="h-6 w-6" />}
          title="Talk to the agent"
          desc={`Anything you'd type or say — answered as ${displayNameFor(voice)}.`}
          to="/agent"
        />
        <QuickAction
          icon={<Mic className="h-6 w-6" />}
          title="Pick the agent's voice"
          desc="Hear every Soundwave voice and choose one."
          to="/voices"
        />
      </div>

      {/* Recent shorts */}
      <div className="mt-10 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Recent shorts</h2>
        <Link to="/projects" className="text-sm text-blue-400 hover:text-blue-300">
          View all →
        </Link>
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : shorts.length === 0 ? (
          <div className="rounded-card border border-gray-800 bg-panel">
            <EmptyState
              icon={<Clapperboard className="h-8 w-8" />}
              title="No shorts yet"
              description="Ask the agent in the Command Center."
              action={
                <Link
                  to="/agent?tab=generator"
                  className="inline-flex h-11 items-center rounded-btn bg-gradient-to-r from-blue-500 to-violet-500 px-5 font-semibold text-white hover:from-blue-400 hover:to-violet-400"
                >
                  Generate a short
                </Link>
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shorts.slice(0, 8).map((s) => (
              <ShortCard key={s.id} short={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ title, value, icon, footer }: { title: string; value: string; icon: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="rounded-card border border-gray-800 bg-panel p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">{title}</p>
        <span className="text-blue-400">{icon}</span>
      </div>
      <p className="mt-2 truncate text-2xl font-bold text-white">{value}</p>
      {footer}
    </div>
  );
}

function QuickAction({ icon, title, desc, to }: { icon: React.ReactNode; title: string; desc: string; to: string }) {
  return (
    <Link
      to={to}
      className="group flex items-start gap-4 rounded-card border border-gray-800 bg-panel p-5 transition-all duration-200 hover:border-blue-500/50"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500/20 to-violet-500/20 text-blue-300 transition-colors group-hover:text-blue-200">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-semibold text-white">{title}</span>
        <span className="mt-0.5 block text-sm text-gray-400">{desc}</span>
      </span>
    </Link>
  );
}
