// ── Watching YouTube channels, from the UI ──────────────────────────────────
// watch_youtube_channel is how the agent starts one in chat; this is the same
// thing from the card in the Command Center (add a channel, change what it cuts,
// clip the newest one now, stop watching) so the feature can be *seen* without
// remembering a sentence. Every action goes through lib/channelWatch.ts — the
// tool's store, timer and queue — so there is no second path that could behave
// differently.
//
// Desktop only: reading a channel's videos needs this PC's yt-dlp. On a hosted
// server the card hides itself (available: false).

import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { optionalAuth } from "../middleware/auth.js";
import {
  addWatch,
  clipLatestNow,
  kickChannelWatch,
  updateWatchById,
  removeWatchById,
  watchViews,
} from "../lib/channelWatch.js";
import { clipsBusy } from "../lib/videoClips.js";
import { CHECK_INTERVAL_MS, DEFAULT_WATCH_CLIPS, MAX_WATCH_CLIPS, MAX_WATCHES } from "../lib/brain/core/watch.js";
import { config } from "../config.js";

export const watchRoutes = Router();

/** The whole card in one answer: the limit, the cadence, and every watch. */
function card() {
  const busy = clipsBusy();
  return {
    available: config.desktopApp,
    max: MAX_WATCHES,
    maxClips: MAX_WATCH_CLIPS,
    defaultClips: DEFAULT_WATCH_CLIPS,
    checkEveryMinutes: Math.round(CHECK_INTERVAL_MS / 60_000),
    busy: busy.busy,
    busySource: busy.source ?? null,
    watches: watchViews(),
  };
}

const channelSchema = z.object({
  channel: z.string().trim().min(2).max(300),
  clips: z.number().int().min(1).max(MAX_WATCH_CLIPS).optional(),
  focus: z.string().trim().max(300).optional(),
  latest: z.boolean().optional(),
});

const patchSchema = z.object({
  clips: z.number().int().min(1).max(MAX_WATCH_CLIPS).optional(),
  focus: z.string().trim().max(300).nullable().optional(),
});

watchRoutes.get("/", (_req, res) => {
  res.json(card());
});

/** Add a channel by its @handle or link (or update the one already watched). */
watchRoutes.post("/", optionalAuth, validate({ body: channelSchema }), async (req, res) => {
  if (!config.desktopApp) {
    res.status(503).json({ ok: false, error: "Watching channels needs the Soundwave desktop app — that's where the video reader (yt-dlp) lives." });
    return;
  }
  const body = req.body as z.infer<typeof channelSchema>;
  try {
    const watch = await addWatch({
      channel: body.channel,
      ...(body.clips !== undefined ? { clips: body.clips } : {}),
      ...(body.focus ? { focus: body.focus } : {}),
      ...(body.latest === true ? { latest: true } : {}),
      userId: req.user?.id ?? "agent-local",
    });
    const name = watch.channelName || watch.input;
    res.json({
      ok: true,
      message: `Watching ${name} — ${watch.clips} short${watch.clips === 1 ? "" : "s"} out of every new video${body.latest ? ", starting with the newest one now" : ""}.`,
      ...card(),
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message || "I couldn't watch that channel." });
  }
});

/** Change one watch: how many shorts per video, and what to look for. */
watchRoutes.patch("/:id", validate({ body: patchSchema }), (req, res) => {
  const body = req.body as z.infer<typeof patchSchema>;
  const watch = updateWatchById(req.params.id!, {
    ...(body.clips !== undefined ? { clips: body.clips } : {}),
    ...(body.focus !== undefined ? { focus: body.focus } : {}),
  });
  if (!watch) {
    res.status(404).json({ ok: false, error: "That channel isn't being watched any more." });
    return;
  }
  res.json({ ok: true, ...card() });
});

/** "Cut the newest one now" — ahead of the next scheduled check. */
watchRoutes.post("/:id/latest", async (req, res) => {
  const r = await clipLatestNow(req.params.id!);
  if (!r.ok) {
    res.status(400).json({ ok: false, error: r.reason ?? "That didn't work.", ...card() });
    return;
  }
  res.json({
    ok: true,
    message: r.started
      ? `Cutting shorts out of “${r.title}” now — they'll appear in the chat.`
      : `“${r.title}” is next in line — something is already rendering, so it starts the moment that's done.`,
    started: Boolean(r.started),
    ...card(),
  });
});

/** Stop watching one channel. */
watchRoutes.delete("/:id", (req, res) => {
  const removed = removeWatchById(req.params.id!);
  if (!removed) {
    res.status(404).json({ ok: false, error: "That channel isn't being watched any more." });
    return;
  }
  kickChannelWatch();
  res.json({ ok: true, ...card() });
});
