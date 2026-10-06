import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/error.js";
import { getStore } from "../lib/store.js";
import { hashPassword, publicUser, verifyPassword } from "../lib/auth.js";
import { PLANS } from "../lib/plans.js";
import { getQuotaFor } from "./tts.js";
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

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(100),
  newPassword: z
    .string()
    .min(8)
    .max(100)
    .regex(/[a-z]/)
    .regex(/[A-Z]/)
    .regex(/[0-9]/)
    .regex(/[^A-Za-z0-9]/),
});

router.put("/password", requireAuth, validate({ body: passwordSchema }), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body as z.infer<typeof passwordSchema>;
    const store = await getStore();
    const user = req.user!;
    if (!user.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new ApiError(400, "INVALID_PASSWORD", "Your current password is incorrect.");
    }
    await store.updateUser(user.id, { passwordHash: await hashPassword(newPassword) });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

const deleteSchema = z.object({ password: z.string().min(1).max(100) });
router.delete("/account", requireAuth, validate({ body: deleteSchema }), async (req, res, next) => {
  try {
    const { password } = req.body as z.infer<typeof deleteSchema>;
    const store = await getStore();
    const user = req.user!;
    if (user.passwordHash && !(await verifyPassword(password, user.passwordHash))) {
      throw new ApiError(400, "INVALID_PASSWORD", "Your password is incorrect.");
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
    const logs = await store.listUsageLogs(req.user!.id, 50);
    res.json({
      quota,
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
