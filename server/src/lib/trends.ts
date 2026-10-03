// ── The trend scout: what is actually going viral on Shorts right now ───────
// Virality moves. The script engine (brain/core/viral.ts) is the floor — the
// shapes and rules that keep working — and this is the ceiling: every few days,
// while Soundwave AI runs, the agent searches what is working on Shorts right
// now (Gemini 2.5 Flash + Google Search, the models with free grounding) and
// writes a short digest into the data folder. Every script is then written with
// that digest in hand, and the agent can answer "what's trending?" from it
// without spending a search.
//
// Honest failure: without a key, without search, or when the answer is junk,
// nothing is invented and nothing is wiped — the previous digest stays, with
// its age on it, and the scripts fall back to the standing research.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { GeminiError, generateContent, visibleText } from "./brain/gemini.js";
import { RESEARCH_MODELS } from "./brain/core/research.js";
import { activeBrain } from "./brain/settings.js";

/** A digest is good for this many days before the scout looks again. */
export const TREND_REFRESH_DAYS = 3;
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
  /** Where it was seen (page titles from the search). */
  sources: string[];
  via: "search";
}

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
  /** No Gemini key: the scout can't search (Settings → Brain). */
  needsKey: boolean;
  findings: string[];
  sources: string[];
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
    return { researchedAt: raw.researchedAt, findings, sources, via: "search" };
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
    needsKey: !activeBrain(),
    findings: digest?.findings ?? [],
    sources: digest?.sources ?? [],
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
    const brain = activeBrain();
    if (!brain) return { ok: false, reason: "no-key" };
    let lastDetail = "";
    for (const model of RESEARCH_MODELS) {
      try {
        const resp = await generateContent({
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

/**
 * Background searches only against Google's own API. A custom GEMINI_API_BASE
 * is a stand-in (the desktop E2E and the phone emulator run one) or a proxy —
 * asking it for live trend research would be noise, not information. The
 * manual refresh (the Hub button, POST /agent/trends/refresh) always works.
 */
function googleApiInUse(): boolean {
  return /^https:\/\/generativelanguage\.googleapis\.com\b/.test(config.geminiApiBase);
}

/** Desktop app: keep the digest fresh while Soundwave AI runs (checked every 30 minutes). */
export function initTrendScout(): () => void {
  if (!googleApiInUse()) return () => undefined;
  const tick = (reason: "startup" | "schedule") => {
    if (refreshing || !activeBrain() || !trendsDue()) return;
    void refreshTrends({ reason }).catch((err) => console.warn(`[trends] refresh failed: ${(err as Error).message}`));
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
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}
