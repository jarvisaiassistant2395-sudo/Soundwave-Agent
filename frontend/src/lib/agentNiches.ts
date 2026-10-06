import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

// ── The Generate tab's niches (GET/POST/DELETE /api/v1/agent/niches) ────────
// The nine researched niches come with the app (components/agent/niches.tsx
// keeps the same list as a fallback, so the grid renders before the server
// answers). Everything else here is what Soundwave found climbing this week —
// the agent's tool writes the same store, so the picker and the tool agree.

export interface ApiNiche {
  id: string;
  name: string;
  description: string;
  hooks: string[];
  sampleScripts: string[];
  audience: string;
  /** Added on top of the researched nine. */
  added?: boolean;
  source?: "agent" | "user";
  why?: string;
  addedAt?: number;
}

export interface AddedNicheView {
  id: string;
  name: string;
  description: string;
  source: "agent" | "user";
  why?: string;
  addedAt: string | null;
  /** Still new enough to badge in the picker. */
  fresh: boolean;
}

export interface NicheSuggestion {
  id: string;
  name: string;
  short: string;
  why: string;
  evidence: string[];
  views: number;
  shorts: number;
  channels: number;
}

export interface NichesState {
  niches: ApiNiche[];
  added: AddedNicheView[];
  suggestions: NicheSuggestion[];
  maxAdded: number;
}

/** The agent added a niche while chatting — the picker should say so. */
export const NICHES_CHANGED_EVENT = "soundwave:niches";

export function announceNichesChanged(detail: { name?: string; removed?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent(NICHES_CHANGED_EVENT, { detail }));
}

export async function fetchNiches(): Promise<NichesState> {
  return api<NichesState>("/agent/niches");
}

export async function addNicheFromSuggestion(suggestion: NicheSuggestion): Promise<NichesState> {
  const state = await api<{ niches: ApiNiche[]; added: AddedNicheView[]; suggestions: NicheSuggestion[]; maxAdded: number }>("/agent/niches", {
    method: "POST",
    body: { suggestion: suggestion.name },
  });
  announceNichesChanged({ name: suggestion.name });
  return state;
}

export async function removeAddedNiche(id: string): Promise<void> {
  await api(`/agent/niches/${encodeURIComponent(id)}`, { method: "DELETE" });
  announceNichesChanged({ removed: true });
}

/**
 * The picker's data. Loaded when the Generate tab opens and refreshed when the
 * agent adds something (or another window changes it).
 */
export function useNiches(opts: { enabled?: boolean } = {}): {
  state: NichesState | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addSuggestion: (suggestion: NicheSuggestion) => Promise<NicheSuggestion | null>;
  remove: (id: string) => Promise<boolean>;
} {
  const [state, setState] = useState<NichesState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await fetchNiches());
      setError(null);
    } catch (err) {
      setError((err as Error).message || "Could not read the niche list.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (opts.enabled === false) return;
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(NICHES_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(NICHES_CHANGED_EVENT, onChange);
  }, [opts.enabled, refresh]);

  const addSuggestion = useCallback(async (suggestion: NicheSuggestion) => {
    try {
      const next = await addNicheFromSuggestion(suggestion);
      setState((was) => ({ ...(was ?? { niches: next.niches, added: [], suggestions: [], maxAdded: 12 }), ...next }));
      setError(null);
      return suggestion;
    } catch (err) {
      setError((err as Error).message || "Could not add that niche.");
      return null;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await removeAddedNiche(id);
      await refresh();
      return true;
    } catch (err) {
      setError((err as Error).message || "Could not remove that niche.");
      return false;
    }
  }, [refresh]);

  return { state, loading, error, refresh, addSuggestion, remove };
}

/** Niches the agent added, as the picker's tiles (badged while fresh). */
export function addedTiles(state: NichesState | null): Array<{ id: string; name: string; description: string; why?: string; fresh: boolean; source: "agent" | "user" }> {
  if (!state) return [];
  return state.added.map((n) => ({ id: n.id, name: n.name, description: n.description, ...(n.why ? { why: n.why } : {}), fresh: n.fresh, source: n.source }));
}
