import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { gmailSendPolicy, gmailSentLog, gmailService, GmailError, saveGmailSendPolicy, startGmailConnect } from "../lib/gmail.js";
import { cancelScheduledEmail, listScheduledEmails } from "../lib/emailSchedule.js";
import { localAppGuard } from "../middleware/localApp.js";
import { validate } from "../middleware/validate.js";

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

// ── How much the agent may send, and what it has sent ──────────────────────
// The switch the person flips in Settings → Email. Reading is always allowed;
// sending from chat is what this governs (a person pressing Send in a draft
// card is their own action and is not capped).
router.get("/policy", (_req, res) => {
  const status = gmailService.status();
  res.json({
    ...gmailSendPolicy(),
    sentToday: status.sending.sentToday,
    remaining: status.sending.remaining,
    connected: status.connected,
    scopes: status.scopes,
    sent: gmailSentLog(15),
  });
});

const policySchema = z.object({
  enabled: z.boolean().optional(),
  dailyLimit: z.number().int().min(1).max(200).optional(),
});
router.put("/policy", validate({ body: policySchema }), (req, res) => {
  const body = req.body as z.infer<typeof policySchema>;
  const policy = saveGmailSendPolicy(body);
  const status = gmailService.status();
  res.json({ ...policy, sentToday: status.sending.sentToday, remaining: status.sending.remaining, connected: status.connected, scopes: status.scopes, sent: gmailSentLog(15) });
});

// ── Email that waits for its moment ────────────────────────────────────────
// "Send this to Marko at 5 pm": written when asked, sent at the time with no
// further confirmation. The page shows exactly what is waiting, with the text,
// and can cancel any of it.
router.get("/scheduled", (_req, res) => {
  const { scheduled, history } = listScheduledEmails();
  res.json({ scheduled, history });
});

router.delete("/scheduled/:id", (req, res) => {
  const id = String(req.params.id ?? "").slice(0, 200);
  if (!id) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "A scheduled email id is required." } });
  const result = cancelScheduledEmail(id);
  if (!result.ok) return res.status(404).json({ error: { code: "NOT_SCHEDULED", message: result.error ?? "Nothing matched that." } });
  res.json({ ok: true, cancelled: result.cancelled });
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
