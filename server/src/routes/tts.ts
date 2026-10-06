import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import type { Request, RequestHandler } from "express";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { notFromApp } from "../middleware/localApp.js";
import { ApiError } from "../middleware/error.js";
import { usageLimiter, uploadLimiter } from "../lib/security.js";
import { getStore } from "../lib/store.js";
import { PLANS, type Plan } from "../lib/plans.js";
import { effectivePlan } from "../lib/edition.js";
import { config } from "../config.js";
import { getVoice } from "../lib/voices.js";
import { synthesizeEdgeTTS } from "../lib/edgeTts.js";
import { isLocalVoiceId, localVoiceShortId, synthesizeLocalVoice } from "../lib/kokoro.js";
import {
  assertConfigured,
  createCloneProfile,
  deleteCloneProfile,
  listCloneProfiles,
  getProfileSamplePath,
  getVoiceCloneStatus,
  sniffAudio,
  synthesizeClone,
  validateCloneReference,
} from "../lib/voiceclone.js";

const router = Router();

// ── Quota helper ────────────────────────────────────────────────────────────
// Enforced server-side. The client only reports character counts AFTER
// generation completes; the TTS text itself is never transmitted.
export async function getQuotaFor(userId: string) {
  const store = await getStore();
  const user = await store.findUserById(userId);
  if (!user) throw new ApiError(401, "UNAUTHORIZED", "User not found.");
  const plan = effectivePlan(user.plan);
  const limit = PLANS[plan].characterLimit;
  const resetDate = new Date(user.characterResetDate);
  const now = new Date();
  let used = user.charactersUsedThisMonth;
  if (now >= resetDate) {
    // New billing month — reset.
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    used = 0;
    await store.updateUser(userId, { charactersUsedThisMonth: 0, characterResetDate: next.toISOString() });
  }
  return { used, limit, resetDate: resetDate.toISOString(), plan, allowed: used < limit };
}

router.get("/quota", requireAuth, async (req, res, next) => {
  try {
    res.json(await getQuotaFor(req.user!.id));
  } catch (e) {
    next(e);
  }
});

const usageSchema = z.object({
  voiceId: z.string().min(1).max(64),
  characterCount: z.number().int().min(1).max(10_000), // max single-report bound
  audioDurationSeconds: z.number().min(0).max(86_400),
});

const synthesizeSchema = z.object({
  text: z.string().min(1).max(5000),
  voice: z.string().min(1).max(64),
  speed: z.number().min(0.5).max(2).optional(),
  pitch: z.number().min(-50).max(50).optional(),
  volume: z.number().min(0).max(100).optional(),
});

// ── Server-side synthesis via Microsoft Edge Neural voices ──────────────────
// Returns MP3 audio (base64) + word timings. Quota is enforced here.
router.post("/synthesize", requireAuth, usageLimiter, validate({ body: synthesizeSchema }), async (req, res, next) => {
  try {
    const { text, voice, speed, pitch, volume } = req.body as z.infer<typeof synthesizeSchema>;

    // ── On-this-PC voice (Kokoro) ────────────────────────────────────────────
    // Generated locally, so there is nothing to meter: no Microsoft characters
    // are used and no quota is charged. Pitch/volume belong to the Edge engine;
    // a request that asks for them here is refused rather than quietly ignored.
    if (isLocalVoiceId(voice)) {
      if (pitch !== undefined || volume !== undefined) {
        throw new ApiError(400, "INVALID_VOICE_OPTION", "Pitch and volume aren't available on the on-this-PC voices — use a Soundwave voice, or drop them.");
      }
      const local = await synthesizeLocalVoice({ text, voiceId: voice, speed });
      const quota = await getQuotaFor(req.user!.id);
      return res.json({
        audioBase64: local.audioBase64,
        mimeType: local.mimeType,
        duration: local.duration,
        wordTimings: local.wordTimings,
        voiceId: voice,
        voiceShortId: localVoiceShortId(voice),
        engine: "kokoro",
        used: quota.used,
        limit: quota.limit,
        resetDate: quota.resetDate,
      });
    }

    const voiceMeta = getVoice(voice);
    if (!voiceMeta) throw new ApiError(400, "INVALID_VOICE", "Unknown voice. Choose one of the supported Microsoft Neural voices.");

    const store = await getStore();
    const quota = await getQuotaFor(req.user!.id);
    const characters = text.length;
    if (quota.used + characters > quota.limit) {
      const err = new ApiError(403, "QUOTA_EXCEEDED", "You've reached your monthly character limit. Upgrade to Pro for more.");
      throw err;
    }

    const result = await synthesizeEdgeTTS({ text, voice, speed, pitch, volume });

    await store.addUsageLog({
      userId: req.user!.id,
      characterCount: characters,
      voiceId: voice,
      audioDurationSeconds: Math.max(1, Math.round(result.duration)),
      generatedAt: new Date().toISOString(),
    });
    await store.updateUser(req.user!.id, {
      charactersUsedThisMonth: quota.used + characters,
      totalAudioDurationSeconds: req.user!.totalAudioDurationSeconds + Math.round(result.duration),
    });

    res.json({
      audioBase64: result.audioBase64,
      mimeType: result.mimeType,
      duration: result.duration,
      wordTimings: result.wordTimings,
      voiceId: voice,
      used: quota.used + characters,
      limit: quota.limit,
      resetDate: quota.resetDate,
    });
  } catch (e) {
    next(e);
  }
});

// ── Voice cloning (managed MOSS / optional Chatterbox sidecar) ──────────────
// Cloned voices are owned per-user by THIS API (reference clips stored under
// <dataDir>/voice-clips/<userId>/); the sidecar itself stays stateless so it
// can run on ephemeral free hosting. Everything degrades gracefully when
// VOICECLONE_URL is unset: /clone/status reports it and the UI hides the
// feature.

const PLAN_RANK: Record<Plan, number> = { FREE: 0, PRO: 1, ENTERPRISE: 2 };

/** Plan gate for voice cloning (config: VOICECLONE_MIN_PLAN, default FREE). */
function assertClonePlan(user: { plan: Plan }): void {
  const min = (config.voiceCloneMinPlan in PLAN_RANK ? config.voiceCloneMinPlan : "FREE") as Plan;
  if (PLAN_RANK[effectivePlan(user.plan)] < PLAN_RANK[min]) {
    throw new ApiError(403, "PLAN_REQUIRED", `Voice cloning requires the ${min} plan or higher. Upgrade to use cloned voices.`);
  }
}

/**
 * Who owns the cloned voices for this request.
 *
 * The desktop app has no sign-in: it is one person's PC, and every other local
 * feature (chat, shorts, Ghost Operator) runs as the built-in "local-user". So
 * in the desktop app, a request from the app's own window (same origin, and a
 * loopback Host when the API only listens on loopback) uses that local profile.
 * A signed-in session still works as before (CSRF-checked by requireAuth), and
 * hosted deployments without DESKTOP_APP keep requiring sign-in.
 */
const LOCAL_CLONE_OWNER = "local-user";

function hasSession(req: Request): boolean {
  return /(?:^|;\s*)(?:access_token|refresh_token)=/.test(req.headers.cookie ?? "");
}

const cloneAccess: RequestHandler = (req, res, next) => {
  if (!config.desktopApp) return requireAuth(req, res, next);
  const useLocalProfile = () => {
    const problem = notFromApp(req);
    if (problem) return next(new ApiError(403, "FORBIDDEN", problem));
    next();
  };
  if (!hasSession(req)) return useLocalProfile();
  // A session cookie: honour it if it's valid. A stale one (left over from an
  // older version, now cleared by requireAuth) falls back to the local profile
  // instead of asking for a sign-in the desktop app doesn't have.
  return requireAuth(req, res, (err?: unknown) => {
    if (err instanceof ApiError && err.status === 401) return useLocalProfile();
    next(err as Error | undefined);
  });
};

/** The signed-in user's id, or the desktop app's local profile. */
function cloneOwnerId(req: Request): string {
  return req.user?.id ?? LOCAL_CLONE_OWNER;
}

router.get("/clone/status", cloneAccess, async (_req, res, next) => {
  try {
    res.json(await getVoiceCloneStatus());
  } catch (e) {
    next(e);
  }
});

router.get("/clone/profiles", cloneAccess, async (req, res, next) => {
  try {
    assertConfigured();
    res.json({ profiles: await listCloneProfiles(cloneOwnerId(req)) });
  } catch (e) {
    next(e);
  }
});

router.get("/clone/profiles/:id/sample", optionalAuth, async (req, res, next) => {
  try {
    const samplePath = await getProfileSamplePath(cloneOwnerId(req), req.params.id ?? "");
    const contentType: Record<string, string> = {
      ".flac": "audio/flac",
      ".m4a": "audio/mp4",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".wav": "audio/wav",
      ".webm": "audio/webm",
    };
    res.setHeader("Content-Type", contentType[path.extname(samplePath).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "private, no-store");
    fs.createReadStream(samplePath).pipe(res);
  } catch (e) {
    next(e);
  }
});

const refUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const createProfileSchema = z.object({
  name: z.string().min(1).max(80),
  refText: z.string().max(2000).optional(),
  consent: z.string().optional(),
});

router.post("/clone/profiles", cloneAccess, uploadLimiter, refUpload.single("file"), async (req, res, next) => {
  try {
    const parsed = createProfileSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid profile data.");
    if (parsed.data.consent !== "true") {
      throw new ApiError(400, "CLONE_CONSENT_REQUIRED", "Confirm that you own this voice or have the speaker's explicit permission before creating a clone.");
    }
    assertConfigured();
    if (req.user) assertClonePlan(req.user);
    const cloneStatus = await getVoiceCloneStatus();
    if (!cloneStatus.available) {
      throw new ApiError(503, "VOICECLONE_UNAVAILABLE", cloneStatus.reason ?? "The voice-cloning model is not ready on this PC.");
    }
    if (!req.file) throw new ApiError(400, "NO_FILE", "Attach at least 3 seconds of clean reference speech. MOSS accepts 3–10 seconds; Chatterbox accepts 3–60 seconds.");
    if (!sniffAudio(req.file.buffer)) {
      throw new ApiError(400, "INVALID_FILE", "The reference clip must be a WAV, MP3, FLAC, OGG, M4A, or WEBM audio file.");
    }
    const filename = req.file.originalname || "reference.wav";
    const mimeType = req.file.mimetype || "audio/wav";
    const reference = await validateCloneReference({ audio: req.file.buffer, filename, mimeType });
    const profile = await createCloneProfile(cloneOwnerId(req), {
      name: parsed.data.name.trim(),
      audio: req.file.buffer,
      filename,
      mimeType,
      refText: parsed.data.refText,
      consentConfirmedAt: new Date().toISOString(),
      engine: reference.engine,
    });
    res.status(201).json({ profile });
  } catch (e) {
    next(e);
  }
});

router.delete("/clone/profiles/:id", cloneAccess, async (req, res, next) => {
  try {
    assertConfigured();
    await deleteCloneProfile(cloneOwnerId(req), req.params.id ?? "");
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

const cloneSchema = z.object({
  text: z.string().min(1).max(5000),
  profileId: z.string().min(1).max(64),
  speed: z.number().min(0.5).max(2).optional(),
});

// Cloned-voice synthesis — same response shape as /synthesize (MP3 base64 +
// word timings), same quota accounting.
router.post("/clone", cloneAccess, usageLimiter, validate({ body: cloneSchema }), async (req, res, next) => {
  try {
    assertConfigured();
    const { text, profileId, speed } = req.body as z.infer<typeof cloneSchema>;

    // Plans and the monthly character quota belong to signed-in accounts. The
    // desktop app's local profile runs the model on its own PC: no quota.
    let quota: Awaited<ReturnType<typeof getQuotaFor>> | null = null;
    if (req.user) {
      assertClonePlan(req.user);
      quota = await getQuotaFor(req.user.id);
      if (quota.used + text.length > quota.limit) {
        throw new ApiError(403, "QUOTA_EXCEEDED", "You've reached your monthly character limit. Upgrade to Pro for more.");
      }
    }

    const result = await synthesizeClone(cloneOwnerId(req), { text, profileId, speed });

    if (req.user && quota) {
      const store = await getStore();
      await store.addUsageLog({
        userId: req.user.id,
        characterCount: text.length,
        voiceId: `clone:${profileId}`,
        audioDurationSeconds: Math.max(1, Math.round(result.duration)),
        generatedAt: new Date().toISOString(),
      });
      await store.updateUser(req.user.id, {
        charactersUsedThisMonth: quota.used + text.length,
        totalAudioDurationSeconds: req.user.totalAudioDurationSeconds + Math.round(result.duration),
      });
    }

    res.json({
      audioBase64: result.audioBase64,
      mimeType: result.mimeType,
      duration: result.duration,
      wordTimings: result.wordTimings,
      voiceId: `clone:${profileId}`,
      used: quota ? quota.used + text.length : null,
      limit: quota ? quota.limit : null,
      resetDate: quota ? quota.resetDate : null,
    });
  } catch (e) {
    next(e);
  }
});

// Client-side usage reporting — kept for the offline fallback engine.
router.post("/usage", requireAuth, usageLimiter, validate({ body: usageSchema }), async (req, res, next) => {
  try {
    const { voiceId, characterCount, audioDurationSeconds } = req.body as z.infer<typeof usageSchema>;
    const store = await getStore();
    const quota = await getQuotaFor(req.user!.id);

    if (quota.used + characterCount > quota.limit) {
      return res.status(403).json({
        allowed: false,
        code: "QUOTA_EXCEEDED",
        used: quota.used,
        limit: quota.limit,
        resetDate: quota.resetDate,
      });
    }

    await store.addUsageLog({
      userId: req.user!.id,
      characterCount,
      voiceId,
      audioDurationSeconds,
      generatedAt: new Date().toISOString(),
    });
    const updated = await store.updateUser(req.user!.id, {
      charactersUsedThisMonth: quota.used + characterCount,
      totalAudioDurationSeconds: req.user!.totalAudioDurationSeconds + audioDurationSeconds,
    });
    res.json({ allowed: true, used: updated!.charactersUsedThisMonth, limit: quota.limit, resetDate: quota.resetDate });
  } catch (e) {
    next(e);
  }
});

export default router;
