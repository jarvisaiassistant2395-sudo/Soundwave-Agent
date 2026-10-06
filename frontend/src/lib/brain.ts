// ── The agent's brain (Google Gemini) — client for /api/v1/brain ────────────
// Settings → Brain saves the person's own Gemini API key on this PC; the
// Command Center shows which model the agent thinks with. The key itself
// never comes back from the server — only a hint like "AIza…9xQk".

import { useCallback, useEffect, useState } from "react";

export type ThinkingLevel = "low" | "medium" | "high";

export interface BrainStatus {
  provider: "gemini";
  configured: boolean;
  source: "settings" | "env" | null;
  keyHint: string | null;
  envKey: boolean;
  model: string;
  modelLabel: string;
  thinking: ThinkingLevel;
  webSearch: boolean;
  searchUnavailable: boolean;
  fallbackModel: string;
  fallbackModelLabel: string;
  models: Array<{ id: string; label: string; note: string }>;
  settingsAvailable: boolean;
  desktopActions: boolean;
  lastOkAt: string | null;
  lastModel: string | null;
  lastModelLabel: string | null;
  lastLatencyMs: number | null;
  lastError: { kind: string; message: string; detail: string; at: string } | null;
  updatedAt: string | null;
  /** How much Gemini was used today, and how much the free paths avoided. */
  usage?: {
    day: string;
    calls: number;
    cached: number;
    blocked: number;
    byPurpose: Record<string, number>;
    limits: { total: number; purposes: Record<string, number> };
    remaining: { total: number | null; purposes: Record<string, number | null> };
    /** Answers kept on disk that can be reused (cache.ts). */
    cachedAnswers: number;
  };
}

export interface BrainTestResult {
  ok: boolean;
  model: string;
  modelLabel: string;
  latencyMs?: number;
  reply?: string;
  kind?: string;
  message?: string;
  detail?: string;
  search?: "off" | "ok" | "unavailable" | "unknown";
  searchDetail?: string | null;
}

export interface BrainModels {
  recommended: Array<{ id: string; label: string; note: string; available: boolean | null }>;
  more: Array<{ id: string; label: string }>;
  listed: boolean;
  error?: string;
}

export interface BrainAbilities {
  desktop: boolean;
  platform: string;
  shorts: boolean;
  openWebsites: boolean;
  pcStatus: boolean;
  openApps: { available: boolean; count: number; source: string; query?: string; match?: string | null; alternatives?: string[] };
}

export const GET_KEY_URL = "https://aistudio.google.com/apikey";

/** 840 → "840 ms", 1530 → "1.5 s". */
export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

async function call<T>(method: "GET" | "PUT" | "POST" | "DELETE", path = "", body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/brain${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; details?: Array<{ message?: string }> } };
  if (!res.ok) {
    const e = (data as { error?: { message?: string; details?: Array<{ message?: string }> } }).error;
    const err = new Error(e?.details?.[0]?.message || e?.message || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

export const brainApi = {
  status: () => call<BrainStatus>("GET"),
  save: (patch: { apiKey?: string; model?: string; thinking?: ThinkingLevel; webSearch?: boolean }) => call<BrainStatus>("PUT", "", patch),
  removeKey: () => call<BrainStatus>("DELETE", "/key"),
  clearCache: () => call<{ ok: boolean; cleared: number }>("DELETE", "/cache"),
  test: (body: { apiKey?: string; model?: string } = {}) => call<BrainTestResult>("POST", "/test", body),
  models: () => call<BrainModels>("GET", "/models"),
  abilities: () => call<BrainAbilities>("GET", "/abilities"),
};

/** The brain's status, kept fresh while the page is visible. */
export function useBrainStatus(pollMs = 30_000): { status: BrainStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await brainApi.status());
    } catch {
      /* server not ready yet — try again on the next tick */
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
  return { status, refresh };
}
