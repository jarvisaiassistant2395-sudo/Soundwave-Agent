// ── Routes only the desktop app's own window may use ────────────────────────
// Settings → Phone (companion.ts) and Settings → Brain (brain.ts) change this
// PC's setup. They answer only when the feature is available here, and are
// refused for other sites (Origin) and for DNS rebinding (the Host must be
// loopback when the API only listens on loopback).

import type { Request, RequestHandler } from "express";
import { config } from "../config.js";
import { ApiError } from "./error.js";

const LOOPBACK_BIND = new Set(["127.0.0.1", "localhost", "::1"]);

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"));
  return h.replace(/:\d+$/, "");
}

/** Why this request isn't from the app's own window, or null when it is. */
export function notFromApp(req: Request): string | null {
  const host = req.headers.host ?? "";
  if (LOOPBACK_BIND.has(config.bindHost) && !LOOPBACK_BIND.has(hostnameOf(host))) return "Not available from here.";
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {
      /* malformed Origin */
    }
    if (!sameOrigin) return "Not available from other sites.";
  }
  return null;
}

export function localAppGuard(isAvailable: () => boolean, unavailableMessage: string): RequestHandler {
  return (req, _res, next) => {
    if (!isAvailable()) return next(new ApiError(404, "NOT_FOUND", unavailableMessage));
    const problem = notFromApp(req);
    if (problem) return next(new ApiError(403, "FORBIDDEN", problem));
    next();
  };
}
