// ── How much Gemini the app actually uses (and how much it avoids) ──────────
// Soundwave's rule is "the free path first": trends come from YouTube, clips
// from local audio analysis, scripts from the built-in engine when there is no
// key, and so on. What remains — chat, scripts with a key, the morning
// briefing — is Gemini. This module keeps the honest count of that remainder:
//
//   • a per-day counter, by purpose ("chat", "script", "morning", …), written
//     to the data folder so it survives restarts;
//   • a cache of responses that can be reused (see geminiCache.ts) — the two
//     counters together show "used N, saved M";
//   • an optional hard ceiling: GEMINI_DAILY_LIMITS="chat=50,script=30" (or
//     GEMINI_DAILY_LIMIT=100 for everything). When a purpose's ceiling is
//     reached, calls of that purpose fail with a GeminiError("quota") and the
//     feature falls back to its free path instead of spending the user's
//     Google quota. 0/absent means "no ceiling".
//
// Nothing here talks to Google; it only counts.

import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";

export interface GeminiUsageDay {
  /** Total generateContent calls that reached Google. */
  calls: number;
  /** Answers served from the local cache (no call made). */
  cached: number;
  /** Calls refused by a configured daily ceiling. */
  blocked: number;
  /** Calls by purpose ("chat", "script", …). */
  byPurpose: Record<string, number>;
}

export interface GeminiUsageReport extends GeminiUsageDay {
  /** ISO date (local) the numbers belong to. */
  day: string;
  /** Configured ceilings, per purpose and overall (0 = none). */
  limits: { total: number; purposes: Record<string, number> };
  /** Calls left today per purpose (null = unlimited). */
  remaining: { total: number | null; purposes: Record<string, number | null> };
}

/** Keep a fortnight of history; the file is tiny and useful for "how much did I use?". */
const KEEP_DAYS = 14;

interface UsageFile {
  days?: Record<string, GeminiUsageDay>;
}

function fileFor(): string {
  return path.join(config.dataDir, "gemini-usage.json");
}

let cache: UsageFile | null = null;

function dayKey(now = new Date()): string {
  // Local date: "today" for the person, not for a UTC server.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function emptyDay(): GeminiUsageDay {
  return { calls: 0, cached: 0, blocked: 0, byPurpose: {} };
}

function load(): UsageFile {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as UsageFile;
    cache = parsed && typeof parsed === "object" && parsed.days && typeof parsed.days === "object" ? parsed : { days: {} };
  } catch {
    cache = { days: {} };
  }
  return cache;
}

function persist(): void {
  const data = load();
  const days = data.days ?? {};
  const keys = Object.keys(days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[key];
  try {
    fs.mkdirSync(path.dirname(fileFor()), { recursive: true });
    const tmp = `${fileFor()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ days }, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, fileFor());
  } catch (err) {
    // Counting must never break a feature; the in-memory numbers stay right
    // for this session.
    console.warn(`[gemini] could not save usage: ${(err as Error).message}`);
  }
}

function today(): GeminiUsageDay {
  const days = (load().days ??= {});
  return (days[dayKey()] ??= emptyDay());
}

/** Ceilings: GEMINI_DAILY_LIMIT for everything, GEMINI_DAILY_LIMITS="script=20,chat=100" per purpose. */
export function dailyLimits(): { total: number; purposes: Record<string, number> } {
  const asCount = (raw: string | undefined): number => {
    const n = Number.parseInt(String(raw ?? "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const purposes: Record<string, number> = {};
  for (const part of String(process.env.GEMINI_DAILY_LIMITS ?? "").split(",")) {
    const [name, value] = part.split("=");
    const purpose = (name ?? "").trim().toLowerCase();
    const limit = asCount(value);
    if (purpose && limit > 0) purposes[purpose] = limit;
  }
  return { total: asCount(process.env.GEMINI_DAILY_LIMIT), purposes };
}

/** How many calls this purpose has left today (null = unlimited). */
export function remainingCalls(purpose: string): number | null {
  const limits = dailyLimits();
  const used = today();
  const purposeLimit = limits.purposes[purpose] ?? 0;
  const totals: number[] = [];
  if (purposeLimit > 0) totals.push(Math.max(0, purposeLimit - (used.byPurpose[purpose] ?? 0)));
  if (limits.total > 0) totals.push(Math.max(0, limits.total - used.calls));
  if (!totals.length) return null;
  return Math.min(...totals);
}

/** True when the person's own ceiling says "use the free path now". */
export function budgetExhausted(purpose: string): { exhausted: boolean; limit: number; used: number } {
  const limits = dailyLimits();
  const used = today();
  if (limits.purposes[purpose] && (used.byPurpose[purpose] ?? 0) >= limits.purposes[purpose]!) {
    return { exhausted: true, limit: limits.purposes[purpose]!, used: used.byPurpose[purpose] ?? 0 };
  }
  if (limits.total && used.calls >= limits.total) {
    return { exhausted: true, limit: limits.total, used: used.calls };
  }
  return { exhausted: false, limit: limits.purposes[purpose] ?? limits.total ?? 0, used: used.byPurpose[purpose] ?? used.calls };
}

export function recordGeminiCall(purpose: string): void {
  const day = today();
  day.calls += 1;
  day.byPurpose[purpose] = (day.byPurpose[purpose] ?? 0) + 1;
  persist();
}

export function recordGeminiCacheHit(): void {
  today().cached += 1;
}

export function recordGeminiBlocked(purpose: string): void {
  const day = today();
  day.blocked += 1;
  day.byPurpose[purpose] = day.byPurpose[purpose] ?? 0;
  persist();
}

export function geminiUsageReport(now = new Date()): GeminiUsageReport {
  const day = { ...emptyDay(), ...(load().days?.[dayKey(now)] ?? {}) };
  const limits = dailyLimits();
  const remainingPurposes: Record<string, number | null> = {};
  for (const purpose of Object.keys(limits.purposes)) {
    remainingPurposes[purpose] = Math.max(0, limits.purposes[purpose]! - (day.byPurpose[purpose] ?? 0));
  }
  return {
    ...day,
    day: dayKey(now),
    limits,
    remaining: {
      total: limits.total ? Math.max(0, limits.total - day.calls) : null,
      purposes: remainingPurposes,
    },
  };
}

/** Tests: forget the counters. */
export function resetGeminiUsageForTests(): void {
  cache = { days: {} };
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}
