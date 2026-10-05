// ── Reuse Gemini's own answers instead of asking twice ──────────────────────
// Every generateContent request that is deterministic — no tools, no ongoing
// chat history — is keyed by (model + the exact JSON we send) and its answer
// kept in the data folder. Asking the identical question again (the same
// "Test key" press, the same script brief twice, a retried job after a crash,
// two clicks on Generate) is then free.
//
// Deliberately NOT cached: anything with tools (Google Search answers depend on
// the moment) and chat turns (the history makes each one unique anyway). The
// cache is local to the machine, holds no key material, and can be cleared
// from Settings → Brain ("Clear cache") — see clearGeminiCache().

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";

/** How long an answer stays reusable. */
const MAX_AGE_MS = 7 * 86_400_000;
/** How many answers are kept (an answer is a few KB; this is well under a MB). */
const MAX_ENTRIES = 400;

interface CacheEntry {
  at: number;
  /** The response JSON Gemini sent (as-is). */
  response: unknown;
  /** Which model/purpose produced it, for the Settings line. */
  model: string;
}

interface CacheFile {
  entries?: Record<string, CacheEntry>;
}

function fileFor(): string {
  return path.join(config.dataDir, "gemini-cache.json");
}

let cache: CacheFile | null = null;

function load(): CacheFile {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as CacheFile;
    cache = parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object" ? parsed : { entries: {} };
  } catch {
    cache = { entries: {} };
  }
  return cache;
}

function persist(): void {
  const entries = load().entries ?? {};
  const now = Date.now();
  const kept = Object.entries(entries)
    .filter(([, entry]) => entry && typeof entry.at === "number" && now - entry.at < MAX_AGE_MS)
    .sort((a, b) => b[1]!.at - a[1]!.at)
    .slice(0, MAX_ENTRIES);
  try {
    fs.mkdirSync(path.dirname(fileFor()), { recursive: true });
    const tmp = `${fileFor()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ entries: Object.fromEntries(kept) }, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, fileFor());
  } catch (err) {
    console.warn(`[gemini] could not save the response cache: ${(err as Error).message}`);
  }
}

/** A stable key for one request: the model plus exactly what is sent to Google. */
export function cacheKey(model: string, request: unknown): string {
  return crypto.createHash("sha256").update(`${model}\u0000${JSON.stringify(request ?? null)}`).digest("hex");
}

export function readCachedResponse(key: string): { response: unknown; model: string } | null {
  const entry = load().entries?.[key];
  if (!entry || typeof entry.at !== "number" || Date.now() - entry.at > MAX_AGE_MS) return null;
  return { response: entry.response, model: entry.model ?? "" };
}

export function writeCachedResponse(key: string, model: string, response: unknown): void {
  const entries = (load().entries ??= {});
  entries[key] = { at: Date.now(), response, model };
  persist();
}

export function cacheSize(): number {
  return Object.keys(load().entries ?? {}).length;
}

export function clearGeminiCache(): number {
  const size = cacheSize();
  cache = { entries: {} };
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
  return size;
}

/** Tests: forget the cache. */
export function resetGeminiCacheForTests(): void {
  cache = { entries: {} };
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}
