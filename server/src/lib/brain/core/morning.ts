// ── Morning Setup: the briefing (shared by the PC and the phone) ────────────
// The PC gathers the facts (weather, what happened with the shorts since the
// last Morning Setup, YouTube numbers, memory) and opens the user's morning
// websites and apps (lib/morning.ts); the phone does the briefing part on its
// own while the PC is off. Either way Gemini words the briefing from facts
// only — and without a key there's a plain template.
// Pure TypeScript (no Node APIs): mobile/ compiles it too.

import { isGemini3, type GenerateRequest } from "./gemini.js";
import type { TopicBrief } from "./research.js";

export type { TopicBrief };

export interface Weather {
  place: string;
  country?: string;
  tempC: number | null;
  highC: number | null;
  lowC: number | null;
  rainChance: number | null;
  description: string;
}

export interface MorningFacts {
  /** "Friday 2 October 2026, 08:14" */
  now: string;
  /** Where it runs: the PC (asked there or from the phone), or the phone alone. */
  where: "pc" | "phone" | "phone-offline";
  weather: Weather | null;
  /** Why there's no weather ("set a city…", "the weather service didn't answer"). */
  weatherNote?: string;
  /** "since your last Morning Setup (yesterday at 08:10)" / "in the last 24 hours". */
  since: string;
  shorts: {
    finished: Array<{ topic: string; youtubeUrl?: string | null }>;
    failed: Array<{ topic: string; error?: string | null }>;
    rendering: { topic: string; percent?: number | null } | null;
    total: number;
    /** The phone's copy can be old: when the PC last told it. */
    asOf?: string;
  } | null;
  backgroundsLeft: number | null;
  youtube: {
    channel: string;
    subscribers?: number | null;
    views?: number | null;
    videos?: number | null;
    latest?: Array<{ title: string; views: number | null; when: string | null }>;
  } | null;
  /** What was opened on the PC. */
  opened: Array<{ label: string; ok: boolean; error?: string }>;
  lowDiskGB?: number | null;
  /** The memory, briefly (summary + a few notes). */
  memory: string;
  /** Topics already made (ideas must be new). */
  madeTopics: string[];
  /** Include three short ideas. */
  ideas: boolean;
  /** The user's own briefing topics, researched with Gemini (./research.ts). */
  topics: TopicBrief[];
}

// ── Weather (Open-Meteo: free, no key, allows browsers) ─────────────────────

const WMO: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "foggy with frost",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "rain showers",
  81: "rain showers",
  82: "heavy rain showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorms",
  96: "thunderstorms with hail",
  99: "thunderstorms with hail",
};

export function weatherWords(code: unknown): string {
  return typeof code === "number" && WMO[code] ? WMO[code]! : "changeable weather";
}

/** "Europe/Belgrade" → "Belgrade" (the default weather city). */
export function cityFromTimeZone(tz: string | undefined | null): string | null {
  if (!tz || !tz.includes("/") || /^(Etc|UTC|GMT)\b/i.test(tz)) return null;
  const segments = tz.split("/");
  const last = (segments[segments.length - 1] ?? "").replace(/_/g, " ").trim();
  return last && !/^GMT|^UTC/i.test(last) ? last : null;
}

export interface WeatherOptions {
  fetch?: typeof fetch;
  geocodingUrl?: string;
  forecastUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const OPEN_METEO_GEOCODING = "https://geocoding-api.open-meteo.com/v1/search";
export const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";

async function getJson(url: string, opts: WeatherOptions): Promise<Record<string, any>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await (opts.fetch ?? fetch)(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`the weather service answered ${res.status}`);
    return (await res.json()) as Record<string, any>;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

const round = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);

/** Today's weather for a city name ("Kruševac" or "Kruševac, Serbia"). */
export async function fetchWeather(city: string, opts: WeatherOptions = {}): Promise<Weather> {
  const [name, countryHint] = city.split(",").map((s) => s.trim());
  if (!name) throw new Error("no city set");
  const geo = await getJson(`${opts.geocodingUrl ?? OPEN_METEO_GEOCODING}?name=${encodeURIComponent(name)}&count=5&language=en&format=json`, opts);
  const results = (Array.isArray(geo.results) ? geo.results : []) as Array<Record<string, any>>;
  const hint = countryHint?.toLowerCase();
  const place = (hint && results.find((r) => String(r.country ?? "").toLowerCase().startsWith(hint) || String(r.country_code ?? "").toLowerCase() === hint)) || results[0];
  if (!place || typeof place.latitude !== "number") throw new Error(`couldn't find a place called “${city}”`);
  const q = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "1",
  });
  const f = await getJson(`${opts.forecastUrl ?? OPEN_METEO_FORECAST}?${q}`, opts);
  return {
    place: String(place.name ?? name),
    ...(place.country ? { country: String(place.country) } : {}),
    tempC: round(f.current?.temperature_2m),
    highC: round(f.daily?.temperature_2m_max?.[0]),
    lowC: round(f.daily?.temperature_2m_min?.[0]),
    rainChance: round(f.daily?.precipitation_probability_max?.[0]),
    description: weatherWords(f.current?.weather_code ?? f.daily?.weather_code?.[0]),
  };
}

export function weatherSentence(w: Weather): string {
  const parts = [`In ${w.place} it's ${w.tempC !== null ? `${w.tempC}°C and ` : ""}${w.description}`];
  if (w.highC !== null && w.lowC !== null) parts.push(`today between ${w.lowC} and ${w.highC}°C`);
  if (w.rainChance !== null) parts.push(`${w.rainChance}% chance of rain`);
  return `${parts.join(", ")}.`;
}

// ── The briefing ────────────────────────────────────────────────────────────

export const MORNING_INSTRUCTION = [
  "You are Soundwave, the AI assistant in the Soundwave AI app (it makes YouTube Shorts for the user). Write the user's Morning Setup briefing from the facts you're given. It is shown in the chat and read aloud.",
  "",
  "- Start with a warm good morning and the day and date.",
  "- The weather in one sentence (now, today's low and high, rain chance), if given.",
  "- What happened with their shorts since last time: finished ones by topic (say \"it's on YouTube\" when it was posted), failures in simple words, what's rendering now. If nothing happened, say so briefly.",
  "- Their YouTube channel's numbers in one or two sentences, if given.",
  "- If memory says what you were working on, connect to it in one sentence.",
  "- Then the user's own briefing topics, each in turn, in the order given: introduce it in a few words (\"On open-source AI tools:\") and give its 2 to 4 most important points from its research — names, numbers, what's new; never read out links. If nothing new was found for a topic, say so in one short sentence. Never invent news.",
  "- If ideas are asked for: three fresh, specific short ideas that fit their channel and differ from the shorts already made — each on its own line as \"Idea 1: …\", \"Idea 2: …\", \"Idea 3: …\" (a topic and its hook, one line each).",
  "- Mention something opened on the PC only if it failed to open. Mention low disk space if given. Mention backgrounds only if few are left (under 10).",
  "- End with one short line offering to start one (\"Say make idea 1\") or to help.",
  "",
  "Plain text only, no Markdown, no emoji. 110 to 190 words, plus about 50 to 90 words for each briefing topic. Use only the facts given — leave out anything missing.",
].join("\n");

export function morningPrompt(f: MorningFacts): string {
  const lines = [`Now: ${f.now}.`];
  if (f.weather) lines.push(`Weather: ${weatherSentence(f.weather)}`);
  else if (f.weatherNote) lines.push(`Weather: not available (${f.weatherNote}).`);
  if (f.shorts) {
    const s = f.shorts;
    lines.push(`Shorts ${f.since}${s.asOf ? ` (as of ${s.asOf})` : ""}:`);
    lines.push(s.finished.length ? `- finished: ${s.finished.map((x) => `“${x.topic}”${x.youtubeUrl ? " (on YouTube)" : ""}`).join(", ")}` : "- finished: none");
    if (s.failed.length) lines.push(`- failed: ${s.failed.map((x) => `“${x.topic}”${x.error ? ` (${x.error.slice(0, 120)})` : ""}`).join(", ")}`);
    if (s.rendering) lines.push(`- rendering now: “${s.rendering.topic}”${typeof s.rendering.percent === "number" ? ` (${s.rendering.percent}%)` : ""}`);
    lines.push(`- shorts made in total: ${s.total}`);
  }
  if (f.backgroundsLeft !== null) lines.push(`Unused Orbital NCG backgrounds left: ${f.backgroundsLeft}.`);
  if (f.youtube) {
    const y = f.youtube;
    const nums = [
      typeof y.subscribers === "number" ? `${y.subscribers} subscribers` : "",
      typeof y.views === "number" ? `${y.views} total views` : "",
      typeof y.videos === "number" ? `${y.videos} videos` : "",
    ].filter(Boolean);
    lines.push(`YouTube channel “${y.channel}”${nums.length ? `: ${nums.join(", ")}` : ""}.`);
    for (const v of y.latest ?? []) lines.push(`- recent upload “${v.title}”: ${typeof v.views === "number" ? `${v.views} views` : "views unknown"}${v.when ? `, posted ${v.when}` : ""}`);
  }
  const failedOpen = f.opened.filter((o) => !o.ok);
  if (f.opened.length) lines.push(`Opened on the PC: ${f.opened.filter((o) => o.ok).map((o) => o.label).join(", ") || "nothing"}${failedOpen.length ? `; couldn't open: ${failedOpen.map((o) => `${o.label} (${o.error ?? "failed"})`).join(", ")}` : ""}.`);
  if (typeof f.lowDiskGB === "number") lines.push(`Low disk space: only ${f.lowDiskGB} GB free.`);
  if (f.memory) lines.push("", "Memory:", f.memory);
  if (f.topics?.length) {
    lines.push("", "Briefing topics (cover each, in this order, using only its research):");
    f.topics.forEach((t, i) => {
      const how = t.via === "search" ? "researched with Google Search" : t.via === "feeds" ? "from GitHub, Hacker News and Google News" : "not researched";
      lines.push(`${i + 1}. “${t.topic}” — ${how}:`);
      lines.push(t.summary ? t.summary : `(nothing new found${t.note ? ` — ${t.note}` : ""})`);
      if (t.sources.length) lines.push(`Sources: ${t.sources.map((src) => src.title).join(", ")}`);
    });
  }
  if (f.ideas) lines.push("", `Ideas: yes — three new ones.${f.madeTopics.length ? ` Already made (don't repeat): ${f.madeTopics.slice(0, 25).map((t) => `“${t}”`).join(", ")}.` : ""}`);
  else lines.push("", "Ideas: no.");
  if (f.where === "phone-offline") lines.push("(The PC is off: this briefing comes from the phone, so nothing was opened on the PC.)");
  return lines.join("\n");
}

export function morningRequest(f: MorningFacts, model: string): GenerateRequest {
  return {
    contents: [{ role: "user", parts: [{ text: morningPrompt(f) }] }],
    systemInstruction: { role: "user", parts: [{ text: MORNING_INSTRUCTION }] },
    generationConfig: { maxOutputTokens: 4096, ...(isGemini3(model) ? { thinkingConfig: { thinkingLevel: "LOW" as const } } : {}) },
  };
}

/** The briefing without Gemini (no key, or Gemini failed). */
export function templateBriefing(f: MorningFacts, opts: { noKey?: boolean } = {}): string {
  const day = f.now.split(",")[0] ?? f.now;
  const out = [`Good morning! It's ${day}.`];
  if (f.weather) out.push(weatherSentence(f.weather));
  if (f.shorts) {
    const s = f.shorts;
    const bits: string[] = [];
    if (s.finished.length) bits.push(`${s.finished.length === 1 ? "your short" : "your shorts"} about ${s.finished.map((x) => `“${x.topic}”`).join(", ")} finished${s.finished.some((x) => x.youtubeUrl) ? " (on YouTube)" : ""}`);
    if (s.failed.length) bits.push(`${s.failed.map((x) => `“${x.topic}”`).join(", ")} didn't finish`);
    if (s.rendering) bits.push(`“${s.rendering.topic}” is rendering${typeof s.rendering.percent === "number" ? ` (${s.rendering.percent}%)` : ""}`);
    out.push(bits.length ? `${capitalize(f.since)}: ${bits.join("; ")}.` : `No new shorts ${f.since}.`);
  }
  if (f.youtube && typeof f.youtube.subscribers === "number") out.push(`Your channel ${f.youtube.channel} has ${f.youtube.subscribers} subscribers.`);
  if (f.backgroundsLeft !== null && f.backgroundsLeft < 10) out.push(`Only ${f.backgroundsLeft} unused backgrounds are left.`);
  const opened = f.opened.filter((o) => o.ok).map((o) => o.label);
  const failed = f.opened.filter((o) => !o.ok).map((o) => o.label);
  if (opened.length) out.push(`I opened ${opened.join(", ")} on your PC.`);
  if (failed.length) out.push(`I couldn't open ${failed.join(", ")}.`);
  if (typeof f.lowDiskGB === "number") out.push(`Heads up: only ${f.lowDiskGB} GB of disk space is free.`);
  for (const t of f.topics ?? []) {
    const first = t.summary.split("\n").filter(Boolean).slice(0, 2).join(" ");
    if (first) out.push(`On ${t.topic}: ${first}`);
  }
  if (opts.noKey) {
    out.push(
      f.topics?.length
        ? `Add a Gemini key in Settings → Brain and I'll research your topics (${f.topics.map((t) => t.topic).join("; ")}) and suggest fresh short ideas every morning.`
        : "Add a Gemini key in Settings → Brain and I'll suggest fresh short ideas every morning.",
    );
  } else out.push("Want me to make a short today?");
  return out.join(" ");
}

/** "2026-10-02" for `now` in the device's (or the given) time zone — which morning a briefing belongs to. */
export function localDay(now: Date, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  }
}

/** Is today's briefing due (local time ≥ the plan's "HH:MM")? */
export function briefingDue(time: string, now: Date): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return false;
  return now.getHours() * 60 + now.getMinutes() >= Number(m[1]) * 60 + Number(m[2]);
}

/** How long after the due time the briefing is still "this morning's" (and is spoken when an app opens). */
export const BRIEFING_WINDOW_MINUTES = 10 * 60;

/** Due today and still within the morning window. */
export function inBriefingWindow(time: string, now: Date): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return false;
  const since = now.getHours() * 60 + now.getMinutes() - (Number(m[1]) * 60 + Number(m[2]));
  return since >= 0 && since < BRIEFING_WINDOW_MINUTES;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "Friday 2 October 2026, 08:14" in the given (or this device's) time zone. */
export function morningNow(now: Date, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { ...opts, ...(timeZone ? { timeZone } : {}) }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", opts).formatToParts(now);
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

/** The memory digest for the briefing: the summary and the latest notes. */
export function memoryDigest(m: { summary?: { text: string } | null; notes?: Array<{ text: string }> } | null | undefined): string {
  if (!m) return "";
  const lines: string[] = [];
  if (m.summary?.text) lines.push(m.summary.text.slice(0, 700));
  for (const n of (m.notes ?? []).slice(-8)) lines.push(`- ${n.text}`);
  return lines.join("\n");
}
