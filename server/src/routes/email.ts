import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { gmailService, GmailError, startGmailConnect } from "../lib/gmail.js";
import { localAppGuard } from "../middleware/localApp.js";

const router = Router();
router.use(localAppGuard(() => config.desktopApp, "Gmail access is available only in the Soundwave desktop app."));

function sendGmailError(err: unknown, res: import("express").Response): void {
  if (err instanceof GmailError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  const message = (err as Error)?.message || "Gmail request failed.";
  res.status(502).json({ error: { code: "GMAIL_ERROR", message } });
}

router.get("/status", (_req, res) => {
  res.json(gmailService.status());
});

router.post("/connect", (req, res) => {
  try {
    const port = req.socket.localPort ?? config.port;
    res.json(startGmailConnect(port));
  } catch (err) {
    if (err instanceof GmailError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    throw err;
  }
});

router.post("/disconnect", (_req, res) => {
  gmailService.disconnect();
  res.json({ ok: true });
});

const inboxQuery = z.object({
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});
router.get("/messages", async (req, res) => {
  const parsed = inboxQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid inbox query." } });
  try {
    const messages = await gmailService.listInbox(parsed.data.q, parsed.data.limit);
    res.json({ messages });
  } catch (err) {
    sendGmailError(err, res);
  }
});

router.get("/messages/:id", async (req, res) => {
  const id = String(req.params.id ?? "").slice(0, 500);
  if (!id) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "An email id is required." } });
  try {
    res.json({ message: await gmailService.readMessage(id) });
  } catch (err) {
    sendGmailError(err, res);
  }
});

router.get("/drafts/:id", async (req, res) => {
  const id = String(req.params.id ?? "").slice(0, 500);
  if (!id) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "A draft id is required." } });
  try {
    res.json({ draft: await gmailService.getDraft(id) });
  } catch (err) {
    sendGmailError(err, res);
  }
});

// This endpoint is not available to Gemini or any agent tool. The desktop UI
// sends this exact acknowledgement only after the user reviews the recipient,
// subject and body in a confirmation dialog.
const sendSchema = z.object({
  confirmSend: z.literal(true),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
router.post("/drafts/:id/send", async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(403).json({ error: { code: "SEND_CONFIRMATION_REQUIRED", message: "Review the draft and explicitly confirm before sending." } });
  const id = String(req.params.id ?? "").slice(0, 500);
  if (!id) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "A draft id is required." } });
  try {
    const sent = await gmailService.sendDraft(id, parsed.data.fingerprint);
    res.json({ ok: true, ...sent });
  } catch (err) {
    sendGmailError(err, res);
  }
});

export default router;
