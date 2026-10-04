// ── The shorts the agent made (the local library) ───────────────────────────
// Used by the agent's tools (list/show videos), its memory ("what we made")
// and Morning Setup ("what happened since yesterday").

import { getStore } from "./store.js";

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

export interface ShortJob {
  id: string;
  topic: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  outputUrl: string | null;
  youtubeUrl: string | null;
  error: string | null;
}

/** Shorts the agent made (they carry a topic), newest first, whoever "owns" them locally. */
export async function listShorts(userId: string): Promise<ShortJob[]> {
  const store = await getStore();
  const byId = new Map<string, ShortJob>();
  for (const owner of new Set([userId, "agent-local", "local-user"])) {
    const jobs = await store.listJobs(owner).catch(() => []);
    for (const j of jobs) {
      const settings = (j.settings ?? {}) as { topic?: unknown; youtubeUrl?: unknown };
      if (typeof settings.topic !== "string" || byId.has(j.id)) continue;
      byId.set(j.id, {
        id: j.id,
        topic: settings.topic,
        status: j.status,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
        outputUrl: j.outputUrl,
        youtubeUrl: typeof settings.youtubeUrl === "string" ? settings.youtubeUrl : null,
        error: j.errorMessage,
      });
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

