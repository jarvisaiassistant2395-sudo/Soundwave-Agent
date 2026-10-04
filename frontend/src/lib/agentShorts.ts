import { useEffect, useState } from "react";

// ── The shorts the agent has made ───────────────────────────────────────────
// The agent is the only thing in the app that makes videos; Overview and
// Projects list what it rendered (GET /api/v1/agent/jobs?kind=short).

export interface ShortBackgroundInfo {
  source: "orbital_ncg";
  channelName: string;
  channelUrl: string;
  videoId: string;
  url: string;
  title: string;
  section: { start: number; end: number } | null;
}

export interface AgentShort {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  outputUrl: string | null;
  createdAt: string;
  completedAt: string | null;
  settings: {
    topic?: string;
    voice?: string;
    duration?: number;
    youtubeUrl?: string | null;
    background?: ShortBackgroundInfo;
  } | null;
}

const NICHE_TITLES: Record<string, string> = {
  psychology: "Psychology",
  facts: "Mind-Bending Facts",
  history: "Untold History",
  finance: "Money & Wealth",
  ai: "AI & Future Tech",
  motivation: "Deep Mindset",
  horror: "Unexplained Horror",
};

/** "psychology" → "Psychology"; custom topics are shown as typed. */
export function shortTitle(short: AgentShort): string {
  const topic = short.settings?.topic?.trim() ?? "";
  if (!topic) return "Untitled short";
  return NICHE_TITLES[topic.toLowerCase()] ?? topic.charAt(0).toUpperCase() + topic.slice(1);
}

export function shortVideoUrl(short: AgentShort): string {
  return short.outputUrl || `/api/v1/export/jobs/${short.id}/download`;
}

export function shortDownloadUrl(short: AgentShort): string {
  const url = shortVideoUrl(short);
  return url.includes("?") ? `${url}&download=1` : `${url}?download=1`;
}

/** Completed shorts, newest first. */
export function useAgentShorts(limit = 60): { shorts: AgentShort[]; loading: boolean; error: string | null } {
  const [shorts, setShorts] = useState<AgentShort[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/agent/jobs?status=COMPLETED&kind=short&limit=${limit}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { jobs?: AgentShort[] };
        if (alive) setShorts(data.jobs ?? []);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [limit]);

  return { shorts, loading, error };
}

export interface OrbitalSummary {
  catalogSize: number | null;
  available: number | null;
  usedCount: number;
}

export function useOrbitalSummary(): OrbitalSummary | null {
  const [summary, setSummary] = useState<OrbitalSummary | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/v1/agent/orbital")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setSummary({ catalogSize: d.catalogSize ?? null, available: d.available ?? null, usedCount: d.usedCount ?? 0 }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return summary;
}
