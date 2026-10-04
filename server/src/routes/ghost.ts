/**
 * Soundwave AI — Ghost Operator Macro & Workflow Router
 */

import { Router } from "express";
import { z } from "zod";
import { optionalAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ApiError } from "../middleware/error.js";
import {
  listMacros,
  saveCustomMacro,
  deleteCustomMacro,
  decomposeNaturalLanguage,
  executeWorkflow,
  defaultGhostContext,
  BUILTIN_MACROS,
  REAL_ACTIONS,
  NOT_BUILT_YET,
  type MacroWorkflow,
} from "../lib/ghostOperator.js";
import { getConversation } from "../lib/conversation.js";
import { config } from "../config.js";

const router = Router();

/** The real capabilities behind a macro step, for the panel and for callers. */
function capabilities() {
  return {
    real: [...REAL_ACTIONS],
    notYet: Object.keys(NOT_BUILT_YET),
  };
}

// ── 1. GET /macros ──────────────────────────────────────────────────────────
router.get("/macros", optionalAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || "local-user";
    const macros = await listMacros(userId);
    res.json({ macros, capabilities: capabilities() });
  } catch (e) {
    next(e);
  }
});

// ── 2. POST /decompose (Natural Language RPA Planner) ───────────────────────
const decomposeSchema = z.object({
  instruction: z.string().min(1).max(2000),
});

router.post("/decompose", optionalAuth, validate({ body: decomposeSchema }), async (req, res, next) => {
  try {
    const { instruction } = req.body as z.infer<typeof decomposeSchema>;
    const steps = decomposeNaturalLanguage(instruction);
    res.json({
      instruction,
      stepsCount: steps.length,
      steps,
    });
  } catch (e) {
    next(e);
  }
});

// ── 3. POST /macros (Create Custom Macro) ───────────────────────────────────
const createMacroSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default("Custom automation macro"),
  category: z.enum(["creator", "productivity", "system", "custom"]).default("custom"),
  triggerPhrases: z.array(z.string()).default([]),
  steps: z.array(
    z.object({
      id: z.string().optional(),
      action: z.string().min(1),
      params: z.record(z.any()).default({}),
      description: z.string().default("Execute action"),
      delayMs: z.number().min(0).max(10_000).optional().default(200),
    })
  ).min(1),
  icon: z.string().optional(),
});

router.post("/macros", optionalAuth, validate({ body: createMacroSchema }), async (req, res, next) => {
  try {
    const userId = req.user?.id || "local-user";
    const body = req.body as z.infer<typeof createMacroSchema>;

    const created = await saveCustomMacro(userId, {
      name: body.name,
      description: body.description,
      category: body.category,
      triggerPhrases: body.triggerPhrases,
      steps: body.steps.map((s, idx) => ({
        id: s.id || `step-${idx + 1}`,
        action: s.action,
        params: s.params,
        description: s.description,
        delayMs: s.delayMs,
      })),
      icon: body.icon,
    });

    res.status(201).json({ macro: created });
  } catch (e) {
    next(e);
  }
});

// ── 4. DELETE /macros/:id ───────────────────────────────────────────────────
router.delete("/macros/:id", optionalAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || "local-user";
    const macroId = req.params.id ?? "";

    if (BUILTIN_MACROS.some((b) => b.id === macroId)) {
      throw new ApiError(400, "CANNOT_DELETE_BUILTIN", "Built-in pro workflows cannot be deleted.");
    }

    const deleted = await deleteCustomMacro(userId, macroId);
    if (!deleted) throw new ApiError(404, "NOT_FOUND", "Macro workflow not found.");
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// ── 5. POST /execute ────────────────────────────────────────────────────────
const executeSchema = z.object({
  macroId: z.string().optional(),
  instruction: z.string().optional(),
  workflow: z
    .object({
      id: z.string().default("adhoc_macro"),
      name: z.string().default("Ad-hoc Workflow"),
      description: z.string().default("Dynamic macro"),
      category: z.enum(["creator", "productivity", "system", "custom"]).default("custom"),
      triggerPhrases: z.array(z.string()).default([]),
      steps: z.array(
        z.object({
          id: z.string(),
          action: z.string(),
          params: z.record(z.any()),
          description: z.string(),
          delayMs: z.number().optional(),
        })
      ),
      createdAt: z.string().default(new Date().toISOString()),
    })
    .optional(),
});

router.post("/execute", optionalAuth, validate({ body: executeSchema }), async (req, res, next) => {
  try {
    const userId = req.user?.id || "local-user";
    const { macroId, instruction, workflow: adhocWorkflow } = req.body as z.infer<typeof executeSchema>;

    let targetWorkflow: MacroWorkflow | null = null;

    if (macroId) {
      const all = await listMacros(userId);
      targetWorkflow = all.find((m) => m.id === macroId) || null;
      if (!targetWorkflow) {
        throw new ApiError(404, "MACRO_NOT_FOUND", `Macro workflow '${macroId}' not found.`);
      }
    } else if (adhocWorkflow && adhocWorkflow.steps.length > 0) {
      targetWorkflow = adhocWorkflow as MacroWorkflow;
    } else if (instruction) {
      const steps = decomposeNaturalLanguage(instruction);
      if (steps.length === 0) {
        throw new ApiError(400, "NO_ACTIONABLE_STEPS", "No actionable steps could be resolved from instruction.");
      }
      targetWorkflow = {
        id: `adhoc_${Date.now()}`,
        name: instruction.slice(0, 40),
        description: instruction,
        category: "custom",
        triggerPhrases: [instruction.toLowerCase()],
        steps,
        createdAt: new Date().toISOString(),
      };
    } else {
      throw new ApiError(400, "INVALID_REQUEST", "Provide macroId, workflow, or instruction to execute.");
    }

    // The steps really run on this PC: the desktop app can open things, use the
    // clipboard and post notifications; a bare server (development, tests) can
    // still scan files, read the PC's facts and touch the agent's memory.
    const ctx = defaultGhostContext({
      userId,
      desktop: config.desktopApp,
      voice: getConversation().voice || "en-US-GuyNeural",
    });

    const report = await executeWorkflow(targetWorkflow, ctx);
    res.json({
      // A skipped step isn't an error — success means nothing failed.
      success: report.allSuccess,
      report,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
