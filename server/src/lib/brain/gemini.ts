// ── Gemini for the PC server: lib/brain/core/gemini.ts + the configured base ─
// GEMINI_API_BASE (config) points tests and CI at a fake Gemini; everything
// else lives in the shared core (also compiled into the phone app).
//
// This wrapper is also where the app keeps its promise of spending as little
// Gemini as possible, so every caller (chat, scripts, morning briefing, …)
// gets it without remembering to:
//
//   1. single-flight: two identical requests issued at once share one HTTP call;
//   2. cache: a request the caller marks `cache: true` and that was answered
//      in the last week is reused from disk — see cache.ts. Opt-in, because
//      only the caller knows whether "the same question" really is the same
//      (a script for the same topic is; a briefing researched just now is not);
//   3. budget: an optional daily ceiling (GEMINI_DAILY_LIMIT /
//      GEMINI_DAILY_LIMITS) turns into a GeminiError("quota") so the feature
//      falls back to its free path instead of spending the person's quota —
//      see usage.ts.
//
// Callers that must always reach Google (Settings → Brain's "Test key", the
// model list) pass `bypassBudget`.

import { config } from "../../config.js";
import * as core from "./core/gemini.js";
import { cacheKey, readCachedResponse, writeCachedResponse } from "./cache.js";
import { budgetExhausted, recordGeminiBlocked, recordGeminiCacheHit, recordGeminiCall } from "./usage.js";

export * from "./core/gemini.js";

type WithoutBase<T> = Omit<T, "apiBase"> & { apiBase?: string };

/** Everything generateContent accepts, plus the bookkeeping this wrapper does. */
export interface GenerateArgs extends WithoutBase<core.GenerateArgs> {
  /**
   * What this call is for ("chat", "script", "morning", "clips", "screen",
   * "trends", …) — used for the daily counters and per-purpose ceilings.
   */
  purpose?: string;
  /** Settings → Brain's "Test key": always reaches Google, never counted against a ceiling. */
  bypassBudget?: boolean;
  /**
   * Safe to answer from the cache: the same exact request will always want the
   * same answer (a script for the same topic and trends, the same video's clip
   * picks). Off by default — the answer to "write today's briefing" must not be
   * last week's.
   */
  cache?: boolean;
}

/** Requests already on the wire, so two identical ones make one call. */
const inFlight = new Map<string, Promise<core.GenerateResponse>>();

export async function generateContent(args: GenerateArgs): Promise<core.GenerateResponse> {
  const { purpose = "chat", bypassBudget = false, cache: cacheable = false, ...rest } = args;
  const request = { ...rest, apiBase: rest.apiBase ?? config.geminiApiBase };

  // Only requests the caller flagged as safe to reuse, and never ones with
  // tools (a search answer is about right now).
  const reusable = cacheable && !request.request?.tools?.length;
  const key = reusable ? cacheKey(core.bareModelId(request.model), request.request) : "";
  if (reusable) {
    const hit = readCachedResponse(key);
    if (hit) {
      recordGeminiCacheHit();
      return hit.response as core.GenerateResponse;
    }
  }

  // A cached answer is free, so a ceiling is only checked when a real call
  // would go out.
  if (!bypassBudget) {
    const budget = budgetExhausted(purpose);
    if (budget.exhausted) {
      recordGeminiBlocked(purpose);
      throw new core.GeminiError(
        "quota",
        `Today's Gemini limit for this PC is reached (${purpose}: ${budget.used} of ${budget.limit}). Soundwave is using its free local path instead; the count resets tomorrow.`,
        { daily: true },
      );
    }
  }

  const flightKey = `${core.bareModelId(request.model)}\u0000${reusable ? key : `${Date.now()}:${Math.random()}`}`;
  const existing = reusable ? inFlight.get(flightKey) : undefined;
  if (existing) return existing;

  const call = core
    .generateContent(request)
    .then((response) => {
      if (reusable) writeCachedResponse(key, core.bareModelId(request.model), response);
      return response;
    })
    .finally(() => {
      if (inFlight.get(flightKey) === call) inFlight.delete(flightKey);
    });

  if (!bypassBudget) recordGeminiCall(purpose);
  if (reusable) inFlight.set(flightKey, call);
  return call;
}

export function listChatModels(opts: WithoutBase<core.CallOptions>): Promise<core.GeminiModelInfo[]> {
  return core.listChatModels({ ...opts, apiBase: opts.apiBase ?? config.geminiApiBase });
}
