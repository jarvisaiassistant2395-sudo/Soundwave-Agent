import type { NextFunction, Request, Response } from "express";
import { logLine } from "../lib/log.js";

/**
 * One line per request that is worth a line.
 *
 * Deliberately not "every request": the desktop window polls the conversation,
 * the jobs and the PC's stats every few seconds, so a full access log would
 * bury the failures under thousands of 200s (and grow a file that is meant to
 * be read by a person). What is worth recording is what went wrong and what
 * was slow — which is exactly what a bug report needs and what the app
 * currently throws away.
 *
 * `SLOW_REQUEST_MS` is generous on purpose: video work happens in the
 * background, so a slow HTTP call here really is unusual.
 */
const SLOW_REQUEST_MS = 3_000;

/** Paths the app's own windows poll: their 200s are noise, their errors are not. */
function isPoll(req: Request): boolean {
  return req.method === "GET";
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - started;
    const status = res.statusCode;
    const failed = status >= 400;
    const slow = ms >= SLOW_REQUEST_MS;
    if (!failed && !slow) return;
    if (!failed && isPoll(req)) return;
    logLine(failed && status >= 500 ? "error" : "warn", failed ? "request failed" : "slow request", {
      method: req.method,
      // The path only — a query string can carry a token or a search term.
      path: req.path,
      status,
      ms,
      requestId: res.locals?.requestId,
    });
  });
  next();
}
