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
  res.locals.requestId = crypto.randomUUID();
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
