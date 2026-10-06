// ── Profile — the page behind the bottom-left banner ────────────────────────
// The app is linked to a Google account on the first launch, so this page shows
// that account (and its plan) and keeps everything else — display name, one-line
// title, avatar colour — saved on this PC. It also shows what the workspace is doing right now (shorts made,
// trends, ideas to make today) so it is a real page, not a placeholder.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Brain,
  Clapperboard,
  CreditCard,
  HelpCircle,
  Lightbulb,
  Mic,
  RefreshCw,
  Settings as SettingsIcon,
  Shield,
  Sparkles,
  TrendingUp,
  UserRound,
  Youtube,
} from "lucide-react";
import { useAuth } from "../store/auth";
import { http } from "../lib/api";
import type { UserProfile } from "../lib/types";
import { avatarColorClass, AVATAR_COLORS, useLocalProfile } from "../store/profile";
import { useAgentShorts, useOrbitalSummary } from "../lib/agentShorts";
import { useLocalVoices } from "../lib/localVoices";
import { displayNameFor, loadAgentVoice } from "../lib/voices";
import { initials } from "../lib/format";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { TextField } from "../components/ui/TextField";
import { cn } from "../lib/cn";
import { toast } from "../store/toast";

interface TrendIdeaStatus {
  available: boolean;
  ideas: string[];
  googleTrends: string[];
  findings: string[];
  ageDays: number | null;
}

/** The idea line minus its evidence ("…" — trending now: …). */
function ideaHook(idea: string): string {
  const quoted = /^“([^”]+)”/.exec(idea.trim());
  return quoted?.[1]?.trim() ?? idea.split("—")[0]!.trim();
}

function StatTile({ label, value, hint, icon }: { label: string; value: string; hint?: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-card border border-white/[0.08] bg-[#0A0A0C] p-4">
      <div className="flex items-center gap-2 text-gray-400">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 truncate text-xl font-semibold text-white" title={value}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

export function Profile() {
  const auth = useAuth();
  const user = auth.user;
  const setUser = auth.setUser;
  const navigate = useNavigate();
  const local = useLocalProfile();

  const { shorts, loading: shortsLoading } = useAgentShorts(200);
  const orbital = useOrbitalSummary();
  const { status: voices } = useLocalVoices();
  const agentVoice = loadAgentVoice();

  // The name shown everywhere: the account's when signed in, otherwise this PC's.
  const displayName = (user?.name || local.name).trim() || "Creator";
  const title = local.title.trim();
  const colorIndex = local.color;

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(displayName);
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftColor, setDraftColor] = useState(colorIndex);
  const [trends, setTrends] = useState<TrendIdeaStatus | null>(null);
  const [trendsLoading, setTrendsLoading] = useState(false);

  const loadTrends = async () => {
    setTrendsLoading(true);
    try {
      const res = await fetch("/api/v1/agent/trends");
      if (res.ok) {
        const data = (await res.json()) as { trends: TrendIdeaStatus };
        setTrends(data.trends);
      }
    } catch {
      /* the page still works without the trend digest */
    } finally {
      setTrendsLoading(false);
    }
  };

  useEffect(() => {
    void loadTrends();
  }, []);

  const onYouTube = useMemo(() => shorts.filter((s) => Boolean(s.settings?.youtubeUrl)).length, [shorts]);
  const finished = useMemo(() => shorts.filter((s) => s.status === "COMPLETED").length, [shorts]);
  const voiceCount = voices.available ? voices.voices.length : 0;

  const beginEdit = () => {
    setDraftName(displayName);
    setDraftTitle(title);
    setDraftColor(colorIndex);
    setEditing(true);
  };

  const save = async () => {
    const name = draftName.trim() || displayName;
    local.save({ name, title: draftTitle, color: draftColor });
    // When there IS an account, keep it in step — but a failed save must not
    // lose the local edit (the app works offline by design).
    if (user) {
      try {
        // http.put carries the CSRF header the server requires; the account
        // name and the local one are kept in step when a session exists.
        const updated = await http.put<UserProfile>("/user/profile", { name });
        setUser(updated);
      } catch {
        toast.info("Saved on this PC", "Your account name couldn't be updated just now — it will be here next time.");
      }
    }
    setEditing(false);
    toast.success("Profile saved", user ? "Your name is updated in the workspace and on your account." : "Saved on this PC.");
  };

  const startIdea = (idea: string) => {
    const topic = ideaHook(idea);
    void navigate(`/agent?tab=generator&topic=${encodeURIComponent(topic)}`);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* ── The banner itself, full size ─────────────────────────────────── */}
      <section className="overflow-hidden rounded-card border border-white/[0.08] bg-[#0A0A0C]">
        <div className="h-24 bg-gradient-to-r from-blue-600/25 via-violet-600/20 to-transparent" />
        <div className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-end gap-4">
            <span
              className={cn(
                "-mt-10 flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border-4 border-[#0A0A0C] text-2xl font-bold text-white shadow-elevated",
                avatarColorClass(colorIndex),
              )}
              aria-hidden
            >
              {initials(displayName)}
            </span>
            <div className="min-w-0 pb-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-bold text-white">{displayName}</h1>
                <Badge tone={user ? "green" : "gray"}>
                  {user ? (user.plan === "FREE" ? "Free plan" : `${user.plan} plan`) : "This PC"}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-gray-400">{title || (user?.email ?? "Local workspace")}</p>
            </div>
          </div>
          {!editing && (
            <Button variant="outline" size="sm" icon={<UserRound className="h-4 w-4" />} onClick={beginEdit}>
              Edit profile
            </Button>
          )}
        </div>

        {editing && (
          <div className="space-y-4 border-t border-white/[0.06] px-5 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Display name"
                value={draftName}
                maxLength={60}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Your name"
              />
              <TextField
                label="One-line title"
                value={draftTitle}
                maxLength={60}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Creator, editor, channel name…"
                hint="Shown under your name on this page."
              />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-gray-300">Avatar colour</p>
              <div className="flex flex-wrap gap-2">
                {AVATAR_COLORS.map((_, index) => (
                  <button
                    key={index}
                    type="button"
                    aria-label={`Avatar colour ${index + 1}`}
                    aria-pressed={draftColor === index}
                    onClick={() => setDraftColor(index)}
                    className={cn(
                      "h-8 w-8 rounded-lg transition-transform",
                      avatarColorClass(index),
                      draftColor === index ? "ring-2 ring-white ring-offset-2 ring-offset-[#0A0A0C]" : "hover:scale-105",
                    )}
                  />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void save()}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              {local.saved && (
                <button
                  type="button"
                  className="ml-auto text-xs text-gray-500 hover:text-gray-300"
                  onClick={() => {
                    local.reset();
                    setDraftName("Creator Workspace");
                    setDraftTitle("");
                  }}
                >
                  Reset to defaults
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── What the workspace has been doing ─────────────────────────────── */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Shorts made"
          value={shortsLoading ? "…" : String(finished)}
          hint={shortsLoading ? undefined : `${shorts.length} in the library`}
          icon={<Clapperboard className="h-4 w-4" />}
        />
        <StatTile
          label="Posted to YouTube"
          value={shortsLoading ? "…" : String(onYouTube)}
          hint={onYouTube ? "Live on your channel" : "Nothing published yet"}
          icon={<Youtube className="h-4 w-4" />}
        />
        <StatTile
          label="Backgrounds left"
          value={orbital?.available != null ? String(orbital.available) : "—"}
          hint={orbital ? `${orbital.usedCount} used so far` : "Checked on first generate"}
          icon={<Sparkles className="h-4 w-4" />}
        />
        <StatTile
          label="Voices ready"
          value={voiceCount ? String(voiceCount) : displayNameFor(agentVoice)}
          hint={voices.available ? "On-device narration" : "Microsoft neural voice"}
          icon={<Mic className="h-4 w-4" />}
        />
      </section>

      {/* ── Today's ideas, read free from YouTube + Google Trends ─────────── */}
      <section className="rounded-card border border-white/[0.08] bg-[#0A0A0C] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Lightbulb className="h-4 w-4 text-amber-400" /> Ideas for today
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              Built from this week's popular Shorts and today's searches — no AI credits used.
              {trends?.ageDays != null ? ` Checked ${trends.ageDays < 1 ? "today" : `${Math.round(trends.ageDays)}d ago`}.` : ""}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className={cn("h-4 w-4", trendsLoading && "animate-spin")} />}
            onClick={() => void loadTrends()}
            disabled={trendsLoading}
          >
            Refresh
          </Button>
        </div>

        {trends?.ideas?.length ? (
          <ul className="mt-4 space-y-2">
            {trends.ideas.slice(0, 4).map((idea) => (
              <li
                key={idea}
                className="flex items-start justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
              >
                <p className="min-w-0 flex-1 text-sm text-gray-200">{idea}</p>
                <Button size="sm" variant="subtle" className="shrink-0" onClick={() => startIdea(idea)}>
                  Make this
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-gray-500">
            {trendsLoading
              ? "Reading YouTube and Google Trends…"
              : trends?.available
                ? "No ideas from the last check yet — press Refresh."
                : "Nothing checked yet. The agent scans YouTube twice a day by itself, free of charge."}
          </p>
        )}

        {Boolean(trends?.googleTrends?.length) && (
          <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
            <TrendingUp className="h-3.5 w-3.5 text-cyan-400" />
            Trending searches:
            {trends!.googleTrends.slice(0, 6).map((topic) => (
              <button
                key={topic}
                type="button"
                className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-gray-300 transition-colors hover:border-cyan-500/50 hover:text-white"
                onClick={() => startIdea(`“About ${topic}: the part nobody explains”`)}
              >
                {topic}
              </button>
            ))}
          </p>
        )}
      </section>

      {/* ── Account and workspace shortcuts ──────────────────────────────── */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-card border border-white/[0.08] bg-[#0A0A0C] p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Shield className="h-4 w-4 text-blue-400" /> Account
          </h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Name</dt>
              <dd className="truncate text-gray-200">{displayName}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Google account</dt>
              <dd className="truncate text-gray-200">{user?.email ?? "Not linked yet"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Plan</dt>
              <dd className="text-gray-200">{user ? (user.plan === "FREE" ? "Free" : user.plan) : "Local — unlimited, your machine"}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              to="/settings/billing"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-xs font-medium text-gray-300 transition-colors hover:border-white/20 hover:text-white"
            >
              <CreditCard className="h-3.5 w-3.5" /> Plan & billing
            </Link>
            <Link
              to="/settings"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-xs font-medium text-gray-300 transition-colors hover:border-white/20 hover:text-white"
            >
              <SettingsIcon className="h-3.5 w-3.5" /> Settings
            </Link>
            <Link
              to="/help"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-xs font-medium text-gray-300 transition-colors hover:border-white/20 hover:text-white"
            >
              <HelpCircle className="h-3.5 w-3.5" /> Help & docs
            </Link>
            {user && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await auth.signOut();
                  toast.info("Signed out", "You have been signed out of Soundwave AI.");
                  void navigate("/agent");
                }}
              >
                Sign out
              </Button>
            )}
          </div>
        </div>

        <div className="rounded-card border border-white/[0.08] bg-[#0A0A0C] p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Brain className="h-4 w-4 text-violet-400" /> What the agent works with
          </h2>
          <ul className="mt-3 space-y-2 text-sm text-gray-400">
            <li className="flex items-center justify-between gap-3">
              <span>Agent voice</span>
              <Link to="/voices" className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300">
                {displayNameFor(agentVoice)} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>Cloned voices</span>
              <Link to="/voices" className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300">
                {voices.available ? `${voiceCount} on this PC` : "Set up in Voice Library"} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>Trend digest</span>
              <span className="text-gray-300">
                {trends?.available
                  ? `${trends.findings.length} findings${trends.ideas.length ? `, ${trends.ideas.length} ideas` : ""}`
                  : "Waiting for the first scan"}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>Shorts library</span>
              <Link to="/dashboard" className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300">
                Open overview <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
