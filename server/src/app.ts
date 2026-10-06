import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";
import { generalLimiter, securityHeaders } from "./lib/security.js";
import { connectPage, finishYouTubeConnect, isYouTubeCallback } from "./lib/youtubeOAuth.js";
import { finishGmailConnect, gmailConnectPage, isGmailCallback } from "./lib/gmail.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import authRoutes from "./routes/auth.js";
import voiceRoutes from "./routes/voices.js";
import ttsRoutes from "./routes/tts.js";
import projectRoutes from "./routes/projects.js";
import uploadRoutes from "./routes/upload.js";
import exportRoutes from "./routes/export.js";
import userRoutes from "./routes/user.js";
import billingRoutes from "./routes/billing.js";
import apiKeyRoutes from "./routes/apiKeys.js";
import agentRoutes from "./routes/agent.js";
import jarvisRoutes from "./routes/jarvis.js";
import jarvisShortRoutes from "./routes/jarvisShort.js";
import creatorRoutes from "./routes/creator.js";
import geminiRoutes from "./routes/gemini.js";
import ghostRoutes from "./routes/ghost.js";
import youtubeRoutes from "./routes/youtube.js";
import postRoutes from "./routes/posts.js";
import brandRoutes from "./routes/brand.js";
import emailRoutes from "./routes/email.js";
import { clipsRoutes } from "./routes/clips.js";
import { watchRoutes } from "./routes/watch.js";
import companionRoutes from "./routes/companion.js";
import brainRoutes from "./routes/brain.js";
import memoryRoutes from "./routes/memory.js";
import morningRoutes from "./routes/morning.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // CORS — restrict to configured origins in production; permissive in dev.
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (!config.isProd) return cb(null, true);
        if (config.corsOrigins.length === 0 || config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(new Error("Not allowed by CORS"));
      },
      credentials: true,
    }),
  );

  app.use(securityHeaders);

  // Desktop Google sign-ins come back to http://127.0.0.1:<port>/?code=…&state=… .
  app.get("/", (req, res, next) => {
    const query = req.query as Record<string, unknown>;
    if (isGmailCallback(query)) {
      finishGmailConnect(query)
        .then((result) => {
          res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
          res.status(result.ok ? 200 : 400).type("html").send(gmailConnectPage(result));
        })
        .catch(next);
      return;
    }
    if (!isYouTubeCallback(query)) return next();
    finishYouTubeConnect(query)
      .then((result) => {
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
        res.status(result.ok ? 200 : 400).type("html").send(connectPage(result));
      })
      .catch(next);
  });
  // Stripe signs the exact bytes it sends, so its webhook needs the raw body —
  // registered before the JSON parser, which would consume it.
  app.use("/api/v1/billing/webhook", express.raw({ type: "application/json", limit: "1mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use("/api/v1", generalLimiter);

  // Health.
  app.get("/api/health", (_req, res) => res.json({ ok: true, service: "soundwave-ai", time: new Date().toISOString() }));

  // API routes.
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/voices", voiceRoutes);
  app.use("/api/v1/tts", ttsRoutes);
  app.use("/api/v1/projects", projectRoutes);
  app.use("/api/v1/upload", uploadRoutes);
  app.use("/api/v1/export", exportRoutes);
  app.use("/api/v1/user", userRoutes);
  app.use("/api/v1/billing", billingRoutes);
  app.use("/api/v1/api-keys", apiKeyRoutes);

  // Soundwave Agent & Automation routes (with backward compatibility for jarvis)
  app.use("/api/v1/agent", agentRoutes);
  app.use("/api/v1/automation", agentRoutes);
  app.use("/api/v1/jarvis", jarvisShortRoutes);
  app.use("/api/v1/jarvis", jarvisRoutes);
  app.use("/api/v1/creator", creatorRoutes);
  app.use("/api/v1/ghost", ghostRoutes);
  app.use("/api/v1/youtube", youtubeRoutes);
  app.use("/api/v1/posts", postRoutes);
  app.use("/api/v1/brand", brandRoutes);
  app.use("/api/v1/email", emailRoutes);
  // Cutting Shorts out of a long video, started from the Command Center or the
  // agent's make_shorts_from_video tool — the same job either way.
  app.use("/api/v1/clips", clipsRoutes);
  // Watching channels (watch a creator → clip every new video), from the card
  // in the Command Center — the same store and queue as the agent's tool.
  app.use("/api/v1/watch", watchRoutes);
  // Phone companion: Settings → Phone + the conversation the phone shares (desktop app only).
  app.use("/api/v1/companion", companionRoutes);
  // The agent's brain (Gemini): status + Settings → Brain.
  app.use("/api/v1/brain", brainRoutes);
  // The file-chat tab: drop in a file, talk to Gemini (chats, notebooks, files).
  app.use("/api/v1/gemini", geminiRoutes);
  app.use("/api/v1/memory", memoryRoutes);
  app.use("/api/v1/morning", morningRoutes);

  // Static voice sample clips (pre-generated, committed to the repo).
  const samplesDir = path.join(process.cwd(), "..", "frontend", "public", "voice-samples");
  if (fs.existsSync(samplesDir)) {
    app.use("/voice-samples", express.static(samplesDir, { maxAge: "7d", immutable: true }));
  }

  // Packaged/desktop mode: serve the built SPA from this same origin (WEB_DIST).
  // Hashed assets are immutable; index.html is the history fallback and never
  // shadows /api (API 404s keep returning JSON from the notFound handler).
  if (config.webDist && fs.existsSync(config.webDist)) {
    app.use(
      express.static(config.webDist, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.resolve(config.webDist, "index.html"));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
