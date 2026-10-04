/**
 * Soundwave AI — Creator Mode Router
 * Screen Recording, Silence Removal, Jump Cutting & Screen Studio Auto-Framing/Zoom API.
 */

import { Router } from "express";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { optionalAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ApiError } from "../middleware/error.js";
import { getStore } from "../lib/store.js";
import { filePath } from "./upload.js";
import { config } from "../config.js";
import {
  detectSilenceIntervals,
  autoEditVideo,
  type SilenceDetectOptions,
  type FramingOptions,
  type SpeechInterval,
} from "../lib/silenceRemover.js";

const router = Router();
const creatorEvents = new EventEmitter();

function emitCreatorJob(jobId: string, payload: Record<string, unknown>) {
  creatorEvents.emit(`job:${jobId}`, payload);
}

// ── 1. POST /analyze-silence ────────────────────────────────────────────────
const analyzeSchema = z.object({
  fileKey: z.string().min(1).max(250),
  noiseThresholdDb: z.number().min(-60).max(-10).optional().default(-30),
  minSilenceDuration: z.number().min(0.1).max(5).optional().default(0.4),
  paddingSec: z.number().min(0.0).max(1.0).optional().default(0.15),
});

router.post(
  "/analyze-silence",
  optionalAuth,
  validate({ body: analyzeSchema }),
  async (req, res, next) => {
    try {
      const { fileKey, noiseThresholdDb, minSilenceDuration, paddingSec } =
        req.body as z.infer<typeof analyzeSchema>;

      const inputPath = filePath(fileKey);
      if (!fs.existsSync(inputPath)) {
        throw new ApiError(404, "FILE_NOT_FOUND", "The target video file does not exist.");
      }

      const analysis = await detectSilenceIntervals(inputPath, {
        noiseThresholdDb,
        minSilenceDuration,
        paddingSec,
      });

      res.json({
        success: true,
        analysis,
      });
    } catch (e) {
      next(e);
    }
  }
);

// ── 2. POST /auto-edit ──────────────────────────────────────────────────────
const autoEditSchema = z.object({
  fileKey: z.string().min(1).max(250),
  speechIntervals: z
    .array(
      z.object({
        start: z.number().min(0),
        end: z.number().min(0),
        duration: z.number().min(0),
      })
    )
    .optional(),
  silenceOptions: z
    .object({
      noiseThresholdDb: z.number().min(-60).max(-10).optional(),
      minSilenceDuration: z.number().min(0.1).max(5).optional(),
      paddingSec: z.number().min(0).max(1.0).optional(),
    })
    .optional(),
  framing: z
    .object({
      aspect: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9"),
      zoomFactor: z.number().min(1.0).max(2.0).optional().default(1.0),
      backdrop: z
        .enum(["gradient_cyber", "gradient_purple", "midnight", "none"])
        .optional()
        .default("gradient_cyber"),
      paddingPercent: z.number().min(0).max(20).optional().default(6),
      focusRegion: z
        .enum(["center", "top_left", "top_right", "bottom_left", "bottom_right"])
        .optional()
        .default("center"),
      quality: z.enum(["fast", "high"]).optional().default("fast"),
    })
    .optional(),
  async: z.boolean().optional().default(true),
});

router.post(
  "/auto-edit",
  optionalAuth,
  validate({ body: autoEditSchema }),
  async (req, res, next) => {
    try {
      const { fileKey, speechIntervals, silenceOptions, framing, async: isAsync } =
        req.body as z.infer<typeof autoEditSchema>;

      const inputPath = filePath(fileKey);
      if (!fs.existsSync(inputPath)) {
        throw new ApiError(404, "FILE_NOT_FOUND", "Target video file not found.");
      }

      const store = await getStore();
      const userId = req.user?.id || "creator-local";

      const job = await store.createJob({
        projectId: "creator-screen",
        userId,
        status: "PROCESSING",
        progress: 5,
        settings: {
          fileKey,
          framing,
          silenceOptions,
          format: "mp4",
        },
        outputUrl: null,
        errorMessage: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      });

      const outputDir = path.join(config.uploadsDir, "jobs");
      fs.mkdirSync(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${job.id}.mp4`);

      const runProcessing = async () => {
        try {
          emitCreatorJob(job.id, { status: "PROCESSING", progress: 5 });

          await autoEditVideo({
            inputPath,
            outputPath,
            speechIntervals: speechIntervals as SpeechInterval[] | undefined,
            silenceOptions: silenceOptions as SilenceDetectOptions | undefined,
            framing: framing as FramingOptions | undefined,
            onProgress: (pct) => {
              void store.updateJob(job.id, { progress: pct });
              emitCreatorJob(job.id, { status: "PROCESSING", progress: pct });
            },
          });

          const outputUrl = `/api/v1/creator/jobs/${job.id}/download`;
          await store.updateJob(job.id, {
            status: "COMPLETED",
            progress: 100,
            outputUrl,
            completedAt: new Date().toISOString(),
          });
          emitCreatorJob(job.id, { status: "COMPLETED", progress: 100, outputUrl });
        } catch (e: any) {
          const errMessage = e?.message || "Auto-editing process failed";
          await store.updateJob(job.id, {
            status: "FAILED",
            errorMessage: errMessage.slice(0, 400),
            completedAt: new Date().toISOString(),
          });
          emitCreatorJob(job.id, { status: "FAILED", error: errMessage.slice(0, 400) });
        }
      };

      if (isAsync) {
        void runProcessing();
        res.status(202).json({
          jobId: job.id,
          status: "PROCESSING",
          progress: 5,
          pollUrl: `/api/v1/creator/jobs/${job.id}`,
        });
      } else {
        await runProcessing();
        const updated = await store.getJobById(job.id);
        res.json({
          jobId: job.id,
          status: updated?.status || "COMPLETED",
          progress: 100,
          downloadUrl: `/api/v1/creator/jobs/${job.id}/download`,
        });
      }
    } catch (e) {
      next(e);
    }
  }
);

// ── 3. GET /jobs/:jobId ─────────────────────────────────────────────────────
router.get("/jobs/:jobId", optionalAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const jobId = req.params.jobId ?? "";

    let job = await store.getJobById(jobId);
    if (!job) {
      job = await store.getJob(jobId, req.user?.id || "creator-local");
    }
    if (!job) {
      throw new ApiError(404, "NOT_FOUND", "Creator job not found.");
    }

    res.json({
      id: job.id,
      status: job.status,
      progress: job.progress,
      outputUrl: job.outputUrl,
      error: job.errorMessage,
      downloadUrl:
        job.status === "COMPLETED" ? `/api/v1/creator/jobs/${job.id}/download` : undefined,
    });
  } catch (e) {
    next(e);
  }
});

// ── 4. GET /jobs/:jobId/events (SSE) ────────────────────────────────────────
router.get("/jobs/:jobId/events", optionalAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const jobId = req.params.jobId ?? "";

    let job = await store.getJobById(jobId);
    if (!job) {
      throw new ApiError(404, "NOT_FOUND", "Creator job not found.");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.write(`data: ${JSON.stringify({ status: job.status, progress: job.progress })}\n\n`);

    if (job.status === "COMPLETED" || job.status === "FAILED") {
      res.end();
      return;
    }

    const listener = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (data.status === "COMPLETED" || data.status === "FAILED") {
        creatorEvents.off(`job:${jobId}`, listener);
        res.end();
      }
    };

    creatorEvents.on(`job:${jobId}`, listener);

    req.on("close", () => {
      creatorEvents.off(`job:${jobId}`, listener);
    });
  } catch (e) {
    next(e);
  }
});

// ── 5. GET /jobs/:jobId/download ────────────────────────────────────────────
router.get("/jobs/:jobId/download", optionalAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const jobId = req.params.jobId ?? "";

    const job = await store.getJobById(jobId);
    if (!job) throw new ApiError(404, "NOT_FOUND", "Creator job not found.");

    if (job.status !== "COMPLETED") {
      throw new ApiError(400, "NOT_READY", "Video is not done processing yet.");
    }

    const p = path.join(config.uploadsDir, "jobs", `${job.id}.mp4`);
    if (!fs.existsSync(p)) {
      throw new ApiError(404, "NOT_FOUND", "Exported video file has expired.");
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="soundwave-creator-${job.id}.mp4"`
    );
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    next(e);
  }
});

export default router;
