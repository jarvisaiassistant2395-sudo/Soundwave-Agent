// ── How the agent talks — client for /api/v1/brain/mode ─────────────────────
// The Command Center's header pill and Settings → Personality both read and
// write this one setting. The agent can change it too (its set_agent_mode tool),
// so the pill keeps itself fresh the way the brain pill does: a person who says
// "be more formal" should see the pill move without reloading the page.
//
// The modes themselves are defined server-side in brain/core/persona.ts, which
// the phone app shares; this file only carries the shape of the answer.

import { useCallback, useEffect, useState } from "react";

export type AgentMode = "professional" | "friendly" | "concise" | "coach" | "witty" | "narrator";

export interface ModeOption {
  id: AgentMode;
  name: string;
  /** What it feels like to talk to — one line under the name. */
  tagline: string;
  /** How it addresses you, so the difference is obvious before you pick it. */
  addresses: string;
}

export interface AgentModeStatus {
  mode: AgentMode;
  name: string;
  tagline: string;
  addresses: string;
  /** "environment" and "default" mean nobody has chosen one on this PC yet. */
  source: "saved" | "environment" | "default";
  /** False on a hosted server, where the mode isn't this window's to change. */
  editable: boolean;
  modes: ModeOption[];
}

async function call<T>(method: "GET" | "PUT", body?: unknown): Promise<T> {
  const res = await fetch("/api/v1/brain/mode", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; details?: Array<{ message?: string }> } };
  if (!res.ok) {
    const e = data.error;
    const err = new Error(e?.details?.[0]?.message || e?.message || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

export const agentModeApi = {
  status: () => call<AgentModeStatus>("GET"),
  /** Pick by id (the pill and Settings), or by the words used (`asked`). */
  choose: (mode: AgentMode) => call<AgentModeStatus>("PUT", { mode }),
  describe: (asked: string) => call<AgentModeStatus>("PUT", { asked }),
};

export interface UseAgentMode {
  status: AgentModeStatus | null;
  /** Which mode is in force, or null until the server has answered. */
  mode: AgentMode | null;
  /** The modes to offer; empty until the server answers, so nothing is invented here. */
  modes: ModeOption[];
  setMode: (mode: AgentMode) => Promise<void>;
  refresh: () => Promise<void>;
  busy: boolean;
  error: string | null;
}

/**
 * The current mode, kept fresh while the page is visible. Polling matters here
 * rather than being wasteful: the agent can change the mode mid-conversation,
 * and a pill that still said "Friendly" after "be more formal" would look like
 * the switch hadn't worked.
 */
export function useAgentMode(pollMs = 20_000): UseAgentMode {
  const [status, setStatus] = useState<AgentModeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await agentModeApi.status());
    } catch {
      /* server not ready yet — the pill simply stays hidden until it answers */
    }
  }, []);

  const setMode = useCallback(async (mode: AgentMode) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await agentModeApi.choose(mode));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, pollMs);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, pollMs]);

  return { status, mode: status?.mode ?? null, modes: status?.modes ?? [], setMode, refresh, busy, error };
}
