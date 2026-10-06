import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/error.js";
import { getStore } from "../lib/store.js";
import { publicUser } from "../lib/auth.js";
import { PLANS } from "../lib/plans.js";
import { getQuotaFor } from "./tts.js";
import { meterFor } from "../lib/metering.js";
import { config } from "../config.js";

const router = Router();

router.get("/profile", requireAuth, (req, res) => {
  res.json(publicUser(req.user!));
});

const profileSchema = z.object({
  name: z.string().min(2).max(100),
  avatarUrl: z.string().max(500).nullable().optional(),
});

router.put("/profile", requireAuth, validate({ body: profileSchema }), async (req, res, next) => {
  try {
    const { name, avatarUrl } = req.body as z.infer<typeof profileSchema>;
    const store = await getStore();
    const user = await store.updateUser(req.user!.id, {
      name,
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    });
    res.json(publicUser(user!));
  } catch (e) {
    next(e);
  }
});

// Deleting the account asks the person to type their own address: there is no
// password to check, and the button alone is one click away from a mistake.
const deleteSchema = z.object({ confirmEmail: z.string().min(3).max(254) });
router.delete("/account", requireAuth, validate({ body: deleteSchema }), async (req, res, next) => {
  try {
    const { confirmEmail } = req.body as z.infer<typeof deleteSchema>;
    const store = await getStore();
    const user = req.user!;
    if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw new ApiError(400, "EMAIL_MISMATCH", "Type your account's address to confirm.");
    }
    await store.deleteUserSoft(user.id);
    res.json({ ok: true, message: "Account scheduled for deletion. You have a 30-day recovery period." });
  } catch (e) {
    next(e);
  }
});

router.get("/usage", requireAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const quota = await getQuotaFor(req.user!.id);
    const meter = await meterFor(req.user!.id).catch(() => null);
    const logs = await store.listUsageLogs(req.user!.id, 50);
    res.json({
      quota,
      // Minutes of video processed and clips made this month — the numbers the
      // pricing page sells, so the account page has to show the same two.
      meter,
      totalAudioDurationSeconds: req.user!.totalAudioDurationSeconds,
      recentLogs: logs.map((l) => ({
        characterCount: l.characterCount,
        voiceId: l.voiceId,
        audioDurationSeconds: l.audioDurationSeconds,
        generatedAt: l.generatedAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// ── GDPR data export ────────────────────────────────────────────────────────
router.get("/data-export", requireAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const user = req.user!;
    const [projects, usageLogs, invoices] = await Promise.all([
      store.listProjects(user.id),
      store.listUsageLogs(user.id, 500),
      store.listInvoices(user.id),
    ]);
    res.setHeader("Content-Disposition", 'attachment; filename="soundwave-data.json"');
    res.setHeader("Content-Type", "application/json");
    res.send(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          profile: { id: user.id, email: user.email, name: user.name, plan: user.plan, createdAt: user.createdAt },
          planLimit: PLANS[user.plan].characterLimit,
          projects,
          usageLogs,
          invoices,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    next(e);
  }
});

// ── Avatar serving (Content-Disposition: inline) ────────────────────────────
router.get("/avatar/:key", requireAuth, (req, res, next) => {
  const key = req.params.key ?? "";
  if (!/^[0-9a-f-]{36}\.[a-z0-9]+$/.test(key)) return next(new ApiError(400, "INVALID_FILE", "Invalid avatar reference."));
  const p = path.join(config.uploadsDir, key);
  if (!fs.existsSync(p)) return next(new ApiError(404, "NOT_FOUND", "Avatar not found."));
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", "inline");
  fs.createReadStream(p).pipe(res);
});

export default router;
