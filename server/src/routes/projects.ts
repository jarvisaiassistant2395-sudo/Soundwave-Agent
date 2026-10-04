import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth, requirePlan } from "../middleware/auth.js";
import { ApiError } from "../middleware/error.js";
import { getStore } from "../lib/store.js";
import { PLANS } from "../lib/plans.js";

const router = Router();

const projectSchema = z.object({
  title: z.string().min(1).max(120),
  type: z.enum(["TTS", "SUBTITLE", "VIDEO"]),
  textContent: z.string().max(20_000),
  voiceId: z.string().min(1).max(64),
  voiceSettings: z.record(z.unknown()).default({}),
  characterCount: z.number().int().min(0).default(0),
  duration: z.number().nullable().default(null),
  subtitleData: z.unknown().nullable().default(null),
  subtitleStyle: z.unknown().nullable().default(null),
  videoBackgroundUrl: z.string().nullable().default(null),
  audioUrl: z.string().nullable().default(null),
  status: z.enum(["DRAFT", "PROCESSING", "COMPLETED", "FAILED"]).default("DRAFT"),
});

const subtitleSchema = z.object({
  subtitleData: z.unknown(),
  subtitleStyle: z.unknown(),
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const projects = await store.listProjects(req.user!.id);
    res.json({ projects });
  } catch (e) {
    next(e);
  }
});

router.post("/", requireAuth, requirePlan("PRO"), validate({ body: projectSchema }), async (req, res, next) => {
  try {
    const store = await getStore();
    const body = req.body as z.infer<typeof projectSchema>;
    if (PLANS[req.user!.plan].cloudSave === false) {
      throw new ApiError(403, "PLAN_REQUIRED", "Cloud project saving requires the Pro plan. Free projects are saved locally in your browser.");
    }
    const project = await store.createProject({
      userId: req.user!.id,
      title: body.title,
      type: body.type,
      textContent: body.textContent,
      voiceId: body.voiceId,
      voiceSettings: body.voiceSettings,
      characterCount: body.characterCount,
      subtitleData: body.subtitleData,
      subtitleStyle: body.subtitleStyle,
      videoBackgroundUrl: body.videoBackgroundUrl,
      audioUrl: body.audioUrl,
      exportedVideoUrl: null,
      duration: body.duration,
      status: body.status,
      storageType: "CLOUD",
    });
    res.status(201).json({ project });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const project = await store.getProject(req.params.id ?? "", req.user!.id);
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    res.json({ project });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireAuth, validate({ body: projectSchema.partial() }), async (req, res, next) => {
  try {
    const store = await getStore();
    const body = req.body as Partial<z.infer<typeof projectSchema>>;
    const project = await store.updateProject(req.params.id ?? "", req.user!.id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.textContent !== undefined ? { textContent: body.textContent } : {}),
      ...(body.voiceId !== undefined ? { voiceId: body.voiceId } : {}),
      ...(body.voiceSettings !== undefined ? { voiceSettings: body.voiceSettings } : {}),
      ...(body.duration !== undefined ? { duration: body.duration } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    res.json({ project });
  } catch (e) {
    next(e);
  }
});

router.put("/:id/subtitles", requireAuth, validate({ body: subtitleSchema }), async (req, res, next) => {
  try {
    const store = await getStore();
    const { subtitleData, subtitleStyle } = req.body as z.infer<typeof subtitleSchema>;
    const project = await store.updateProject(req.params.id ?? "", req.user!.id, {
      subtitleData: subtitleData as never,
      subtitleStyle: subtitleStyle as never,
    });
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    res.json({ project });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    await store.deleteProject(req.params.id ?? "", req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/duplicate", requireAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const original = await store.getProject(req.params.id ?? "", req.user!.id);
    if (!original) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    const copy = await store.createProject({
      userId: req.user!.id,
      title: `${original.title} (copy)`,
      type: original.type,
      textContent: original.textContent,
      voiceId: original.voiceId,
      voiceSettings: original.voiceSettings,
      characterCount: original.characterCount,
      subtitleData: original.subtitleData,
      subtitleStyle: original.subtitleStyle,
      videoBackgroundUrl: original.videoBackgroundUrl,
      audioUrl: original.audioUrl,
      exportedVideoUrl: original.exportedVideoUrl,
      duration: original.duration,
      status: "DRAFT",
      storageType: original.storageType,
    });
    res.status(201).json({ project: copy });
  } catch (e) {
    next(e);
  }
});

export default router;
