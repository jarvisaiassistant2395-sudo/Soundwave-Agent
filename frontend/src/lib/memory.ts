// ── The agent's memory (Command Center → gear → Memory) ─────────────────────
// Server: server/src/routes/memory.ts. Notes the agent saved (or you added),
// the summary of earlier conversations, and when Morning Setup last ran.

export interface MemoryNote {
  id: string;
  text: string;
  at: number;
  from?: "pc" | "phone" | "app";
}

export interface MemoryState {
  notes: MemoryNote[];
  summary: { text: string; updatedAt: number } | null;
  lastMorningAt: number | null;
  /** The morning briefing (Settings → Morning Setup). */
  briefing?: { topics: string[]; time: string; auto: boolean; updatedAt: number };
  maxNotes: number;
  maxNoteChars: number;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1/memory${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!res.ok) throw new Error(body.error?.message || `The memory didn't answer (HTTP ${res.status}).`);
  return body;
}

export const memoryApi = {
  get: () => call<MemoryState>(""),
  add: (text: string) => call<MemoryState & { note: MemoryNote }>("/notes", { method: "POST", body: JSON.stringify({ text }) }),
  edit: (id: string, text: string) => call<MemoryState & { note: MemoryNote }>(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ text }) }),
  remove: (id: string) => call<MemoryState>(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  forgetSummary: () => call<MemoryState>("/summary", { method: "DELETE" }),
  clear: () => call<MemoryState>("", { method: "DELETE" }),
};

export function noteAge(at: number, now = Date.now()): string {
  const m = Math.round((now - at) / 60_000);
  if (m < 2) return "just now";
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
