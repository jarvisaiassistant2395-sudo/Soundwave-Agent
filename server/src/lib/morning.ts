// ── Morning Setup on the PC ─────────────────────────────────────────────────
// The "🌅 Morning Setup" chip (Command Center and phone), the agent's
// run_morning_setup tool and Settings → Morning Setup. It really does things:
//   1. opens the user's morning websites and apps on this PC
//   2. gathers facts — weather (Open-Meteo), shorts since the last Morning
//      Setup, YouTube channel numbers, backgrounds left, disk space, memory
//   3. Gemini words a short spoken briefing with three new short ideas
//      (a plain template without a key).
// Settings live in DATA_DIR/morning.json. The briefing itself is shared with
// the phone app (./brain/core/morning.ts), which does it alone when the PC is off.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ChatReply } from "./chatMessages.js";
import { findJob } from "./conversation.js";
import { listShorts } from "./shortsLibrary.js";
import { getOrbitalStatus } from "./orbitalBackground.js";
import { youtubeService } from "./youtube.js";
import { channelInsights } from "./channelInsights.js";
import { defaultChannelId, listChannels } from "./youtubeChannels.js";
import { briefingPlan, lastMorningAt, memoryState, noteMorningRun } from "./memory.js";
import { getActiveShortJobs } from "../routes/agentShort.js";
import { generateContent, GeminiError, visibleText } from "./brain/gemini.js";
import { activeBrain, FALLBACK_MODEL, noteBrainError } from "./brain/settings.js";
import { normalizeUrl, openApp, openWebsite, pcStatus } from "./brain/pc.js";
import { plainReply } from "./brain/prompt.js";
import { relativeTime } from "./brain/core/memory.js";
import {
  cityFromTimeZone,
  fetchWeather,
  localDay,
  memoryDigest,
  morningNow,
  morningRequest,
  templateBriefing,
  type MorningFacts,
  type Weather,
} from "./brain/core/morning.js";
import { researchTopics, type FetchText, type TopicBrief } from "./brain/core/research.js";

export interface MorningItem {
  kind: "website" | "app";
  value: string;
}

export interface MorningSettings {
  /** Weather city; null = the city of this PC's time zone. */
  city: string | null;
  items: MorningItem[];
  /** Open the items when Morning Setup is started from the phone. */
  openFromPhone: boolean;
  /** Three short ideas in the briefing (needs a Gemini key). */
  ideas: boolean;
  updatedAt?: string;
}

export const DEFAULT_MORNING: MorningSettings = {
  city: null,
  items: [{ kind: "website", value: "https://studio.youtube.com" }],
  openFromPhone: true,
  ideas: true,
};

export const MAX_MORNING_ITEMS = 12;

function fileFor(): string {
  return path.join(config.dataDir, "morning.json");
}

export function loadMorningSettings(): MorningSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as Partial<MorningSettings>;
    return {
      city: typeof raw.city === "string" && raw.city.trim() ? raw.city.trim().slice(0, 80) : null,
      items: Array.isArray(raw.items)
        ? raw.items
            .filter((i): i is MorningItem => Boolean(i) && (i.kind === "website" || i.kind === "app") && typeof i.value === "string" && Boolean(i.value.trim()))
            .slice(0, MAX_MORNING_ITEMS)
        : DEFAULT_MORNING.items,
      openFromPhone: raw.openFromPhone !== false,
      ideas: raw.ideas !== false,
      ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    };
  } catch {
    return { ...DEFAULT_MORNING, items: [...DEFAULT_MORNING.items] };
  }
}

export function saveMorningSettings(patch: Partial<Omit<MorningSettings, "updatedAt">>): MorningSettings {
  const next: MorningSettings = { ...loadMorningSettings(), ...patch, updatedAt: new Date().toISOString() };
  if (patch.city !== undefined) next.city = patch.city?.trim() ? patch.city.trim().slice(0, 80) : null;
  if (patch.items) next.items = patch.items.slice(0, MAX_MORNING_ITEMS);
  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return next;
}

/** The weather city: the saved one, else the city of this PC's time zone. */
export function morningCity(settings = loadMorningSettings()): { city: string | null; auto: boolean } {
  if (settings.city) return { city: settings.city, auto: false };
  let tz: string | undefined;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    tz = undefined;
  }
  return { city: cityFromTimeZone(tz), auto: true };
}

export async function morningWeather(city: string | null, signal?: AbortSignal): Promise<{ weather: Weather | null; note?: string }> {
  if (!city) return { weather: null, note: "no city set — add one in Settings → Morning Setup" };
  try {
    return { weather: await fetchWeather(city, { geocodingUrl: config.openMeteoGeocodingUrl, forecastUrl: config.openMeteoForecastUrl, signal }) };
  } catch (err) {
    return { weather: null, note: `the weather for “${city}” isn't available: ${(err as Error).message}` };
  }
}

/** A morning item as people see it: "YouTube Studio (studio.youtube.com)", "Spotify". */
export function itemLabel(item: MorningItem): string {
  if (item.kind === "app") return item.value;
  try {
    const u = new URL(normalizeUrl(item.value) ?? item.value);
    return u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname : "");
  } catch {
    return item.value;
  }
}

/** Opens the morning websites and apps on this PC (desktop app only). */
export async function openMorningItems(items: MorningItem[]): Promise<MorningFacts["opened"]> {
  const out: MorningFacts["opened"] = [];
  if (!config.desktopApp) return items.length ? [{ label: "your morning items", ok: false, error: "only the desktop app can open things on the PC" }] : [];
  for (const item of items) {
    const label = itemLabel(item);
    try {
      const r = item.kind === "website" ? await openWebsite(item.value) : process.platform === "win32" ? await openApp(item.value) : { ok: false as const, error: "apps can only be opened on Windows" };
      out.push(r.ok ? { label, ok: true } : { label, ok: false, error: String((r as { error?: unknown }).error ?? "it didn't open") });
    } catch (err) {
      out.push({ label, ok: false, error: (err as Error).message });
    }
  }
  return out;
}

async function youtubeFacts(): Promise<MorningFacts["youtube"]> {
  // Channels connected through Settings → YouTube & Shorts (any number of them):
  // report the default one — the channel this PC publishes to — with its real
  // numbers the same way the agent's youtube_views tool does.
  const channels = listChannels();
  if (channels.length) {
    try {
      const result = await channelInsights({ recent: 3 });
      const preferred = result.channels.find((c) => c.id === defaultChannelId()) ?? result.channels[0];
      if (preferred) {
        return {
          channel: preferred.channelTitle || preferred.name,
          subscribers: preferred.subscribers,
          views: preferred.views,
          videos: preferred.videos,
          latest: preferred.recent.map((v) => ({
            title: v.title,
            views: v.views,
            when: v.publishedAt ? relativeTime(Date.parse(v.publishedAt)) : null,
          })),
        };
      }
      console.warn(`[morning] channel numbers unavailable: ${result.errors.join("; ")}`);
    } catch (err) {
      console.warn(`[morning] channel numbers unavailable: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  // The legacy single "Connect YouTube account" (a machine that connected
  // before channels existed).
  const cfg = youtubeService.getConfig();
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) return null;
  try {
    const stats = await youtubeService.channelStats();
    if (!stats) return null;
    return {
      channel: stats.channelTitle || cfg.channelTitle || "your channel",
      subscribers: stats.subscribers,
      views: stats.views,
      videos: stats.videos,
      latest: stats.latest.map((v) => ({ title: v.title, views: v.views, when: v.publishedAt ? relativeTime(Date.parse(v.publishedAt)) : null })),
    };
  } catch (err) {
    console.warn(`[morning] YouTube numbers unavailable: ${(err as Error).message.split("\n")[0]}`);
    return cfg.channelTitle ? { channel: cfg.channelTitle } : null;
  }
}

/** The PC fetches the public feeds itself (GitHub's API wants a User-Agent). */
export const pcFetchText: FetchText = async (url, opts = {}) => {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "SoundwaveAI-Desktop (+https://github.com/Str4hinj47/Soundwave-AI)", Accept: "application/json, application/rss+xml, text/xml;q=0.9, */*;q=0.5" },
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
};

/** The user's briefing topics, researched with Gemini (Google Search, else the public feeds). */
export async function researchBriefingTopics(topics: string[], opts: { now?: Date; signal?: AbortSignal } = {}): Promise<TopicBrief[]> {
  if (!topics.length) return [];
  const brain = activeBrain();
  if (!brain) return topics.map((topic) => ({ topic, summary: "", sources: [], via: "none" as const, note: "needs a Gemini key" }));
  return researchTopics(topics, {
    apiKey: brain.apiKey,
    model: brain.model,
    generate: generateContent,
    now: opts.now,
    fetchText: pcFetchText,
    signal: opts.signal,
    log: (m) => console.warn(`[morning] ${m}`),
  });
}

/** Everything the briefing is written from. */
export async function gatherMorningFacts(opts: { via: "pc" | "phone"; opened: MorningFacts["opened"]; now?: Date; signal?: AbortSignal }): Promise<MorningFacts> {
  const settings = loadMorningSettings();
  const now = opts.now ?? new Date();
  const last = lastMorningAt();
  const sinceMs = last && now.getTime() - last < 7 * 86_400_000 ? last : now.getTime() - 86_400_000;
  const since = last && sinceMs === last ? `since your last Morning Setup (${relativeTime(last, now.getTime())})` : "in the last 24 hours";

  const { city } = morningCity(settings);
  const plan = briefingPlan();
  const [weather, shorts, youtube, pc, topics] = await Promise.all([
    morningWeather(city, opts.signal),
    listShorts("local-user").catch(() => []),
    youtubeFacts(),
    pcStatus(100).catch(() => null),
    researchBriefingTopics(plan.topics, { now, signal: opts.signal }),
  ]);

  const newer = shorts.filter((s) => Date.parse(s.completedAt ?? s.createdAt) >= sinceMs);
  const active = getActiveShortJobs()[0];
  let rendering: NonNullable<MorningFacts["shorts"]>["rendering"] = null;
  if (active) {
    const snap = await findJob(active.jobId).catch(() => null);
    rendering = { topic: active.topic, percent: snap?.progress ?? null };
  }
  const orbital = getOrbitalStatus();
  const mem = memoryState();
  const freeGB = pc?.disk?.freeGB;

  return {
    now: morningNow(now),
    where: opts.via === "phone" ? "phone" : "pc",
    weather: weather.weather,
    ...(weather.note ? { weatherNote: weather.note } : {}),
    since,
    shorts: {
      finished: newer.filter((s) => s.status === "COMPLETED").map((s) => ({ topic: s.topic, youtubeUrl: s.youtubeUrl })),
      failed: newer.filter((s) => s.status === "FAILED").map((s) => ({ topic: s.topic, error: s.error })),
      rendering,
      total: shorts.length,
    },
    backgroundsLeft: orbital.catalogSize ? orbital.available : null,
    youtube,
    opened: opts.opened,
    lowDiskGB: typeof freeGB === "number" && freeGB < 10 ? Math.round(freeGB * 10) / 10 : null,
    memory: memoryDigest(mem),
    madeTopics: shorts.map((s) => s.topic),
    ideas: settings.ideas && Boolean(activeBrain()),
    topics,
  };
}

/** Opens the items (if allowed from here) and gathers the facts — shared by the chip and the agent's tool. */
export async function prepareMorning(opts: { via: "pc" | "phone"; signal?: AbortSignal; open?: boolean }): Promise<MorningFacts> {
  const settings = loadMorningSettings();
  // The automatic briefing never opens things; the chip and the agent do (from the phone only if allowed).
  const open = opts.open ?? (opts.via === "pc" || settings.openFromPhone);
  const opened = open ? await openMorningItems(settings.items) : [];
  const facts = await gatherMorningFacts({ via: opts.via, opened, signal: opts.signal });
  noteMorningRun();
  return facts;
}

/** Gemini words the briefing; the template without a key or when Gemini fails. */
export async function writeBriefing(facts: MorningFacts, signal?: AbortSignal): Promise<{ text: string; model: string | null }> {
  const brain = activeBrain();
  if (!brain) return { text: templateBriefing(facts, { noKey: true }), model: null };
  for (const model of [...new Set([brain.model, FALLBACK_MODEL])]) {
    try {
      const resp = await generateContent({ apiKey: brain.apiKey, model, purpose: "morning", request: morningRequest(facts, model), signal, timeoutMs: 25_000 });
      const text = plainReply(visibleText(resp.candidates?.[0]?.content?.parts));
      if (text) return { text, model };
      break;
    } catch (err) {
      const retry = err instanceof GeminiError && ["quota", "overloaded", "timeout"].includes(err.kind);
      if (retry && model !== FALLBACK_MODEL) continue;
      noteBrainError(err, model);
      break;
    }
  }
  return { text: templateBriefing(facts), model: null };
}

/** What the briefing was built from, for the line under it. */
export function briefingOutput(facts: MorningFacts): string {
  const output: string[] = [];
  for (const o of facts.opened) output.push(o.ok ? `Opened ${o.label}` : `Couldn't open ${o.label}: ${o.error ?? "failed"}`);
  if (facts.weather) output.push(`Weather: ${facts.weather.place}${facts.weather.country ? `, ${facts.weather.country}` : ""} (Open-Meteo)`);
  else if (facts.weatherNote) output.push(`Weather: ${facts.weatherNote}`);
  for (const t of facts.topics) {
    const how = t.via === "search" ? "Google Search" : t.via === "feeds" ? "GitHub, Hacker News, Google News" : `not researched${t.note ? ` (${t.note})` : ""}`;
    output.push(`${t.topic}: ${how}${t.sources.length ? ` — ${t.sources.map((src) => src.title).slice(0, 3).join(", ")}` : ""}`);
  }
  return output.join("\n");
}

/** The "🌅 Morning Setup" chip, on the PC or from the phone — and the automatic morning briefing (open: false). */
export async function runMorningSetup(opts: { via: "pc" | "phone"; signal?: AbortSignal; open?: boolean }): Promise<ChatReply> {
  const facts = await prepareMorning(opts);
  const { text, model } = await writeBriefing(facts, opts.signal);
  const output = briefingOutput(facts);
  return {
    success: true,
    reply: text,
    tag: "SYS",
    action: "morning_setup",
    // Today's briefing: the apps speak it when they're opened, once.
    briefingDate: localDay(new Date()),
    ...(output ? { actionOutput: output } : {}),
    ...(model ? { brain: { provider: "gemini", model } } : {}),
  };
}
