import { Router } from "express";
import { resolveJobVideoFile } from "../lib/jobFiles.js";
import { EventEmitter } from "node:events";
import path from "node:path";
import { optionalAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/error.js";
import { getStore } from "../lib/store.js";

// Rendered videos: status, live progress and download for the shorts the
// agent makes. The agent is the only thing in the app that renders video, so
// there is no "start an export" endpoint here (the old Compose Video page's
// POST /video is gone).
const router = Router();

const jobEvents = new EventEmitter();

export function emitJob(jobId: string, payload: Record<string, unknown>): void {
  jobEvents.emit(jobId, payload);
}

export { jobEvents };

/** The rendered file of a finished job (also served to the phone companion), or null if it's gone. */

function isLocalAutomationUser(uid?: string | null): boolean {
  if (!uid) return false;
  return uid === "agent-local" || uid === "soundwave-local" || uid === "soundwave-agent" || uid === "jarvis-local";
}

// ── Job status ──────────────────────────────────────────────────────────────
// Allow local automation jobs (one-click endpoint) without auth — otherwise require auth
router.get("/jobs/:jobId", optionalAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const jobId = req.params.jobId ?? "";
    let job = await store.getJob(jobId, "agent-local");
    if (!job) job = await store.getJob(jobId, "soundwave-local");
    if (!job) job = await store.getJob(jobId, "soundwave-agent");
    if (!job) job = await store.getJob(jobId, "jarvis-local");
    if (!job && req.user) {
      job = await store.getJob(jobId, req.user.id);
    }
    // Fallback: try to find job without user check
    if (!job) {
      try {
        const all = await (store as any).getJobById?.(jobId);
        if (all) job = all;
      } catch {}
    }
    if (!job) {
      const uid = req.user?.id ?? "agent-local";
      job = await store.getJob(jobId, uid);
    }
    if (!job) throw new ApiError(404, "NOT_FOUND", "Export job not found.");
    // If job belongs to someone else and request is not that user and not a local job, block
    if (!isLocalAutomationUser(job.userId) && req.user && job.userId !== req.user.id) {
      throw new ApiError(403, "FORBIDDEN", "Not your export job.");
    }
    res.json({
      job: {
        id: job.id,
        status: job.status,
        progress: job.progress,
        outputUrl: job.outputUrl,
        errorMessage: job.errorMessage,
        settings: job.settings,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      },
    });
  } catch (e) {
    next(e);
  }
});

// ── SSE progress stream (no polling) ────────────────────────────────────────
router.get("/jobs/:jobId/events", optionalAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const jobId = req.params.jobId ?? "";
    let job = await store.getJob(jobId, "agent-local");
    if (!job) job = await store.getJob(jobId, "soundwave-local");
    if (!job) job = await store.getJob(jobId, "soundwave-agent");
    if (!job) job = await store.getJob(jobId, "jarvis-local");
    if (!job && req.user) job = await store.getJob(jobId, req.user.id);
    if (!job) {
      try {
        const all = await (store as any).getJobById?.(jobId);
        if (all) job = all;
      } catch {}
    }
    if (!job) {
      const uid = req.user?.id ?? "agent-local";
      job = await store.getJob(jobId, uid);
    }
    if (!job) throw new ApiError(404, "NOT_FOUND", "Export job not found.");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (data: Record<string, unknown>) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ status: job.status, progress: job.progress, outputUrl: job.outputUrl });

    const onUpdate = (payload: Record<string, unknown>) => {
      send(payload);
      if (payload.status === "COMPLETED" || payload.status === "FAILED") {
        jobEvents.removeListener(job.id, onUpdate);
        res.end();
      }
    };
    jobEvents.on(job.id, onUpdate);

    req.on("close", () => jobEvents.removeListener(job.id, onUpdate));
    const hb = setInterval(() => res.write(`: hb\n\n`), 15000);
    res.on("close", () => clearInterval(hb));
  } catch (e) {
    next(e);
  }
});

// ── Download ────────────────────────────────────────────────────────────────
// Allow local automation downloads without auth cookie
router.get("/jobs/:jobId/download", optionalAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const jobId = req.params.jobId ?? "";
    let job = await store.getJob(jobId, "agent-local");
    if (!job) job = await store.getJob(jobId, "soundwave-local");
    if (!job) job = await store.getJob(jobId, "soundwave-agent");
    if (!job) job = await store.getJob(jobId, "jarvis-local");
    if (!job && req.user) job = await store.getJob(jobId, req.user.id);
    if (!job) {
      try {
        const all = await (store as any).getJobById?.(jobId);
        if (all) job = all;
      } catch {}
    }
    if (!job) {
      const uid = req.user?.id ?? "agent-local";
      job = await store.getJob(jobId, uid);
    }
    if (!job) throw new ApiError(404, "NOT_FOUND", "Export job not found.");
    if (job.status !== "COMPLETED" || !job.outputUrl) {
      throw new ApiError(400, "NOT_READY", "This export is not ready for download yet.");
    }
    const file = resolveJobVideoFile(job);
    if (!file) throw new ApiError(404, "NOT_FOUND", "Export file expired. Please export again.");
    const { path: p, ext } = file;

    const isDownload = req.query.download === "1" || req.query.dl === "1";
    if (isDownload) {
      res.setHeader("Content-Disposition", `attachment; filename="soundwave-export-${job.id}${ext}"`);
    } else {
      res.setHeader("Content-Disposition", `inline; filename="soundwave-export-${job.id}${ext}"`);
    }
    res.setHeader("Content-Type", ext === ".webm" ? "video/webm" : "video/mp4");
    res.sendFile(path.resolve(p));
  } catch (e) {
    next(e);
  }
});

export default router;
