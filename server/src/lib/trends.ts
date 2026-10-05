// ── The trend scout: what is actually going viral on Shorts right now ───────
// Virality moves. The script engine (brain/core/viral.ts) is the floor — the
// shapes and rules that keep working — and this is the ceiling: twice a day,
// while Soundwave AI runs, the scout reads this week's most popular Shorts
// straight from YouTube's search (./shortsTrends.ts — free, no key, no Gemini)
// and writes a short digest into the data folder. Every script is then written
// with that digest in hand, and the agent can answer "what's trending?" from it.
//
// Two free readers feed the digest: the Shorts scan above, and Google Trends'
// daily RSS for the day's actual searches (./googleTrends.ts) — the second
// answers what the scans cannot see (a topic about to break, before it has
// Shorts). From both, the digest also carries concrete short ideas
// (shortsTrends.buildShortIdeas) so "what should I make today?" has an answer
// with zero AI calls.
//
// Gemini + Google Search is only a fallback, and only when someone presses
// "search again" and the free readers came back with nothing: background
// refreshes never spend AI quota.
//
// Honest failure: when nothing usable comes back, nothing is invented and
// nothing is wiped — the previous digest stays, with its age on it, and the
// scripts fall back to the standing research.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { GeminiError, generateContent, visibleText } from "./brain/gemini.js";
import { RESEARCH_MODELS } from "./brain/core/research.js";
import { activeBrain } from "./brain/settings.js";
import { scanTrendingShorts, type TrendingShort } from "./shortsTrends.js";
import { DEFAULT_TRENDS_GEO, fetchGoogleTrends } from "./googleTrends.js";

/** A digest is good for this many days before the scout looks again (12 hours: the YouTube scan is free). */
export const TREND_REFRESH_DAYS = 0.5;
const DAY_MS = 86_400_000;
const MAX_FINDINGS = 8;
const MIN_FINDINGS = 3;
/** How often the running app checks whether the digest has gone stale. */
const CHECK_INTERVAL_MS = 30 * 60_000;

export interface TrendDigest {
  /** When it was researched (ms epoch). */
  researchedAt: number;
  /** What is working right now — one specific, current observation per line. */
  findings: string[];
  /** Where it was seen (page titles from the search, or "YouTube search"). */
  sources: string[];
  /** "youtube": read from YouTube's own Shorts search (free). "search": Gemini + Google Search. */
  via: "youtube" | "search";
  /** The most-viewed Shorts of the week (YouTube scans only). */
  top?: TopShort[];
  /** Concrete "make this" ideas built from the findings, without an AI call. */
  ideas?: string[];
  /** The day's Google trending searches (free RSS), when they were read. */
  googleTrends?: string[];
  /** The country the Shorts scan read (YouTube scans only). */
  region?: string;
}

/** What the app shows and the agent can cite for one popular Short. */
export type TopShort = Pick<TrendingShort, "id" | "title" | "url" | "views" | "channel" | "ageHours" | "seconds" | "query">;

export type TrendRefresh =
  | { ok: true; digest: TrendDigest }
  | { ok: false; reason: "no-key" | "no-findings" | "failed"; detail?: string };

export interface TrendStatus {
  /** True when there is a digest to write scripts from. */
  available: boolean;
  researchedAt: string | null;
  ageDays: number | null;
  /** True when it is old enough (or missing) that the scout should look again. */
  due: boolean;
  /** True while a refresh is running right now. */
  refreshing: boolean;
  /** Always false now: the YouTube scan needs no key. Kept for older app pages. */
  needsKey: boolean;
  findings: string[];
  sources: string[];
  via: TrendDigest["via"] | null;
  top: TopShort[];
  /** Concrete short ideas from the last free scan (empty for search digests). */
  ideas: string[];
  /** The day's Google trending searches, when the last scan read them. */
  googleTrends: string[];
}

function fileFor(): string {
  return path.join(config.dataDir, "trends.json");
}

const clean = (v: unknown, max = 240): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

export function loadTrendDigest(): TrendDigest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as Partial<TrendDigest>;
    if (typeof raw.researchedAt !== "number" || !Number.isFinite(raw.researchedAt)) return null;
    const findings = (Array.isArray(raw.findings) ? raw.findings : []).map((f) => clean(f)).filter((f) => f.length >= 12).slice(0, MAX_FINDINGS);
    if (findings.length < MIN_FINDINGS) return null;
    const sources = (Array.isArray(raw.sources) ? raw.sources : []).map((s) => clean(s, 120)).filter(Boolean).slice(0, 6);
    const via = raw.via === "youtube" ? "youtube" : "search";
    const top = (Array.isArray(raw.top) ? raw.top : [])
      .filter((t): t is TopShort => Boolean(t) && typeof t.id === "string" && typeof t.title === "string" && typeof t.views === "number")
      .slice(0, 20)
      .map((t) => ({
        id: t.id,
        title: clean(t.title, 140),
        url: typeof t.url === "string" && t.url.startsWith("https://www.youtube.com/") ? t.url : `https://www.youtube.com/shorts/${t.id}`,
        views: t.views,
        query: clean(t.query, 60),
        ...(typeof t.channel === "string" ? { channel: clean(t.channel, 80) } : {}),
        ...(typeof t.ageHours === "number" ? { ageHours: t.ageHours } : {}),
        ...(typeof t.seconds === "number" ? { seconds: t.seconds } : {}),
      }));
    const ideas = (Array.isArray(raw.ideas) ? raw.ideas : []).map((i) => clean(i, 200)).filter((i) => i.length >= 12).slice(0, MAX_FINDINGS);
    const googleTrends = (Array.isArray(raw.googleTrends) ? raw.googleTrends : []).map((t) => clean(t, 80)).filter(Boolean).slice(0, 10);
    const region = typeof raw.region === "string" && /^[A-Z]{2}$/.test(raw.region) ? raw.region : undefined;
    return {
      researchedAt: raw.researchedAt,
      findings,
      sources,
      via,
      ...(top.length ? { top } : {}),
      ...(ideas.length ? { ideas } : {}),
      ...(googleTrends.length ? { googleTrends } : {}),
      ...(region ? { region } : {}),
    };
  } catch {
    return null;
  }
}

function saveTrendDigest(digest: TrendDigest): void {
  const file = fileFor();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(digest, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[trends] could not save the digest: ${(err as Error).message}`);
  }
}

export function trendAgeDays(digest: TrendDigest, now = new Date()): number {
  return Math.max(0, (now.getTime() - digest.researchedAt) / DAY_MS);
}

/** Old enough to look again (or nothing saved yet). */
export function trendsDue(now = new Date(), digest = loadTrendDigest()): boolean {
  return !digest || trendAgeDays(digest, now) >= TREND_REFRESH_DAYS;
}

export function trendsStatus(now = new Date()): TrendStatus {
  const digest = loadTrendDigest();
  return {
    available: Boolean(digest),
    researchedAt: digest ? new Date(digest.researchedAt).toISOString() : null,
    ageDays: digest ? +trendAgeDays(digest, now).toFixed(1) : null,
    due: trendsDue(now, digest),
    refreshing: refreshing !== null,
    needsKey: false,
    findings: digest?.findings ?? [],
    sources: digest?.sources ?? [],
    via: digest?.via ?? null,
    top: digest?.top ?? [],
    ideas: digest?.ideas ?? [],
    googleTrends: digest?.googleTrends ?? [],
  };
}

/** The question the scout asks. It must come back with current, specific trends. */
export function trendPrompt(now = new Date()): string {
  const day = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return [
    `Today is ${day}. Search the web for what is actually working on YouTube Shorts right now — the last two weeks.`,
    "Report the specific current things: formats and edits that are landing, hook styles that are being copied, topic areas that are spiking, and any recent platform changes (length, features, tests, monetization rules).",
    'Answer as JSON and nothing else: {"findings": ["…"], "sources": ["…"]}.',
    `Every finding: one line, under 22 words, naming the specific thing and what changed — observed from real Shorts, not advice. No generic tips that were true a year ago, no predictions. ${MIN_FINDINGS} to ${MAX_FINDINGS} findings, most important first.`,
  ].join("\n");
}

/** The model's answer → findings (JSON first, plain lines as a fallback). */
export function parseTrendAnswer(text: string): string[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as { findings?: unknown };
      const list = Array.isArray(parsed.findings) ? parsed.findings : [];
      const out = list.map((f) => clean(f)).filter((f) => f.length >= 12);
      if (out.length) return out.slice(0, MAX_FINDINGS);
    } catch {
      /* not JSON after all — read the lines below */
    }
  }
  return raw
    .split(/\n+/)
    .map((l) => clean(l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")))
    .filter((l) => l.length >= 12 && !/^(?:nothing new found|no findings)/i.test(l))
    .slice(0, MAX_FINDINGS);
}

function groundingSources(resp: { candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ web?: { title?: string; uri?: string } }> } }> }): string[] {
  const out: string[] = [];
  for (const chunk of resp.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
    const title = chunk.web?.title?.trim();
    if (title && !out.includes(title)) out.push(title.slice(0, 120));
    if (out.length >= 6) break;
  }
  return out;
}

let refreshing: Promise<TrendRefresh> | null = null;

/**
 * Looks for what is going viral right now and saves it. Runs once at a time.
 * `now` is only for tests (the digest records the real wall clock).
 */
export function refreshTrends(opts: { reason?: "schedule" | "manual" | "startup"; signal?: AbortSignal; now?: Date } = {}): Promise<TrendRefresh> {
  if (refreshing) return refreshing;
  refreshing = (async (): Promise<TrendRefresh> => {
    // 1. Free: the day's searches (Google Trends RSS) then this week's popular
    //    Shorts (YouTube search). The Google read happens first so the Shorts
    //    scan can turn its topics into concrete ideas, and either one alone is
    //    still a usable digest.
    const google = await fetchGoogleTrends({ signal: opts.signal });
    let youtubeDetail = "";
    try {
      const scan = await scanTrendingShorts({
        signal: opts.signal,
        extraTopics: google.trends.map((t) => t.title),
      });
      const googleLine = google.trends.length
        ? `Trending searches today (Google, ${google.geo}): ${google.trends.slice(0, 6).map((t) => t.title).join(", ")}.`
        : "";
      // The day's searches lead: they are the freshest signal in the digest and
      // a topic that is only *about* to have Shorts is the most useful thing a
      // scriptwriter can be told. The scan's own findings follow.
      const findings = [googleLine, ...scan.findings].filter((f) => f.length >= 12).slice(0, MAX_FINDINGS);
      if (findings.length >= MIN_FINDINGS) {
        const sources = [
          `YouTube search — ${scan.shorts.length} popular Shorts from this week${scan.region !== DEFAULT_TRENDS_GEO ? ` (${scan.region})` : ""}`,
          ...scan.sources,
          ...(google.trends.length ? [`Google Trends daily searches (${google.geo})`] : []),
        ];
        const digest: TrendDigest = {
          researchedAt: Date.now(),
          findings,
          sources: [...new Set(sources)].slice(0, 6),
          via: "youtube",
          top: scan.shorts.slice(0, 20).map(({ velocity: _velocity, ...t }) => t),
          ideas: scan.ideas,
          ...(google.trends.length ? { googleTrends: google.trends.map((t) => t.title) } : {}),
          region: scan.region,
        };
        saveTrendDigest(digest);
        console.log(
          `[trends] refreshed (${opts.reason ?? "manual"}): ${findings.length} findings and ${digest.ideas?.length ?? 0} ideas from ${scan.shorts.length} Shorts${google.trends.length ? ` + ${google.trends.length} Google searches` : ""} — no Gemini used`,
        );
        return { ok: true, digest };
      }
      youtubeDetail = `YouTube returned too little to read trends from (${scan.shorts.length} Shorts)`;
    } catch (err) {
      if (opts.signal?.aborted) return { ok: false, reason: "failed", detail: "cancelled" };
      youtubeDetail = `YouTube search: ${(err as Error).message}`;
    }
    console.warn(`[trends] ${youtubeDetail}`);

    // 2. Gemini + Google Search only when a person asked for it. Background
    //    refreshes never spend AI quota; the previous digest stays instead.
    if ((opts.reason ?? "manual") !== "manual") return { ok: false, reason: "failed", detail: youtubeDetail };
    const brain = activeBrain();
    if (!brain) return { ok: false, reason: "failed", detail: youtubeDetail };
    let lastDetail = "";
    for (const model of RESEARCH_MODELS) {
      try {
        const resp = await generateContent({
          purpose: "trends",
          apiKey: brain.apiKey,
          model,
          signal: opts.signal,
          timeoutMs: 45_000,
          request: {
            contents: [{ role: "user", parts: [{ text: trendPrompt(opts.now ?? new Date()) }] }],
            tools: [{ googleSearch: {} }],
            generationConfig: { maxOutputTokens: 2048 },
          },
        });
        const findings = parseTrendAnswer(visibleText(resp.candidates?.[0]?.content?.parts)).filter((f) => f.length >= 12);
        if (findings.length < MIN_FINDINGS) {
          lastDetail = `only ${findings.length} finding(s) came back`;
          continue;
        }
        const digest: TrendDigest = {
          researchedAt: Date.now(),
          findings,
          sources: groundingSources(resp),
          via: "search",
        };
        saveTrendDigest(digest);
        console.log(`[trends] refreshed (${opts.reason ?? "manual"}): ${findings.length} findings via ${model}${digest.sources.length ? ` — ${digest.sources.join(", ")}` : ""}`);
        return { ok: true, digest };
      } catch (err) {
        if (err instanceof GeminiError && err.kind === "aborted") return { ok: false, reason: "failed", detail: "cancelled" };
        lastDetail = err instanceof GeminiError ? `${err.kind}: ${err.detail.split("\n")[0]}` : (err as Error).message;
        console.warn(`[trends] ${model} could not search (${lastDetail})`);
        // Search refused (needs billing on that model), quota, network: try the next one.
      }
    }
    console.warn(`[trends] keeping the previous digest (${lastDetail || "search found nothing usable"})`);
    return lastDetail ? { ok: false, reason: "failed", detail: lastDetail } : { ok: false, reason: "no-findings" };
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** After a background scan fails, wait this long before trying again (don't hammer YouTube). */
const FAILURE_BACKOFF_MS = 3 * 60 * 60_000;
let lastBackgroundFailure = 0;

/**
 * Desktop app: keep the digest fresh while Soundwave AI runs (checked every 30
 * minutes, refreshed every 12 hours). Free — YouTube search only, never Gemini.
 * TRENDS_SCAN=0 turns the background scan off (the manual button still works).
 */
export function initTrendScout(): () => void {
  if (process.env.TRENDS_SCAN === "0") return () => undefined;
  const tick = (reason: "startup" | "schedule") => {
    if (refreshing || !trendsDue()) return;
    if (Date.now() - lastBackgroundFailure < FAILURE_BACKOFF_MS) return;
    void refreshTrends({ reason })
      .then((result) => {
        if (!result.ok) lastBackgroundFailure = Date.now();
      })
      .catch((err) => {
        lastBackgroundFailure = Date.now();
        console.warn(`[trends] refresh failed: ${(err as Error).message}`);
      });
  };
  const timer = setInterval(() => tick("schedule"), CHECK_INTERVAL_MS);
  timer.unref?.();
  const first = setTimeout(() => tick("startup"), 25_000);
  first.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}

/** Tests: forget the digest and any run in flight. */
export function resetTrendsForTests(): void {
  refreshing = null;
  lastBackgroundFailure = 0;
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}
