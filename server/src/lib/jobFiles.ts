// ── Where a rendered job's file actually is ─────────────────────────────────
// Three writers name their output differently (the clip renderer, the
// script-to-short builder, the older export path), so the download route has
// always guessed between candidates. The expiry sweep needs the same guess —
// hence one list, used by both, instead of a second copy that drifts.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export type JobFileExt = ".mp4" | ".webm";

export function jobVideoCandidates(jobId: string, ext: JobFileExt): string[] {
  return [
    path.join(config.uploadsDir, "jobs", `${jobId}${ext}`),
    path.join(config.uploadsDir, `soundwave_short_${jobId}${ext}`),
    path.join(config.uploadsDir, `${jobId}${ext}`),
  ];
}

/** The file for a finished job, or null when it was never written (or is gone). */
export function resolveJobVideoFile(job: { id: string; settings?: unknown }): { path: string; ext: JobFileExt } | null {
  const ext: JobFileExt = (job.settings as { format?: string } | null | undefined)?.format === "webm" ? ".webm" : ".mp4";
  const candidates: Array<[string, JobFileExt]> = [
    ...jobVideoCandidates(job.id, ext).map((f) => [f, ext] as [string, JobFileExt]),
    ...jobVideoCandidates(job.id, ".mp4").map((f) => [f, ".mp4"] as [string, JobFileExt]),
  ];
  const hit = candidates.find(([f]) => fs.existsSync(f));
  return hit ? { path: hit[0], ext: hit[1] } : null;
}

/** Delete whatever is there. Missing files are success — someone got there first. */
export function removeJobVideoFile(job: { id: string; settings?: unknown }): number {
  let removed = 0;
  for (const ext of [".mp4", ".webm"] as JobFileExt[]) {
    for (const file of jobVideoCandidates(job.id, ext)) {
      try {
        fs.unlinkSync(file);
        removed += 1;
      } catch {
        /* not there */
      }
    }
  }
  return removed;
}
