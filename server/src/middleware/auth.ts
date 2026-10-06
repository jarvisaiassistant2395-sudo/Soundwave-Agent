import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "../config.js";
import { ApiError } from "./error.js";
import {
  clearAuthCookies,
  createUserSession,
  deviceInfoFromUA,
  randomToken,
  setAuthCookies,
  sha256,
  signAccessToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../lib/auth.js";
import { getStore } from "../lib/store.js";
import type { StoredUser } from "../lib/store.js";
import { PLANS, type Plan } from "../lib/plans.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: StoredUser;
    }
  }
}

function getCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** CSRF protection for cookie-authenticated state-changing requests. */
function checkCsrf(req: Request): void {
  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
  const cookies = getCookies(req);
  const token = cookies["csrf_token"];
  if (!token) {
    // If there's no CSRF cookie, this is not a cookie-authenticated request,
    // so we still need to reject state-changing requests that lack proper CSRF validation
    const header = req.headers["x-csrf-token"];
    if (header && typeof header === "string" && header.length > 0) {
      // Client sent a CSRF header but no cookie — reject it
      throw new ApiError(403, "CSRF_FAILED", "Invalid CSRF token.");
    }
    // No cookie and no header: reject state-changing requests
    throw new ApiError(403, "CSRF_FAILED", "CSRF token required.");
  }
  const header = req.headers["x-csrf-token"];
  if (typeof header !== "string" || header.length === 0 || header !== token) {
    throw new ApiError(403, "CSRF_FAILED", "Invalid CSRF token.");
  }
}

/** Attempt silent refresh via the refresh-token cookie. */
async function tryRefresh(req: Request, res: Response): Promise<StoredUser | null> {
  const cookies = getCookies(req);
  const token = cookies["refresh_token"];
  if (!token) return null;
  const claims = verifyRefreshToken(token);
  if (!claims) return null;

  const store = await getStore();
  const session = await store.findSessionById(claims.sid);
  if (!session) return null;
  // null = permanent (the signed-in Google account); otherwise it must be live.
  if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
    await store.deleteSession(session.id);
    return null;
  }
  // The stored token must hash-match; otherwise treat as reuse/theft.
  if (session.refreshTokenHash !== sha256(token)) {
    await store.deleteAllSessionsForUser(claims.sub);
    return null;
  }
  const user = await store.findUserById(claims.sub);
  if (!user) return null;

  // Rotate: delete old session, issue a new one + fresh tokens (a permanent
  // session stays permanent).
  await store.deleteSession(session.id);
  const bundle = await createUserSession(store, user.id, req.ip ?? "unknown", session.deviceInfo, { permanent: session.expiresAt === null });
  setAuthCookies(res, signAccessToken(user.id), bundle.refreshToken, randomToken(16));
  return user;
}

async function resolveUser(req: Request, res: Response): Promise<StoredUser | null> {
  const cookies = getCookies(req);
  const access = cookies["access_token"];
  if (access) {
    const claims = verifyAccessToken(access);
    if (claims) {
      const store = await getStore();
      const user = await store.findUserById(claims.sub);
      if (user) return user;
    }
  }
  return tryRefresh(req, res);
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    checkCsrf(req);
    const user = await resolveUser(req, res);
    if (!user) {
      clearAuthCookies(res);
      throw new ApiError(401, "UNAUTHORIZED", "Please sign in to continue.");
    }
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
};

export const optionalAuth: RequestHandler = async (req, _res, next) => {
  try {
    const user = await resolveUser(req, _res);
    if (user) req.user = user;
    next();
  } catch {
    next();
  }
};

export function requirePlan(min: Plan): RequestHandler {
  const order: Plan[] = ["FREE", "PRO", "ENTERPRISE"];
  return (req, _res, next) => {
    const user = req.user;
    if (!user) return next(new ApiError(401, "UNAUTHORIZED", "Please sign in."));
    if (order.indexOf(user.plan) < order.indexOf(min)) {
      return next(new ApiError(403, "PLAN_REQUIRED", `This feature requires the ${PLANS[min].name} plan.`));
    }
    next();
  };
}

export function deviceInfo(req: Request): string {
  return deviceInfoFromUA(req.headers["user-agent"]);
}

export { config };