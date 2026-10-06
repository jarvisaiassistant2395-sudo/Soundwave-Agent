import type { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import { config } from "../config.js";

// ── Structured, generic error responses ─────────────────────────────────────
// Never expose stack traces or internal details in production.

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  // An id the caller supplied is echoed back (so a mobile client can correlate
  // its own retry), but never trusted for anything but identifying the request.
  const supplied = req.headers["x-request-id"];
  const id = typeof supplied === "string" && /^[\w.-]{8,64}$/.test(supplied) ? supplied : crypto.randomUUID();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: "The requested resource was not found.", requestId: res.locals.requestId as string | undefined },
  });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const requestId = res.locals?.requestId as string | undefined;
  if (err instanceof ApiError) {
    const body: Record<string, unknown> = { error: { code: err.code, message: err.message, requestId } };
    if (err.retryAfter) {
      body.retryAfter = err.retryAfter;
      res.setHeader("Retry-After", String(err.retryAfter));
    }
    res.status(err.status).json(body);
    return;
  }
  const message = (err as Error)?.message ?? "Unknown error";
  if (config.isProd) {
    console.error(`[error] ${requestId ?? "-"}`, message);
  } else {
    console.error(`[error] ${requestId ?? "-"}`, err);
  }
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong on our end. Please try again.", requestId },
  });
}
