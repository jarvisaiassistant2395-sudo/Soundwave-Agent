// ── Cut Shorts out of a long video (the same job the agent's tool starts) ───
// make_shorts_from_video is how the agent does it in chat; this is how the
// person does it from the Command Center without typing a sentence. It starts
// exactly the same job (lib/videoClips.ts) — clips posted into the conversation
// as they finish — so there is no second, lesser path that could quietly behave
// differently.
//
// One video renders at a time, but a second one is *queued* rather than
// refused: the card answers with where in the queue it landed. 409 comes back
// only when the queue itself is full.
//
// Desktop only: downloading a video, listening to it and rendering clips needs
// this PC's ffmpeg, yt-dlp and speech engine.

import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { optionalAuth } from "../middleware/auth.js";
import { clipsBusy, clipsQueueView, startClipsJob } from "../lib/videoClips.js";
import { DEFAULT_CLIPS, MAX_CLIPS } from "../lib/brain/core/clips.js";
import { MAX_WAITING } from "../lib/brain/core/clipQueue.js";
import { config } from "../config.js";

export const clipsRoutes = Router();

const startSchema = z.object({
  /** A YouTube link, or the full path of a video file on this PC. */
  video: z.string().trim().min(3).max(800),
  count: z.number().int().min(1).max(MAX_CLIPS).optional(),
  focus: z.string().trim().max(300).optional(),
  resolution: z.enum(["720p", "1080p"]).optional(),
});

/** What's being cut right now, and what's waiting (the card in the UI polls this). */
clipsRoutes.get("/", (_req, res) => {
  const view = clipsQueueView();
  res.json({
    available: config.desktopApp,
    busy: view.busy,
    source: view.source,
    /** Videos waiting their turn behind the one rendering. */
    queued: view.queued,
    waitingFor: view.waitingFor,
    maxQueued: MAX_WAITING,
    defaultCount: DEFAULT_CLIPS,
    maxCount: MAX_CLIPS,
  });
});

clipsRoutes.post("/", optionalAuth, validate({ body: startSchema }), async (req, res) => {
  const body = req.body as z.infer<typeof startSchema>;
  try {
    const started = await startClipsJob({
      video: body.video,
      count: body.count ?? DEFAULT_CLIPS,
      ...(body.focus ? { focus: body.focus } : {}),
      ...(body.resolution ? { resolution: body.resolution } : {}),
      userId: req.user?.id ?? "agent-local",
    });
    res.json({
      ok: true,
      video: started.sourceName,
      count: started.count,
      jobIds: started.jobIds,
      queued: started.queued,
      position: started.position,
      message: started.queued
        ? `“${started.sourceName}” is queued behind ${started.position === 1 ? "the video being cut now" : `${started.position} videos`} — one renders at a time. It starts by itself, and the clips appear in the chat.`
        : `Listening to “${started.sourceName}” — cutting ${started.count} short${started.count === 1 ? "" : "s"}. They appear in the chat as they finish.`,
    });
  } catch (err) {
    const busy = clipsBusy();
    // 409 when the renderer is the reason (the queue is full); 400 when the
    // video itself is wrong — the card shows those two differently.
    res.status(busy.busy ? 409 : 400).json({
      ok: false,
      busy: busy.busy,
      source: busy.source ?? null,
      queued: busy.queued ?? 0,
      error: (err as Error).message || "That video didn't work out.",
    });
  }
});
