// ── The agent's brain (Google Gemini): status and Settings → Brain ──────────
//   GET    /api/v1/brain                status — never the key itself (Command Center, Settings)
//   PUT    /api/v1/brain                { apiKey?, model?, thinking?, webSearch? }   ┐
//   DELETE /api/v1/brain/key            forget the saved key                         │ the desktop
//   POST   /api/v1/brain/test           { apiKey?, model? } → does Gemini answer?    │ app's own
//   GET    /api/v1/brain/models         models this key can chat with                │ window only
//   GET    /api/v1/brain/abilities?app= what the agent can do on this PC            │
//   GET    /api/v1/brain/mode         how it talks now, and every mode to choose    │
//   PUT    /api/v1/brain/mode         { mode } or { asked: "be formal" }            ┘
//   GET    /api/v1/brain/pc             this PC's live stats (Command Center card) — desktop app only

import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { ApiError } from "../middleware/error.js";
import { localAppGuard, notFromApp } from "../middleware/localApp.js";
import { validate } from "../middleware/validate.js";
import {
  DEFAULT_MODEL,
  MODEL_CHOICES,
  activeBrain,
  brainStatus,
  markSearchUnavailable,
  noteBrainError,
  noteBrainOk,
  saveBrainSettings,
} from "../lib/brain/settings.js";
import {
  GeminiError,
  bareModelId,
  describeGeminiError,
  generateContent,
  isGemini3,
  listChatModels,
  modelLabel,
  visibleText,
  type GenerateRequest,
} from "../lib/brain/gemini.js";
import { searchRefused } from "../lib/brain/chat.js";
import { agentModeStatus, saveAgentMode } from "../lib/agentMode.js";
import { detectMode, isAgentMode } from "../lib/brain/core/persona.js";
import { clearGeminiCache, cacheSize } from "../lib/brain/cache.js";
import { findApp, listStartApps, pcStatus } from "../lib/brain/pc.js";

const router = Router();

const settingsOnly = localAppGuard(
  () => config.brainSettingsAvailable,
  "Brain settings are only available in the desktop app (set GEMINI_API_KEY on a server).",
);

router.get("/", (req, res) => {
  res.json(brainStatus({ includeKeyHint: config.brainSettingsAvailable && !notFromApp(req) }));
});

const apiKey = z
  .string()
  .trim()
  .min(20, "That's too short to be a Gemini API key.")
  .max(300)
  .regex(/^[\x21-\x7e]+$/, "A Gemini API key has no spaces or special characters.");
const model = z
  .string()
  .trim()
  .regex(/^(?:models\/)?[a-z0-9][a-z0-9.\-]{2,80}$/i, "That isn't a Gemini model name.");

const putSchema = z.object({
  apiKey: apiKey.optional(),
  model: model.optional(),
  thinking: z.enum(["low", "medium", "high"]).optional(),
  webSearch: z.boolean().optional(),
});

/** A key that just passed "Save & test" (memory only): saving it keeps that result. */
let passedKey: { key: string; model: string; latencyMs: number; at: number } | null = null;

router.put("/", settingsOnly, validate({ body: putSchema }), (req, res) => {
  const body = req.body as z.infer<typeof putSchema>;
  saveBrainSettings(body);
  const brain = activeBrain();
  if (body.apiKey && passedKey && passedKey.key === body.apiKey && brain?.model === passedKey.model && Date.now() - passedKey.at < 10 * 60_000) {
    noteBrainOk(passedKey.model, passedKey.latencyMs);
  }
  passedKey = null;
  res.json(brainStatus({ includeKeyHint: true }));
});

router.delete("/key", settingsOnly, (_req, res) => {
  saveBrainSettings({ apiKey: null });
  res.json(brainStatus({ includeKeyHint: true }));
});

// Drop the reusable answers (cache.ts). Nothing else is touched and the count
// of calls already made today stays — those calls happened.
router.delete("/cache", settingsOnly, (_req, res) => {
  const cleared = clearGeminiCache();
  res.json({ ok: true, cleared, remaining: cacheSize() });
});

function testRequest(forModel: string): GenerateRequest {
  return {
    contents: [{ role: "user", parts: [{ text: "This is a connection test. Reply with exactly one word: ready" }] }],
    generationConfig: {
      maxOutputTokens: 1024,
      ...(isGemini3(forModel) ? { thinkingConfig: { thinkingLevel: "LOW" as const } } : {}),
    },
  };
}

const testSchema = z.object({ apiKey: apiKey.optional(), model: model.optional() });

router.post("/test", settingsOnly, validate({ body: testSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof testSchema>;
    const brain = activeBrain();
    const key = body.apiKey || brain?.apiKey;
    if (!key) throw new ApiError(400, "NO_KEY", "Paste a Gemini API key first.");
    const testModel = body.model ? bareModelId(body.model) : (brain?.model ?? DEFAULT_MODEL);
    const isActiveKey = Boolean(brain && key === brain.apiKey);

    const started = Date.now();
    let reply = "";
    try {
      // A key test must reach Google even if a daily ceiling is configured
      // (and it is never cached — nothing opts in here).
      const resp = await generateContent({ apiKey: key, model: testModel, purpose: "test", bypassBudget: true, request: testRequest(testModel), timeoutMs: 30_000 });
      reply = visibleText(resp.candidates?.[0]?.content?.parts);
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      if (isActiveKey) noteBrainError(err, testModel);
      return res.json({ ok: false, model: testModel, modelLabel: modelLabel(testModel), kind: err.kind, message: describeGeminiError(err, testModel), detail: err.detail.slice(0, 500) });
    }
    const latencyMs = Date.now() - started;
    if (isActiveKey) noteBrainOk(testModel, latencyMs);
    else if (body.apiKey) passedKey = { key: body.apiKey, model: testModel, latencyMs, at: Date.now() };

    // Web search costs a search request on paid keys, so it's only checked when turned on.
    let search: "off" | "ok" | "unavailable" | "unknown" = "off";
    let searchDetail: string | null = null;
    if (isActiveKey && brain?.webSearch && isGemini3(testModel)) {
      try {
        await generateContent({
          apiKey: key,
          model: testModel,
          purpose: "test",
          bypassBudget: true,
          request: { ...testRequest(testModel), tools: [{ googleSearch: {} }] },
          timeoutMs: 30_000,
        });
        search = "ok";
      } catch (err) {
        if (err instanceof GeminiError && searchRefused(err)) {
          markSearchUnavailable();
          search = "unavailable";
        } else search = "unknown";
        searchDetail = err instanceof GeminiError ? err.detail.slice(0, 300) : String(err);
      }
    }

    res.json({ ok: true, model: testModel, modelLabel: modelLabel(testModel), latencyMs, reply: reply.slice(0, 200), search, searchDetail });
  } catch (e) {
    next(e);
  }
});

router.get("/models", settingsOnly, async (_req, res) => {
  const brain = activeBrain();
  const recommended = MODEL_CHOICES.map((m) => ({ ...m, available: null as boolean | null }));
  if (!brain) return res.json({ recommended, more: [], listed: false });
  try {
    const listed = await listChatModels({ apiKey: brain.apiKey });
    const ids = new Set(listed.map((m) => m.id));
    for (const m of recommended) m.available = m.id.endsWith("-latest") ? (ids.has(m.id) ? true : null) : ids.has(m.id);
    const more = listed.filter((m) => !MODEL_CHOICES.some((c) => c.id === m.id)).map((m) => ({ id: m.id, label: m.label }));
    res.json({ recommended, more, listed: true });
  } catch (err) {
    res.json({
      recommended,
      more: [],
      listed: false,
      error: err instanceof GeminiError ? describeGeminiError(err, brain.model) : (err as Error).message,
    });
  }
});

// ── How the agent talks ─────────────────────────────────────────────────────
// Readable anywhere the Command Center is (the pill in the header shows it),
// but changing it is a settings action, so it follows the same desktop-app rule
// as the key and the model.
router.get("/mode", (_req, res) => {
  res.json(agentModeStatus());
});

const modeSchema = z
  .object({
    /** The mode's own id, when the picker sent one. */
    mode: z.string().trim().max(40).optional(),
    /** Or the words the person used — "be formal", "talk like my executive assistant". */
    asked: z.string().trim().max(120).optional(),
  })
  .refine((b) => Boolean(b.mode || b.asked), { message: "Say which mode, or what you want it to sound like." });

router.put("/mode", settingsOnly, validate({ body: modeSchema }), (req, res, next) => {
  const body = req.body as z.infer<typeof modeSchema>;
  // A phrase is resolved here rather than trusted to the caller, so the pill,
  // Settings and the agent's own tool all answer the same words the same way.
  const wanted = body.mode && isAgentMode(body.mode) ? body.mode : detectMode(body.mode ?? body.asked ?? "");
  if (!wanted) {
    return next(
      new ApiError(
        400,
        "UNKNOWN_MODE",
        `That isn't a mode I know. The ones there are: ${agentModeStatus().modes.map((m) => m.name).join(", ")}.`,
      ),
    );
  }
  saveAgentMode(wanted);
  res.json(agentModeStatus());
});

// The same live facts the agent's get_pc_status tool reads — the Command
// Center's System Stats card shows them, so the card and the agent agree.
const desktopOnly = localAppGuard(() => config.desktopApp, "PC stats are only available in the desktop app.");
router.get("/pc", desktopOnly, async (_req, res) => {
  res.json(await pcStatus(300));
});

router.get("/abilities", settingsOnly, async (req, res) => {
  const desktop = config.desktopApp;
  const canOpenApps = desktop && process.platform === "win32";
  const apps = canOpenApps ? await listStartApps() : { apps: [], source: "none" as const };
  const query = typeof req.query.app === "string" ? req.query.app.trim().slice(0, 120) : "";
  const found = query ? findApp(apps.apps, query) : null;
  res.json({
    desktop,
    platform: process.platform,
    shorts: true,
    openWebsites: desktop,
    pcStatus: desktop,
    openApps: {
      available: canOpenApps,
      count: apps.apps.length,
      source: apps.source,
      ...(found ? { query, match: found.best?.name ?? null, alternatives: found.alternatives } : {}),
    },
  });
});

export default router;
