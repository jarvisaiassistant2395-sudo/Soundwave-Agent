// ── Settings → Brain: the Gemini key and model the agent thinks with ────────
// Saved on this PC only, in DATA_DIR/brain.json (desktop app: %APPDATA%\
// Soundwave AI\data\brain.json; file mode 0600 where the OS supports it). The
// key never goes back to the app's pages — they only get a hint ("AIza…9xQk").
// GEMINI_API_KEY / GEMINI_MODEL (env) are used when no key is saved (hosted
// and development setups).

import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { cacheSize } from "./cache.js";
import { geminiUsageReport } from "./usage.js";
import { bareModelId, describeGeminiError, GeminiError, modelLabel } from "./gemini.js";

import type { ThinkingLevel } from "./core/gemini.js";

export type { ThinkingLevel };

export const DEFAULT_MODEL = "gemini-3.8-flash";
/**
 * Tried when the chosen model is over its limit or overloaded. On Google's
 * free tier every model has its own quota, so this usually still answers.
 */
export const FALLBACK_MODEL = "gemini-3.5-flash-lite";

/** Offered in Settings → Brain (plus whatever else the key can use). All work with a free key. */
export const MODEL_CHOICES: Array<{ id: string; label: string; note: string }> = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "Google's smartest Flash model — recommended" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", note: "The previous Flash model" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", note: "Fastest replies, a little less clever" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", note: "Light and quick" },
  { id: "gemini-flash-latest", label: "Newest Flash (automatic)", note: "Always Google's latest Flash model" },
];

export interface BrainSettings {
  apiKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  webSearch?: boolean;
  updatedAt?: string;
}

export interface ActiveBrain {
  provider: "gemini";
  apiKey: string;
  source: "settings" | "env";
  model: string;
  thinking: ThinkingLevel;
  /** Google Search grounding (needs a key with billing — not on the free tier). */
  webSearch: boolean;
}

function fileFor(): string {
  return path.join(config.dataDir, "brain.json");
}

let cache: { file: string; settings: BrainSettings } | null = null;

export function loadBrainSettings(): BrainSettings {
  const file = fileFor();
  if (cache?.file === file) return cache.settings;
  let settings: BrainSettings = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    settings = {
      apiKey: typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : undefined,
      model: typeof raw.model === "string" && raw.model.trim() ? bareModelId(raw.model) : undefined,
      thinking: raw.thinking === "medium" || raw.thinking === "high" || raw.thinking === "low" ? raw.thinking : undefined,
      webSearch: raw.webSearch === true,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    };
  } catch {
    /* first run, or unreadable: no settings */
  }
  cache = { file, settings };
  return settings;
}

export function saveBrainSettings(patch: Omit<Partial<BrainSettings>, "apiKey"> & { apiKey?: string | null }): BrainSettings {
  const current = loadBrainSettings();
  const next: BrainSettings = { ...current };
  if (patch.apiKey === null) delete next.apiKey;
  else if (typeof patch.apiKey === "string" && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  if (typeof patch.model === "string" && patch.model.trim()) next.model = bareModelId(patch.model);
  if (patch.thinking) next.thinking = patch.thinking;
  if (typeof patch.webSearch === "boolean") next.webSearch = patch.webSearch;
  next.updatedAt = new Date().toISOString();

  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = { file, settings: next };

  // A new key, model or search choice deserves a fresh start.
  if ("apiKey" in patch || "model" in patch || "webSearch" in patch) resetBrainHealth();
  return next;
}

/** The brain the agent uses right now, or null (no key anywhere). */
export function activeBrain(): ActiveBrain | null {
  const s = loadBrainSettings();
  const fromSettings = s.apiKey;
  const apiKey = fromSettings || config.geminiApiKey;
  if (!apiKey) return null;
  return {
    provider: "gemini",
    apiKey,
    source: fromSettings ? "settings" : "env",
    model: s.model || (config.geminiModel ? bareModelId(config.geminiModel) : DEFAULT_MODEL),
    thinking: s.thinking ?? "low",
    webSearch: s.webSearch === true,
  };
}

/** "AIzaSyA…9xQk" — enough to recognise a key, useless to anyone else. */
export function keyHint(key: string): string {
  const k = key.trim();
  if (k.length <= 10) return "…";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

// ── How the brain is doing (memory only) ────────────────────────────────────

export interface BrainHealth {
  lastOkAt: string | null;
  lastModel: string | null;
  lastLatencyMs: number | null;
  /** The last thing that went wrong, in words for the person. */
  lastError: { kind: string; message: string; detail: string; at: string } | null;
  /** Google Search was refused for this key (free tier) — answer without it. */
  searchUnavailable: boolean;
}

let health: BrainHealth = { lastOkAt: null, lastModel: null, lastLatencyMs: null, lastError: null, searchUnavailable: false };

export function brainHealth(): BrainHealth {
  return health;
}

export function resetBrainHealth(): void {
  health = { lastOkAt: null, lastModel: null, lastLatencyMs: null, lastError: null, searchUnavailable: false };
}

export function noteBrainOk(model: string, latencyMs: number): void {
  health = { ...health, lastOkAt: new Date().toISOString(), lastModel: model, lastLatencyMs: latencyMs, lastError: null };
}

export function noteBrainError(err: unknown, model: string): void {
  const message = err instanceof GeminiError ? describeGeminiError(err, model) : `Gemini didn't answer: ${(err as Error)?.message ?? String(err)}`;
  health = {
    ...health,
    lastError: {
      kind: err instanceof GeminiError ? err.kind : "unknown",
      message,
      detail: err instanceof GeminiError ? err.detail.slice(0, 500) : String((err as Error)?.message ?? err).slice(0, 500),
      at: new Date().toISOString(),
    },
  };
}

export function markSearchUnavailable(): void {
  health = { ...health, searchUnavailable: true };
}

/** For Settings → Brain and the Command Center: never includes the key itself. */
export function brainStatus(opts: { includeKeyHint: boolean }) {
  const brain = activeBrain();
  const s = loadBrainSettings();
  const model = brain?.model ?? s.model ?? DEFAULT_MODEL;
  return {
    provider: "gemini" as const,
    configured: Boolean(brain),
    source: brain?.source ?? null,
    keyHint: opts.includeKeyHint && brain ? keyHint(brain.apiKey) : null,
    envKey: Boolean(config.geminiApiKey),
    model,
    modelLabel: modelLabel(model),
    thinking: brain?.thinking ?? s.thinking ?? "low",
    webSearch: brain?.webSearch ?? s.webSearch === true,
    searchUnavailable: health.searchUnavailable,
    fallbackModel: FALLBACK_MODEL,
    fallbackModelLabel: modelLabel(FALLBACK_MODEL),
    models: MODEL_CHOICES,
    settingsAvailable: config.brainSettingsAvailable,
    desktopActions: config.desktopApp,
    lastOkAt: health.lastOkAt,
    lastModel: health.lastModel,
    lastModelLabel: health.lastModel ? modelLabel(health.lastModel) : null,
    lastLatencyMs: health.lastLatencyMs,
    lastError: health.lastError,
    updatedAt: s.updatedAt ?? null,
    // How much Gemini this PC used today, and how much it avoided (free paths
    // + cached answers). Shown in Settings → Brain.
    usage: { ...geminiUsageReport(), cachedAnswers: cacheSize() },
  };
}

export function resetBrainSettingsForTests(): void {
  cache = null;
  resetBrainHealth();
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}
