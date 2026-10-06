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

/**
 * The same request as generateContent, answered as it is written. Budget and
 * counting work exactly the same; caching does not (a streamed chat answer is
 * about this conversation, not a reusable artifact).
 */
export function streamContent(
  args: GenerateArgs & { onText?: (delta: string, full: string) => void; shouldStop?: () => boolean },
): Promise<core.GenerateResponse> {
  const { purpose = "chat", bypassBudget = false, cache: _cacheable = false, ...rest } = args;
  const request = { ...rest, apiBase: rest.apiBase ?? config.geminiApiBase };
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
  if (!bypassBudget) recordGeminiCall(purpose);
  return core.streamGenerateContent(request);
}

// ── Files ───────────────────────────────────────────────────────────────────
// The Files API is how Gemini is handed a photo, a recording, a video or a
// scanned PDF: the bytes are uploaded once, Google keeps them for 48 hours, and
// the request that follows refers to them by URI. Small files (under 20 MB, the
// multipart limit) go up in one request; anything larger would need a resumable
// upload, and the caller checks the size before asking — see lib/gptFiles.ts.

export interface UploadedGeminiFile {
  /** `files/abc123` — the name to poll and to refer to later. */
  name: string;
  /** The `fileData.fileUri` to put in a request. */
  uri: string;
  mimeType: string;
  sizeBytes: number;
  /** PROCESSING until Google has finished with it; ACTIVE is ready. */
  state: string;
  /** When Google drops it (ISO), if it said. */
  expiresAt?: string;
}

interface FilesApiFile {
  name?: string;
  uri?: string;
  mimeType?: string;
  sizeBytes?: string;
  state?: string;
  expirationTime?: string;
  error?: { message?: string };
}

const fileFrom = (file: FilesApiFile, fallbackMime: string): UploadedGeminiFile => ({
  name: String(file.name ?? ""),
  uri: String(file.uri ?? ""),
  mimeType: String(file.mimeType ?? fallbackMime),
  sizeBytes: Number(file.sizeBytes ?? 0),
  state: String(file.state ?? "ACTIVE"),
  ...(file.expirationTime ? { expiresAt: file.expirationTime } : {}),
});

/** One multipart body: the JSON metadata part, then the bytes. */
export function multipartFileBody(data: Buffer, mimeType: string, displayName: string): { body: Buffer; contentType: string } {
  const boundary = `soundwave-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ file: { displayName } })}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([head, data, tail]), contentType: `multipart/related; boundary=${boundary}` };
}

/** Upload one file and wait (briefly) for Google to make it ACTIVE. */
export async function uploadFile(args: {
  data: Buffer;
  mimeType: string;
  displayName: string;
  apiBase?: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<UploadedGeminiFile> {
  const apiBase = (args.apiBase ?? config.geminiApiBase).replace(/\/+$/, "");
  const apiKey = args.apiKey ?? config.geminiApiKey;
  if (!apiKey) throw new core.GeminiError("invalid_key", "No Gemini API key is set (Settings → Brain).");
  const { body, contentType } = multipartFileBody(args.data, args.mimeType, args.displayName);
  // Content-Length is left to fetch: the body is a fixed-size buffer, so undici
  // sets it correctly, and a hand-written one is a trap — see the note in
  // tests/dependency_landslides.test.ts about what a dependency that swaps
  // fetch's dispatcher does to an explicit Content-Length.
  const res = await fetch(`${apiBase}/upload/v1beta/files`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": contentType },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(args.timeoutMs ?? 120_000),
  });
  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) throw core.errorFromResponse(res.status, parsed ?? { error: { message: text.slice(0, 300) || `HTTP ${res.status}` } });
  const uploaded = fileFrom(parsed as FilesApiFile, args.mimeType);
  if (uploaded.state !== "PROCESSING") return uploaded;
  // Video and audio are processed for a few seconds; poll a handful of times.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const poll = await fetch(`${apiBase}/v1beta/${uploaded.name}`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!poll.ok) break;
    const current = fileFrom((await poll.json().catch(() => ({}))) as FilesApiFile, args.mimeType);
    if (current.state !== "PROCESSING") return current;
  }
  return uploaded;
}

/** Drop an uploaded file on Google's side (the person deleted it here). */
export async function deleteFile(name: string, opts: { apiBase?: string; apiKey?: string } = {}): Promise<void> {
  const apiBase = (opts.apiBase ?? config.geminiApiBase).replace(/\/+$/, "");
  const apiKey = opts.apiKey ?? config.geminiApiKey;
  if (!apiKey || !name) return;
  await fetch(`${apiBase}/v1beta/${name.replace(/^\/+/, "")}`, { method: "DELETE", headers: { "x-goog-api-key": apiKey } }).catch(
    () => undefined,
  );
}
