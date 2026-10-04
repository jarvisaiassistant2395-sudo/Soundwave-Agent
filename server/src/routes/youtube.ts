import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { optionalAuth } from "../middleware/auth.js";
import { extractOAuthClient, youtubeService, type YouTubeConfig } from "../lib/youtube.js";
import { config } from "../config.js";
import { ConnectError, startYouTubeConnect, YOUTUBE_SCOPES } from "../lib/youtubeOAuth.js";
import { notFromApp } from "../middleware/localApp.js";
import { channelFor, channelViews, removeChannel, setDefaultChannel, updateChannel } from "../lib/youtubeChannels.js";
import { planRequest, planStatus } from "../lib/publishPlan.js";
import { startShortJob } from "./agentShort.js";

const router = Router();

// GET /api/v1/youtube/status
router.get("/status", (_req, res) => {
  const cfg = youtubeService.getConfig();
  const client = youtubeService.client();
  const { connected, needsReconnect } = youtubeService.connectionState();
  res.json({
    connected,
    needsReconnect,
    configured: connected,
    // One-click: this build ships Soundwave's own Google app, so connecting is
    // a single button and the customer never sees Google Cloud. Without it the
    // panel shows the short "use your own client" path instead.
    oneClick: client?.source === "built-in",
    clientSource: client?.source ?? "none",
    channelTitle: connected ? cfg.channelTitle || null : null,
    channelId: connected ? cfg.channelId || null : null,
    autoPublish: cfg.autoPublish,
    defaultPrivacy: cfg.defaultPrivacy,
    defaultTags: cfg.defaultTags,
    titleSuffix: cfg.titleSuffix,
    hasClientId: !!cfg.clientId,
    hasClientSecret: !!cfg.clientSecret,
    hasRefreshToken: !!cfg.refreshToken,
  });
});

// ── Channels: several of them, each with its own sign-in and its own plan ───

// GET /api/v1/youtube/channels — connected channels + which one is the default.
router.get("/channels", (_req, res) => {
  const views = channelViews();
  res.json({
    channels: views,
    defaultId: views.find((c) => c.default)?.id ?? null,
    /** Saving needs the desktop app (sign-ins live on this PC). */
    canConnectAnother: Boolean(youtubeService.client()),
    plan: planStatus(),
  });
});

/** The channel view the app gets back after a change (never tokens). */
function channelsPayload() {
  const views = channelViews();
  return { channels: views, defaultId: views.find((c) => c.default)?.id ?? null, plan: planStatus() };
}

// PATCH /api/v1/youtube/channels/:id — name it, set what to publish there, its plan.
const channelPatchSchema = z.object({
  name: z.string().max(80).optional(),
  privacy: z.enum(["public", "unlisted", "private"]).optional(),
  autoPublish: z.boolean().optional(),
  plan: z
    .object({
      what: z.string().max(400).optional(),
      // Accept the old regular-Short value for compatibility, but reject the
      // retired self-recorded demo plan.
      kind: z.enum(["short"]).optional(),
      auto: z.boolean().optional(),
      everyDays: z.number().int().min(1).max(30).optional(),
      time: z.string().max(5).optional(),
    })
    .transform(({ kind: _kind, ...plan }) => plan)
    .optional(),
});

router.patch("/channels/:id", optionalAuth, validate({ body: channelPatchSchema }), (req, res) => {
  const updated = updateChannel(req.params.id!, req.body as z.infer<typeof channelPatchSchema>);
  if (!updated) return res.status(404).json({ error: { code: "NO_CHANNEL", message: "That channel isn't connected any more." } });
  res.json({ ok: true, ...channelsPayload() });
});

// POST /api/v1/youtube/channels/:id/default — where shorts go when none is named.
router.post("/channels/:id/default", optionalAuth, (req, res) => {
  if (!setDefaultChannel(req.params.id!)) {
    return res.status(404).json({ error: { code: "NO_CHANNEL", message: "That channel isn't connected any more." } });
  }
  res.json({ ok: true, ...channelsPayload() });
});

// DELETE /api/v1/youtube/channels/:id — forget this channel (its sign-in too).
router.delete("/channels/:id", optionalAuth, (req, res) => {
  if (!removeChannel(req.params.id!)) {
    return res.status(404).json({ error: { code: "NO_CHANNEL", message: "That channel isn't connected any more." } });
  }
  res.json({ ok: true, ...channelsPayload() });
});

// POST /api/v1/youtube/channels/:id/publish-plan — run this channel's plan now.
router.post("/channels/:id/publish-plan", optionalAuth, async (req, res, next) => {
  try {
    const channel = channelFor(req.params.id!);
    if (!channel) return res.status(404).json({ error: { code: "NO_CHANNEL", message: "That channel isn't connected any more." } });
    const request = planRequest(channel);
    const { jobId } = await startShortJob({ ...request, userId: req.user?.id ?? "agent-local" });
    res.json({ ok: true, jobId });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/youtube/config
const configSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  // The whole client_secret_….json (or the two values) pasted into one box —
  // the server picks the ID and secret out of it.
  clientJson: z.string().max(20_000).optional(),
  refreshToken: z.string().optional(),
  autoPublish: z.boolean().optional(),
  defaultPrivacy: z.enum(["public", "unlisted", "private"]).optional(),
  defaultTags: z.array(z.string()).optional(),
  titleSuffix: z.string().optional(),
});

router.post("/config", optionalAuth, validate({ body: configSchema }), (req, res) => {
  const { clientJson, ...updates } = req.body as Partial<YouTubeConfig> & { clientJson?: string };
  if (clientJson?.trim()) {
    const parsed = extractOAuthClient(clientJson);
    if (!parsed) {
      return res.status(400).json({
        error: {
          code: "BAD_CLIENT_JSON",
          message: "That doesn't look like an OAuth client. Paste the whole client_secret_….json file you downloaded, or the Client ID and the secret together.",
        },
      });
    }
    updates.clientId = parsed.clientId;
    updates.clientSecret = parsed.clientSecret;
  }
  const updated = youtubeService.saveConfig(updates);
  const client = youtubeService.client();
  const { connected, needsReconnect } = youtubeService.connectionState();
  const status = {
    connected,
    needsReconnect,
    configured: connected,
    oneClick: client?.source === "built-in",
    clientSource: client?.source ?? "none",
    channelTitle: connected ? updated.channelTitle ?? null : null,
    channelId: connected ? updated.channelId ?? null : null,
    autoPublish: updated.autoPublish,
    defaultPrivacy: updated.defaultPrivacy,
    defaultTags: updated.defaultTags,
    hasClientId: !!updated.clientId,
    hasClientSecret: !!updated.clientSecret,
    hasRefreshToken: !!updated.refreshToken,
  };
  res.json({ ok: true, ...status, status });
});

// POST /api/v1/youtube/test - Test credentials and update channel info
router.post("/test", async (_req, res) => {
  const result = await youtubeService.testConnection();
  res.json(result);
});

// POST /api/v1/youtube/upload - Manually upload a rendered short
const uploadSchema = z.object({
  jobId: z.string().optional(),
  videoUrl: z.string().optional(),
  title: z.string().min(1).max(100),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  privacy: z.enum(["public", "unlisted", "private"]).optional(),
});

router.post("/upload", optionalAuth, validate({ body: uploadSchema }), async (req, res) => {
  try {
    const { jobId, videoUrl, title, description, tags, privacy } = req.body;

    // Locate the physical MP4 video file
    let targetPath: string | null = null;

    if (jobId) {
      const candidates = [
        path.join(config.uploadsDir, "jobs", `${jobId}.mp4`),
        path.join(config.uploadsDir, `soundwave_short_${jobId}.mp4`),
        path.join(config.uploadsDir, `${jobId}.mp4`),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          targetPath = c;
          break;
        }
      }
    }

    if (!targetPath && videoUrl) {
      // e.g. /api/v1/export/jobs/<id>/download
      const idMatch = videoUrl.match(/jobs\/([a-zA-Z0-9_-]+)/);
      if (idMatch) {
        const id = idMatch[1];
        const candidates = [
          path.join(config.uploadsDir, "jobs", `${id}.mp4`),
          path.join(config.uploadsDir, `soundwave_short_${id}.mp4`),
          path.join(config.uploadsDir, `${id}.mp4`),
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) {
            targetPath = c;
            break;
          }
        }
      }
    }

    if (!targetPath) {
      // Find latest completed short video in uploads
      const files = fs.readdirSync(config.uploadsDir)
        .filter((f) => f.endsWith(".mp4") && f.startsWith("soundwave_short_"))
        .sort((a, b) => fs.statSync(path.join(config.uploadsDir, b)).mtimeMs - fs.statSync(path.join(config.uploadsDir, a)).mtimeMs);
      if (files.length > 0) {
        targetPath = path.join(config.uploadsDir, files[0]!);
      }
    }

    if (!targetPath || !fs.existsSync(targetPath)) {
      return res.status(404).json({ error: "Video file not found for upload. Please render a short first." });
    }

    const uploadResult = await youtubeService.uploadShort({
      videoPath: targetPath,
      title,
      description,
      tags,
      privacy,
    });

    res.json({
      ok: true,
      ...uploadResult,
    });
  } catch (err: any) {
    console.error("[YouTubeRoute] Upload error:", err);
    res.status(500).json({ error: err.message || "YouTube upload failed" });
  }
});

// POST /api/v1/youtube/connect — the Google sign-in address for "Connect YouTube account"
// (the app opens it in the browser; Google comes back to this server, see app.ts).
router.post("/connect", (req, res) => {
  const problem = notFromApp(req);
  if (problem) return res.status(403).json({ error: { code: "FORBIDDEN", message: problem } });
  try {
    const port = req.socket.localPort ?? config.port;
    res.json(startYouTubeConnect(port));
  } catch (err) {
    if (err instanceof ConnectError) return res.status(409).json({ error: { code: err.code, message: err.message } });
    throw err;
  }
});

// GET /api/v1/youtube/oauth-guide — the short version of the guide (the agent explains it in detail).
router.get("/oauth-guide", (_req, res) => {
  const oneClick = youtubeService.client()?.source === "built-in";
  res.json({
    mode: oneClick ? "one-click" : "own-client",
    headline: oneClick
      ? "Connecting takes one press: sign in with Google, allow Soundwave to upload, done. Nothing to set up in Google Cloud."
      : "This build doesn't include Soundwave's own Google app, so you connect with your own free OAuth client — three clicks in Google Cloud, two minutes once.",
    steps: oneClick
      ? [
          "1. Settings → YouTube & Shorts → Connect YouTube.",
          "2. Pick your Google account and allow Soundwave to upload videos (and read the channel's name).",
          "3. Close the tab that says “YouTube is connected” — Soundwave shows your channel name.",
        ]
      : [
          "1. Open the clients page with the account that owns your channel: console.cloud.google.com/auth/clients/create (Google walks you through creating a project and the consent screen the first time — accept the defaults).",
          "2. If it asks you to enable the API first: console.cloud.google.com/apis/library/youtube.googleapis.com → Enable. Then, on the consent screen, add your Gmail under Audience → Test users (or press “Publish app” to avoid re-linking every 7 days).",
          "3. Create client → Application type: Desktop app → Create → “Download JSON”.",
          "4. In Soundwave: paste that file's contents (or the Client ID and secret) into the one box and press Connect YouTube — the sign-in opens in your browser and comes straight back.",
        ],
    note: oneClick
      ? "Google then keeps the sign-in until you remove it (myaccount.google.com/permissions) or change the account. New, unaudited apps upload as Private until YouTube approves the app for public uploads."
      : "New Google Cloud projects upload as Private until YouTube's API audit approves them.",
    links: {
      createClient: "https://console.cloud.google.com/auth/clients/create",
      enableApi: "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
      removeAccess: "https://myaccount.google.com/permissions",
    },
    scope: YOUTUBE_SCOPES.join(" "),
    requiredScopes: YOUTUBE_SCOPES,
  });
});

export default router;
