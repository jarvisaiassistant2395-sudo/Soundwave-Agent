// ── Phone companion: what the desktop app itself uses ───────────────────────
//   GET    /api/v1/companion              status for Settings → Phone
//   POST   /api/v1/companion/enabled      { enabled } — open/close the LAN listener
//   POST   /api/v1/companion/share-brain  { enabled } — phones may chat while the PC is off
//   POST   /api/v1/companion/pairing      show a new one-time pairing code (QR)
//   DELETE /api/v1/companion/pairing      stop pairing
//   DELETE /api/v1/companion/devices/:id  forget a phone
//   GET    /api/v1/companion/conversation?epoch=&rev=&wait=1   the shared conversation
//   POST   /api/v1/companion/conversation { messages, voice }  merge the window's copy
//   POST   /api/v1/companion/conversation/clear { messages }   "Clear": start over everywhere
//
// Only for the app's own window: 404 unless the desktop shell enabled the
// feature (COMPANION=1), and refused for other sites (Origin) and for DNS
// rebinding (Host must be loopback when the API only listens on loopback).
// The phone never reaches these — it talks to lib/companion/listener.ts.

import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { ApiError } from "../middleware/error.js";
import { localAppGuard } from "../middleware/localApp.js";
import { validate } from "../middleware/validate.js";
import { getConversation, mergeUntrusted, resetConversation, setConversationVoice, waitForChange } from "../lib/conversation.js";
import { sanitizeMessages } from "../lib/chatMessages.js";
import { cancelPairing, removeDevice, setShareBrainFlag, startPairing } from "../lib/companion/service.js";
import { companionStatus, listenerState, setCompanionEnabled, startListener } from "../lib/companion/listener.js";

const router = Router();

export const localAppOnly = localAppGuard(() => config.companionAvailable, "The phone companion is only available in the desktop app.");

router.use(localAppOnly);

router.get("/", (_req, res) => {
  res.json(companionStatus());
});

router.post("/enabled", validate({ body: z.object({ enabled: z.boolean() }) }), async (req, res, next) => {
  try {
    res.json(await setCompanionEnabled((req.body as { enabled: boolean }).enabled));
  } catch (e) {
    next(e);
  }
});

router.post("/share-brain", validate({ body: z.object({ enabled: z.boolean() }) }), (req, res) => {
  setShareBrainFlag((req.body as { enabled: boolean }).enabled);
  res.json(companionStatus());
});

router.post("/pairing", async (_req, res, next) => {
  try {
    const status = companionStatus();
    if (!status.enabled) throw new ApiError(409, "COMPANION_OFF", "Turn on “Let my phone connect” first.");
    if (!listenerState().listening) await startListener();
    if (!listenerState().listening) throw new ApiError(503, "LISTENER_FAILED", listenerState().error ?? "The phone connection couldn't start.");
    startPairing();
    res.json(companionStatus());
  } catch (e) {
    next(e);
  }
});

router.delete("/pairing", (_req, res) => {
  cancelPairing();
  res.json(companionStatus());
});

router.delete("/devices/:id", (req, res) => {
  removeDevice(req.params.id ?? "");
  res.json(companionStatus());
});

// ── The shared conversation (Command Center ⇄ phone) ────────────────────────

router.get("/conversation", async (req, res, next) => {
  try {
    const epoch = typeof req.query.epoch === "string" ? req.query.epoch : "";
    const rev = Number.parseInt(String(req.query.rev ?? ""), 10);
    let snap = getConversation();
    if (req.query.wait === "1" && snap.epoch === epoch && snap.rev === rev) {
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      await waitForChange(snap.rev, 25_000, controller.signal);
      if (controller.signal.aborted) return;
      snap = getConversation();
    }
    res.json(snap);
  } catch (e) {
    next(e);
  }
});

const pushSchema = z.object({
  messages: z.array(z.unknown()).max(200),
  voice: z.string().max(100).optional(),
});

router.post("/conversation", validate({ body: pushSchema }), (req, res) => {
  const body = req.body as z.infer<typeof pushSchema>;
  if (body.voice && /^[a-z]{2,3}-[A-Z]{2,3}-[A-Za-z]+Neural$/.test(body.voice)) setConversationVoice(body.voice);
  const { changed: _changed, ...snap } = mergeUntrusted(body.messages);
  res.json(snap);
});

router.post("/conversation/clear", validate({ body: z.object({ messages: z.array(z.unknown()).max(20).default([]) }) }), (req, res) => {
  res.json(resetConversation(sanitizeMessages((req.body as { messages: unknown[] }).messages)));
});

export default router;
