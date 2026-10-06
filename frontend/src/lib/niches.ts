// ── The Generate tab's topics — client for /api/v1/agent/niches ─────────────
// Two kinds of niche come back in one answer, and the difference is the whole
// feature: the nine researched ones the script engine is built on, and the ones
// the agent found going viral and proposed. A proposal is not a niche yet — it
// sits in its own list until the person accepts it, and only then can a script
// be written for it.
//
// The list used to be hardcoded in the Command Center (and pinned to the server's
// by a test, because the two could drift). It comes from the server now, so what
// the agent found and what the picker offers are the same thing by construction.

import { useCallback, useEffect, useState } from "react";

/** One of the Shorts the scan saw climbing on this topic — the evidence. */
export interface NicheLeadExample {
  title: string;
  url: string;
  views: number;
  channel?: string;
}

export interface NicheLead {
  topic: string;
  /** "youtube": this week's popular Shorts. "google-trends": today's searches. */
  from: "youtube" | "google-trends";
  channels: number;
  views: number;
  velocity?: number;
  examples: NicheLeadExample[];
}

/** A niche that can be generated from: researched, or found and accepted. */
export interface NicheView {
  id: string;
  name: string;
  description: string;
  audience: string;
  angles: string[];
  never: string;
  hooks: string[];
  sampleScripts: string[];
  /** True for one the agent found; false for the researched nine. */
  discovered: boolean;
  addedAt: number | null;
}

/** Something the agent found that is waiting on a decision. */
export interface NicheProposal {
  id: string;
  name: string;
  description: string;
  audience: string;
  angles: string[];
  hooks: string[];
  never: string;
  /** What the agent says it saw — shown to the person, so it has to be readable. */
  evidence: string;
  sources: string[];
  leads: NicheLead[];
  status: "pending" | "accepted" | "dismissed";
  proposedAt: number;
  decidedAt: number | null;
}

export interface NichesResponse {
  niches: NicheView[];
  proposals: NicheProposal[];
  counts: { pending: number; accepted: number };
  leads: NicheLead[];
}

async function call<T>(method: "GET" | "POST" | "DELETE", path = ""): Promise<T> {
  const res = await fetch(`/api/v1/agent/niches${path}`, { method });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string | { message?: string } };
  if (!res.ok) {
    const message = typeof data.error === "string" ? data.error : data.error?.message;
    throw new Error(message || `HTTP ${res.status}`);
  }
  return data;
}

const enc = encodeURIComponent;

export const nichesApi = {
  list: () => call<NichesResponse>("GET"),
  accept: (id: string) => call<NichesResponse & { proposal: NicheProposal }>("POST", `/proposals/${enc(id)}/accept`),
  dismiss: (id: string) => call<NichesResponse & { proposal: NicheProposal }>("POST", `/proposals/${enc(id)}/dismiss`),
  remove: (id: string) => call<{ ok: boolean; niches: NicheView[] }>("DELETE", `/${enc(id)}`),
};

/** "1.2M" / "48K" — a view count that fits in a small badge. */
export function compactViews(views: number): string {
  if (!Number.isFinite(views) || views <= 0) return "—";
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(views >= 10_000_000 ? 0 : 1)}M`;
  if (views >= 1_000) return `${Math.round(views / 1_000)}K`;
  return String(Math.round(views));
}

/** "3 days ago" for a proposal, so the person knows how fresh the find is. */
export function proposalAge(at: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface UseNiches {
  niches: NicheView[];
  proposals: NicheProposal[];
  leads: NicheLead[];
  counts: { pending: number; accepted: number };
  loading: boolean;
  error: string | null;
  /** Which proposal is being accepted or dismissed right now. */
  deciding: string | null;
  accept: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useNiches(): UseNiches {
  const [data, setData] = useState<NichesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setData(await nichesApi.list());
    } catch (err) {
      // The picker still has to work when the server hasn't answered: the
      // component falls back to the researched nine rather than showing nothing.
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const decide = useCallback(
    async (id: string, kind: "accept" | "dismiss") => {
      setDeciding(id);
      try {
        setError(null);
        const res = kind === "accept" ? await nichesApi.accept(id) : await nichesApi.dismiss(id);
        setData((prev) => (prev ? { ...prev, niches: res.niches ?? prev.niches, proposals: res.proposals ?? [], counts: res.counts ?? prev.counts } : prev));
      } catch (err) {
        setError((err as Error).message);
        await refresh();
      } finally {
        setDeciding(null);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      setDeciding(id);
      try {
        setError(null);
        const res = await nichesApi.remove(id);
        setData((prev) => (prev ? { ...prev, niches: res.niches, counts: { ...prev.counts, accepted: Math.max(0, prev.counts.accepted - 1) } } : prev));
      } catch (err) {
        setError((err as Error).message);
        await refresh();
      } finally {
        setDeciding(null);
      }
    },
    [refresh],
  );

  return {
    niches: data?.niches ?? [],
    proposals: data?.proposals ?? [],
    leads: data?.leads ?? [],
    counts: data?.counts ?? { pending: 0, accepted: 0 },
    loading,
    error,
    deciding,
    accept: useCallback((id: string) => decide(id, "accept"), [decide]),
    dismiss: useCallback((id: string) => decide(id, "dismiss"), [decide]),
    remove,
    refresh,
  };
}
