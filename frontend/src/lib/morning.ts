// ── Morning Setup (the chip in the Command Center, Settings → Morning Setup) ─
// Server: server/src/routes/morning.ts and lib/morning.ts.

import type { ChatMessage, ChatReply } from "./agentChat";

/** The daily briefing (kept in the agent's memory; the phone gets it too). */
export interface BriefingPlan {
  topics: string[];
  time: string;
  auto: boolean;
  updatedAt: number;
}

export interface BriefingStatus {
  day: string;
  plan: BriefingPlan;
  due: boolean;
  inWindow: boolean;
  preparing: boolean;
  message: ChatMessage | null;
  heard: { at: number; on: "pc" | "phone" | null } | null;
}

export interface MorningItem {
  kind: "website" | "app";
  value: string;
  label?: string;
}

export interface MorningSettings {
  city: string | null;
  items: MorningItem[];
  openFromPhone: boolean;
  ideas: boolean;
  /** The city the weather is for (the saved one, or the time zone's). */
  weatherCity: string | null;
  weatherCityAuto: boolean;
  canOpen: boolean;
  canOpenApps: boolean;
  maxItems: number;
  briefing: BriefingPlan;
  maxTopics: number;
  maxTopicChars: number;
}

export interface Weather {
  place: string;
  country?: string;
  tempC: number | null;
  highC: number | null;
  lowC: number | null;
  rainChance: number | null;
  description: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1/morning${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!res.ok) throw new Error(body.error?.message || `Morning Setup didn't answer (HTTP ${res.status}).`);
  return body;
}

export const morningApi = {
  get: () => call<MorningSettings>(""),
  save: (patch: Partial<Pick<MorningSettings, "city" | "items" | "openFromPhone" | "ideas">> & { briefing?: Partial<Omit<BriefingPlan, "updatedAt">> }) =>
    call<MorningSettings>("", { method: "PUT", body: JSON.stringify(patch) }),
  briefing: () => call<BriefingStatus>("/briefing"),
  prepareBriefing: () => call<BriefingStatus>("/briefing/prepare", { method: "POST" }),
  briefingHeard: (day: string) => call<BriefingStatus>("/briefing/heard", { method: "POST", body: JSON.stringify({ day }) }),
  weather: (city?: string) => call<{ ok: boolean; city: string | null; weather: Weather | null; error?: string }>("/weather", { method: "POST", body: JSON.stringify(city ? { city } : {}) }),
  run: () => call<ChatReply>("/run", { method: "POST" }),
};

export function weatherLine(w: Weather): string {
  return `${w.place}${w.country ? `, ${w.country}` : ""}: ${w.tempC ?? "?"}°C, ${w.description}${w.highC !== null && w.lowC !== null ? ` (${w.lowC}–${w.highC}°C today)` : ""}`;
}
