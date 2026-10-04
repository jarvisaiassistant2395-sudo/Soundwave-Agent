import { Router } from "express";
import { VOICES, getVoice } from "../lib/voices.js";
import { getLocalVoiceStatus } from "../lib/kokoro.js";
import { ApiError } from "../middleware/error.js";

const router = Router();

// Voice metadata list (NOT model weights). Microsoft's voices are the default;
// `local` describes the optional on-this-PC engine, whose voices are real model
// voices enumerated from the service itself rather than hard-coded here.
// Never fails: a local service that isn't running is reported as unavailable.
router.get("/", async (_req, res) => {
  const local = await getLocalVoiceStatus();
  res.json({ voices: VOICES, local });
});

router.get("/:voiceId/sample", (req, res, next) => {
  const voice = getVoice(req.params.voiceId ?? "");
  if (!voice) return next(new ApiError(404, "NOT_FOUND", "Voice not found."));
  res.json({ voiceId: voice.id, url: voice.sampleUrl });
});

export default router;
