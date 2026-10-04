import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth, requirePlan } from "../middleware/auth.js";
import { ApiError } from "../middleware/error.js";
import { getStore } from "../lib/store.js";
import { sha256 } from "../lib/auth.js";

const router = Router();

// Enterprise only. API keys grant access to VIDEO EXPORT endpoints only —
// TTS generation is always client-side.
router.use(requireAuth, requirePlan("ENTERPRISE"));

router.get("/", async (_req, res, next) => {
  try {
    const store = await getStore();
    const keys = await store.listApiKeys(_req.user!.id);
    res.json({
      apiKeys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
        createdAt: k.createdAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
});

router.post("/", validate({ body: createSchema }), async (req, res, next) => {
  try {
    const { name, expiresInDays } = req.body as z.infer<typeof createSchema>;
    const store = await getStore();
    const raw = `sw_${crypto.randomBytes(24).toString("base64url")}`;
    const key = await store.createApiKey({
      userId: req.user!.id,
      name,
      keyHash: sha256(raw),
      prefix: raw.slice(0, 11),
      lastUsedAt: null,
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString() : null,
    });
    // The full key is returned exactly once.
    res.status(201).json({ apiKey: { id: key.id, name: key.name, prefix: key.prefix, key: raw, createdAt: key.createdAt } });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const store = await getStore();
    const keys = await store.listApiKeys(req.user!.id);
    const target = keys.find((k) => k.id === req.params.id);
    if (!target) throw new ApiError(404, "NOT_FOUND", "API key not found.");
    await store.updateApiKey(target.id, { revokedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
