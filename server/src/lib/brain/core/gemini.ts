// ── Google Gemini API (REST) — shared by the PC server and the phone app ────
// Plain fetch against the Gemini Developer API, sending exactly the JSON the
// official @google/genai SDK sends (server/tests/brain.test.ts pins the shape):
//
//   POST {base}/v1beta/models/{model}:generateContent   header x-goog-api-key
//   GET  {base}/v1beta/models?pageSize=…                 (Settings → Brain)
//
// Everything in lib/brain/core is dependency-free TypeScript that runs in
// Node (the PC) and in the phone app's WebView (mobile/ imports it): no Node
// APIs, no packages. Only `content-type` and `x-goog-api-key` headers are
// sent — the two Google's CORS rules allow from a browser.

export const DEFAULT_GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

export type ThinkingLevel = "low" | "medium" | "high";

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  /** A thought summary (only returned when asked for — never shown). */
  thought?: boolean;
  /** Encrypted reasoning context: must go back exactly where it came from. */
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  /** Audio/images sent along (base64), e.g. a recording to transcribe. */
  inlineData?: { mimeType: string; data: string };
  /** Built-in (server-side) tool steps, e.g. a Google Search. */
  toolCall?: Record<string, unknown>;
  toolResponse?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export type GeminiTool = { googleSearch: Record<string, never> } | { functionDeclarations: GeminiFunctionDeclaration[] };

export type ThinkingLevelWire = "LOW" | "MEDIUM" | "HIGH";

export interface GenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: { role: "user"; parts: Array<{ text: string }> };
  tools?: GeminiTool[];
  toolConfig?: { includeServerSideToolInvocations?: boolean };
  generationConfig?: {
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingLevel?: ThinkingLevelWire };
  };
}

export interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  searchEntryPoint?: { renderedContent?: string };
}

export interface GeminiCandidate {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
  finishMessage?: string;
  groundingMetadata?: GroundingMetadata;
}

export interface GenerateResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: Record<string, unknown>;
  modelVersion?: string;
  responseId?: string;
}

export type GeminiErrorKind =
  | "invalid_key"
  | "permission"
  | "region"
  | "quota"
  | "model"
  | "bad_request"
  | "overloaded"
  | "timeout"
  | "network"
  | "aborted"
  | "unknown";

export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;
  readonly status?: number;
  /** Seconds Google asks us to wait (429). */
  readonly retryAfterSec?: number;
  /** A daily quota ran out (resets at midnight Pacific time), not a per-minute one. */
  readonly daily?: boolean;
  /** Google's own words, for logs and the "details" line in Settings. */
  readonly detail: string;
  /** Every model tried before giving up (the chosen one, then the fallback). */
  models?: string[];

  constructor(kind: GeminiErrorKind, detail: string, extra: { status?: number; retryAfterSec?: number; daily?: boolean } = {}) {
    super(detail);
    this.name = "GeminiError";
    this.kind = kind;
    this.detail = detail;
    this.status = extra.status;
    this.retryAfterSec = extra.retryAfterSec;
    this.daily = extra.daily;
  }
}

/** "models/gemini-3.8-flash" → "gemini-3.8-flash". */
export function bareModelId(model: string): string {
  return model.trim().replace(/^models\//, "");
}

export function modelLabel(model: string): string {
  const id = bareModelId(model);
  const latest = /^gemini-(flash|flash-lite|pro)-latest$/.exec(id);
  if (latest) return `Gemini ${latest[1] === "flash-lite" ? "Flash-Lite" : latest[1] === "pro" ? "Pro" : "Flash"} (latest)`;
  const m = /^gemini-(\d+(?:\.\d+)?)-([a-z-]+?)(?:-preview(?:-[\w-]+)?)?$/.exec(id);
  if (!m) return id;
  const variant = m[2]!
    .split("-")
    .map((w) => (w === "lite" ? "Lite" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("-");
  return `Gemini ${m[1]} ${variant}${id.includes("-preview") ? " (preview)" : ""}`;
}

/** Gemini 3+ models: thinking levels, and Google Search mixed with our own tools. */
export function isGemini3(model: string): boolean {
  const id = bareModelId(model);
  if (/^gemini-(flash|flash-lite|pro)-latest$/.test(id)) return true;
  const v = /^gemini-(\d+)/.exec(id);
  return Boolean(v && Number(v[1]) >= 3);
}

// ── Errors ──────────────────────────────────────────────────────────────────

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<Record<string, unknown>>;
  };
}

function retryDelaySeconds(details: Array<Record<string, unknown>>, message: string): number | undefined {
  for (const d of details) {
    if (typeof d.retryDelay === "string") {
      const s = Number.parseFloat(d.retryDelay);
      if (Number.isFinite(s)) return Math.max(1, Math.ceil(s));
    }
  }
  const m = /retry in ([\d.]+)\s*s/i.exec(message);
  return m ? Math.max(1, Math.ceil(Number.parseFloat(m[1]!))) : undefined;
}

/** Google's error JSON → a GeminiError with a kind we can explain. */
export function errorFromResponse(status: number, body: unknown): GeminiError {
  const err = (body as GoogleErrorBody | null)?.error ?? {};
  const message = typeof err.message === "string" && err.message ? err.message : `HTTP ${status}`;
  const statusName = typeof err.status === "string" ? err.status : "";
  const details = Array.isArray(err.details) ? err.details.filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object") : [];
  const reasons = details.map((d) => (typeof d.reason === "string" ? d.reason : "")).filter(Boolean);
  const has = (r: string) => reasons.includes(r);

  if (status === 401 || has("API_KEY_INVALID") || /api key (?:not valid|expired|invalid)/i.test(message)) {
    return new GeminiError("invalid_key", message, { status });
  }
  if (/location is not supported|not available in your (?:country|region)/i.test(message)) {
    return new GeminiError("region", message, { status });
  }
  if (status === 429 || statusName === "RESOURCE_EXHAUSTED") {
    const quotaIds = details.flatMap((d) =>
      Array.isArray(d.violations) ? (d.violations as Array<Record<string, unknown>>).map((v) => String(v?.quotaId ?? "")) : [],
    );
    const daily = quotaIds.some((q) => /PerDay/i.test(q)) || /per day|daily/i.test(message);
    return new GeminiError("quota", message, { status, daily, retryAfterSec: retryDelaySeconds(details, message) });
  }
  if (status === 403 || statusName === "PERMISSION_DENIED") {
    return new GeminiError("permission", message, { status });
  }
  if (status === 404 || statusName === "NOT_FOUND") {
    return new GeminiError("model", message, { status });
  }
  if (status >= 500) {
    return new GeminiError("overloaded", message, { status });
  }
  return new GeminiError("bad_request", message, { status });
}

/** What to tell the person (chat replies, Settings → Brain). `device`: where the request was made. */
export function describeGeminiError(err: GeminiError, model: string, opts: { device?: "pc" | "phone" } = {}): string {
  const tried = err.models?.length ? err.models : [model];
  const name = tried.map(modelLabel).join(" and ");
  switch (err.kind) {
    case "invalid_key":
      return "Google says the Gemini API key isn't valid. Copy it again from Google AI Studio and paste it in Settings → Brain.";
    case "permission":
      return `Google refused this Gemini API key (${trimDetail(err.detail)}). Check the key in Google AI Studio, or create a new one.`;
    case "region":
      return `Google doesn't offer the Gemini API here: ${trimDetail(err.detail)}`;
    case "quota":
      if (err.daily) {
        return `Today's free Gemini requests for ${name} are used up (they reset at midnight Pacific time). Pick another model in Settings → Brain, or turn on billing for the key in Google AI Studio.`;
      }
      return `Google's per-minute limit is reached for ${name}${err.retryAfterSec ? ` — try again in about ${err.retryAfterSec} seconds` : " — try again in a minute"}.`;
    case "model":
      return `Gemini doesn't have a chat model called “${bareModelId(model)}” for this key. Pick another model in Settings → Brain.`;
    case "overloaded":
      return "Gemini is overloaded right now. Try again in a moment.";
    case "timeout":
      return "Gemini took too long to answer. Try again.";
    case "network":
      return opts.device === "phone"
        ? "I couldn't reach Google's Gemini API — check your phone's internet connection."
        : "I couldn't reach Google's Gemini API — check this PC's internet connection.";
    case "aborted":
      return "The request was cancelled.";
    case "bad_request":
      return `Gemini rejected the request: ${trimDetail(err.detail)}`;
    default:
      return `Gemini didn't answer: ${trimDetail(err.detail)}`;
  }
}

function trimDetail(detail: string): string {
  const firstLine = detail.split("\n")[0]!.trim();
  return firstLine.length > 220 ? `${firstLine.slice(0, 217)}…` : firstLine;
}

// ── Requests ────────────────────────────────────────────────────────────────

export interface CallOptions {
  /** e.g. https://generativelanguage.googleapis.com (no trailing slash). */
  apiBase: string;
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function callGemini(method: "GET" | "POST", pathAndQuery: string, opts: CallOptions, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? 45_000);
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    let res: Response;
    try {
      res = await fetch(`${opts.apiBase.replace(/\/+$/, "")}${pathAndQuery}`, {
        method,
        headers: {
          "x-goog-api-key": opts.apiKey,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) throw new GeminiError("timeout", "Gemini didn't answer in time.");
      if (opts.signal?.aborted) throw new GeminiError("aborted", "Cancelled.");
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new GeminiError("network", cause?.code || cause?.message || (err as Error).message || "network error");
    }

    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      if (timedOut) throw new GeminiError("timeout", "Gemini didn't answer in time.");
      if (opts.signal?.aborted) throw new GeminiError("aborted", "Cancelled.");
      throw new GeminiError("network", (err as Error).message || "connection lost");
    }
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) throw errorFromResponse(res.status, parsed ?? { error: { message: text.slice(0, 300) || `HTTP ${res.status}` } });
    if (parsed === null || typeof parsed !== "object") throw new GeminiError("unknown", "Gemini sent an answer that couldn't be read.");
    return parsed;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export type GenerateArgs = CallOptions & { model: string; request: GenerateRequest };

export async function generateContent(args: GenerateArgs): Promise<GenerateResponse> {
  const model = encodeURIComponent(bareModelId(args.model));
  return (await callGemini("POST", `/v1beta/models/${model}:generateContent`, args, args.request)) as GenerateResponse;
}

// ── Streaming ──────────────────────────────────────────────────────────────
// `generateContent` answers in one piece; `streamGenerateContent` sends the same
// answer as server-sent events, a few words at a time. The file-chat tab uses
// it so an answer starts appearing immediately instead of after ten seconds of
// nothing — the difference between the app feeling alive and feeling stuck.
//
// The stream is assembled back into the ordinary GenerateResponse shape (text
// parts merged, the last chunk's finishReason/usage kept), so a caller can
// stream for the person and still store exactly what a non-streamed call would
// have produced.

export interface StreamArgs extends GenerateArgs {
  /** Called for each new piece of text, with the whole answer so far. */
  onText?: (delta: string, full: string) => void;
  /** Called when Google sends reasoning text (Gemini 3 "thinking"). */
  onThought?: (text: string) => void;
  /** Abort the stream early (the person pressed Stop). */
  shouldStop?: () => boolean;
}

/** One SSE `data:` line → the response object it carried (null when unreadable). */
export function parseSseLine(line: string): GenerateResponse | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as GenerateResponse;
  } catch {
    return null;
  }
}

export async function streamGenerateContent(args: StreamArgs): Promise<GenerateResponse> {
  const { onText, onThought, shouldStop, ...request } = args;
  const model = encodeURIComponent(bareModelId(request.model));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs ?? 180_000);
  const onAbort = () => controller.abort();
  if (request.signal) {
    if (request.signal.aborted) controller.abort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
  }

  const parts: GeminiPart[] = [];
  let text = "";
  let finishReason: string | undefined;
  let finishMessage: string | undefined;
  let groundingMetadata: GroundingMetadata | undefined;
  let usageMetadata: Record<string, unknown> | undefined;
  let modelVersion: string | undefined;
  let responseId: string | undefined;

  const absorb = (chunk: GenerateResponse) => {
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text) {
        const last = parts[parts.length - 1];
        // In a stream the text arrives across several parts; they are one answer.
        if (last && typeof last.text === "string" && !last.functionCall) last.text += part.text;
        else parts.push({ ...part });
        text += part.text;
        onText?.(part.text, text);
        continue;
      }
      // Anything that is not text (a function call, a signature, inline data)
      // is kept as its own part, exactly as it arrived.
      parts.push(part);
    }
    if (typeof candidate?.content?.parts?.[0]?.thought === "string") onThought?.(candidate.content.parts[0].thought as string);
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (candidate?.finishMessage) finishMessage = candidate.finishMessage;
    if (candidate?.groundingMetadata) groundingMetadata = candidate.groundingMetadata;
    if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
    if (chunk.modelVersion) modelVersion = chunk.modelVersion;
    if (chunk.responseId) responseId = chunk.responseId;
  };

  try {
    let res: Response;
    try {
      res = await fetch(`${request.apiBase.replace(/\/+$/, "")}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "x-goog-api-key": request.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(request.request),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) throw new GeminiError("timeout", "Gemini didn't answer in time.");
      if (request.signal?.aborted) throw new GeminiError("aborted", "Cancelled.");
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new GeminiError("network", cause?.code || cause?.message || (err as Error).message || "network error");
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        parsed = null;
      }
      throw errorFromResponse(res.status, parsed ?? { error: { message: body.slice(0, 300) || `HTTP ${res.status}` } });
    }
    if (!res.body) throw new GeminiError("unknown", "Gemini sent a stream that couldn't be read.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      if (shouldStop?.()) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Events are separated by a blank line; a chunk boundary can split one.
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const chunk = parseSseLine(line);
        if (chunk) absorb(chunk);
        index = buffer.indexOf("\n");
      }
    }
    const tail = parseSseLine(buffer);
    if (tail) absorb(tail);

    if (!parts.length && !finishReason) {
      if (timedOut) throw new GeminiError("timeout", "Gemini didn't answer in time.");
      if (request.signal?.aborted) throw new GeminiError("aborted", "Cancelled.");
    }
    return {
      candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}), ...(finishMessage ? { finishMessage } : {}), ...(groundingMetadata ? { groundingMetadata } : {}) }],
      ...(usageMetadata ? { usageMetadata } : {}),
      ...(modelVersion ? { modelVersion } : {}),
      ...(responseId ? { responseId } : {}),
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

export interface GeminiModelInfo {
  id: string;
  label: string;
  description: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

/** Models this key can chat with (generateContent, text in/out), newest first. */
export async function listChatModels(opts: CallOptions): Promise<GeminiModelInfo[]> {
  const out: GeminiModelInfo[] = [];
  let pageToken = "";
  for (let page = 0; page < 4; page++) {
    const q = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) q.set("pageToken", pageToken);
    const data = (await callGemini("GET", `/v1beta/models?${q}`, { timeoutMs: 15_000, ...opts })) as {
      models?: Array<Record<string, unknown>>;
      nextPageToken?: string;
    };
    for (const m of data.models ?? []) {
      const id = bareModelId(String(m.name ?? ""));
      const methods = Array.isArray(m.supportedGenerationMethods) ? (m.supportedGenerationMethods as unknown[]).map(String) : [];
      if (!id.startsWith("gemini-") || !methods.includes("generateContent")) continue;
      if (/tts|image|live|transcrib|embed|audio|robotics|omni|computer-use|translate|nano|banana/i.test(id)) continue;
      out.push({
        id,
        label: typeof m.displayName === "string" && m.displayName ? m.displayName : modelLabel(id),
        description: typeof m.description === "string" ? m.description : "",
        inputTokenLimit: typeof m.inputTokenLimit === "number" ? m.inputTokenLimit : undefined,
        outputTokenLimit: typeof m.outputTokenLimit === "number" ? m.outputTokenLimit : undefined,
      });
    }
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
    if (!pageToken) break;
  }
  const version = (id: string) => Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  return out.sort((a, b) => version(b.id) - version(a.id) || a.id.localeCompare(b.id));
}

// ── Reading answers ─────────────────────────────────────────────────────────

/** The text a person should see: text parts, minus thought summaries. */
export function visibleText(parts: GeminiPart[] | undefined): string {
  return (parts ?? [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text as string)
    .join("")
    .trim();
}

export function functionCalls(parts: GeminiPart[] | undefined): GeminiFunctionCall[] {
  return (parts ?? []).filter((p) => p.functionCall && typeof p.functionCall.name === "string").map((p) => p.functionCall!);
}
