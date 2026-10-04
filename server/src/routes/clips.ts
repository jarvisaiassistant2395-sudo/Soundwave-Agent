// ── Cut Shorts out of a long video (the same job the agent's tool starts) ───
// make_shorts_from_video is how the agent does it in chat; this is how the
// person does it from the Command Center without typing a sentence. It starts
// exactly the same job (lib/videoClips.ts) — one video at a time, clips posted
// into the conversation as they finish — so there is no second, lesser path
// that could quietly behave differently.
//
// Desktop only: downloading a video, listening to it and rendering clips needs
// this PC's ffmpeg, yt-dlp and speech engine.

import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { optionalAuth } from "../middleware/auth.js";
import { clipsBusy, startClipsJob } from "../lib/videoClips.js";
import { DEFAULT_CLIPS, MAX_CLIPS } from "../lib/brain/core/clips.js";
import { config } from "../config.js";

export const clipsRoutes = Router();

const startSchema = z.object({
  /** A YouTube link, or the full path of a video file on this PC. */
  video: z.string().trim().min(3).max(800),
  count: z.number().int().min(1).max(MAX_CLIPS).optional(),
  focus: z.string().trim().max(300).optional(),
  resolution: z.enum(["720p", "1080p"]).optional(),
});

/** What's being cut right now (the card in the UI polls this). */
clipsRoutes.get("/", (_req, res) => {
  const busy = clipsBusy();
  res.json({
    available: config.desktopApp,
    busy: busy.busy,
    source: busy.source ?? null,
    defaultCount: DEFAULT_CLIPS,
    maxCount: MAX_CLIPS,
  });
});

clipsRoutes.post("/", optionalAuth, validate({ body: startSchema }), async (req, res) => {
  const body = req.body as z.infer<typeof startSchema>;
  const busy = clipsBusy();
  if (busy.busy) {
    res.status(409).json({
      ok: false,
      busy: true,
      source: busy.source ?? null,
      error: `Already cutting shorts out of “${busy.source ?? "a video"}” — one video at a time. They'll appear in the chat.`,
    });
    return;
  }
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
      message: `Listening to “${started.sourceName}” — cutting ${started.count} short${started.count === 1 ? "" : "s"}. They appear in the chat as they finish.`,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message || "That video didn't work out." });
  }
});
