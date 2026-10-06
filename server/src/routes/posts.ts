// ── Posts: what is waiting to go up, and how the last ones did ───────────────
// The chat and the agent both go through here. Nothing is posted by a route —
// routes schedule, cancel and report; the posting itself happens on the
// scheduler's clock (lib/postSchedule.ts), so a clip posted at 9am goes up even
// if this window was closed.

import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { optionalAuth } from "../middleware/auth.js";
import {
  PostError,
  cancelScheduledPost,
  listScheduledPosts,
  performanceSummary,
  postDuePosts,
  postableChannels,
  refreshPostedStats,
  schedulePost,
} from "../lib/postSchedule.js";

const router = Router();

// GET /api/v1/posts — what is waiting, what happened, and where it could go.
router.get("/", optionalAuth, (_req, res) => {
  const { scheduled, history } = listScheduledPosts();
  res.json({
    scheduled,
    history,
    channels: postableChannels(),
    summary: performanceSummary(),
  });
});

const scheduleSchema = z.object({
  jobId: z.string().max(200).optional(),
  videoPath: z.string().max(1000).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  privacy: z.enum(["public", "unlisted", "private"]).optional(),
  when: z.string().max(120).optional(),
  now: z.boolean().optional(),
  channelId: z.string().max(80).optional(),
});

// POST /api/v1/posts — "post this at nine" (or now).
router.post("/", optionalAuth, validate({ body: scheduleSchema }), (req, res, next) => {
  try {
    const post = schedulePost(req.body);
    res.status(201).json({ ok: true, post });
  } catch (err) {
    if (err instanceof PostError) return res.status(422).json({ error: { code: err.code, message: err.message } });
    next(err);
  }
});

// DELETE /api/v1/posts/:id — cancel a waiting post (or answer which ones exist).
router.delete("/:id", optionalAuth, (req, res) => {
  const result = cancelScheduledPost(req.params.id ?? "");
  if (!result.ok) return res.status(404).json({ error: { code: "NOT_FOUND", message: result.error ?? "Nothing matched that." } });
  res.json({ ok: true, cancelled: result.cancelled });
});

// POST /api/v1/posts/due — post anything whose moment has come, right now.
// The desktop app does this on its own clock; this exists so "post it now" and
// the tests don't have to wait twenty seconds for the next tick.
router.post("/due", optionalAuth, async (_req, res, next) => {
  try {
    const result = await postDuePosts();
    res.json({
      ok: true,
      posted: result.posted.map((p) => ({ id: p.id, title: p.title, youtubeUrl: p.youtubeUrl })),
      failed: result.failed.map((p) => ({ id: p.id, title: p.title, error: p.error })),
      missed: result.missed.map((p) => ({ id: p.id, title: p.title, error: p.error })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/posts/stats — pull the numbers back from YouTube.
router.post("/stats", optionalAuth, async (_req, res, next) => {
  try {
    const updated = await refreshPostedStats();
    res.json({ ok: true, updated, summary: performanceSummary() });
  } catch (err) {
    next(err);
  }
});

export default router;
