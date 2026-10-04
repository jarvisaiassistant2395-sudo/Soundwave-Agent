import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import { config } from "../config.js";
import type { DataStore, StoredUser } from "./store.js";

// ── Passwords (bcrypt, cost 12) ─────────────────────────────────────────────
const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ── Cryptographic tokens ────────────────────────────────────────────────────
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}
export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ── JWT (short-lived access + long-lived refresh) ───────────────────────────
export interface AccessClaims {
  sub: string;
  type: "access";
}
export interface RefreshClaims {
  sub: string;
  type: "refresh";
  sid: string; // session id — enables rotation + theft detection
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, type: "access" } satisfies AccessClaims, config.jwtAccessSecret, {
    expiresIn: config.jwtAccessTtl as jwt.SignOptions["expiresIn"],
  });
}
export function signRefreshToken(userId: string, sessionId: string): string {
  return jwt.sign({ sub: userId, type: "refresh", sid: sessionId } satisfies RefreshClaims, config.jwtRefreshSecret, {
    expiresIn: config.jwtRefreshTtl as jwt.SignOptions["expiresIn"],
  });
}
export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const c = jwt.verify(token, config.jwtAccessSecret) as AccessClaims;
    return c.type === "access" ? c : null;
  } catch {
    return null;
  }
}
export function verifyRefreshToken(token: string): RefreshClaims | null {
  try {
    const c = jwt.verify(token, config.jwtRefreshSecret) as RefreshClaims;
    return c.type === "refresh" ? c : null;
  } catch {
    return null;
  }
}

// ── Cookies ─────────────────────────────────────────────────────────────────
export function cookieOpts(ttlMs: number) {
  return {
    httpOnly: true,
    secure: config.isProd || config.appUrl.startsWith("https"),
    sameSite: "strict" as const,
    path: "/",
    maxAge: ttlMs,
  };
}

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  csrfToken: string,
): void {
  res.cookie("access_token", accessToken, cookieOpts(15 * 60 * 1000));
  res.cookie("refresh_token", refreshToken, cookieOpts(7 * 24 * 60 * 60 * 1000));
  res.cookie("csrf_token", csrfToken, {
    httpOnly: false,
    secure: config.isProd || config.appUrl.startsWith("https"),
    sameSite: "strict",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  for (const name of ["access_token", "refresh_token", "csrf_token"]) {
    res.clearCookie(name, { path: "/" });
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────
export interface SessionBundle {
  sessionId: string;
  refreshToken: string;
}

export async function createUserSession(
  store: DataStore,
  userId: string,
  ip: string,
  deviceInfo: string,
): Promise<SessionBundle> {
  const sessionId = randomToken(16);
  const refreshToken = signRefreshToken(userId, sessionId);
  const now = Date.now();
  await store.createSession({
    id: sessionId,
    userId,
    refreshTokenHash: sha256(refreshToken),
    deviceInfo,
    ipAddress: ip,
    lastActiveAt: new Date().toISOString(),
    expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  return { sessionId, refreshToken };
}

export function deviceInfoFromUA(ua: string | undefined): string {
  const s = (ua ?? "unknown").slice(0, 140);
  return s || "unknown";
}

export function publicUser(u: StoredUser) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    plan: u.plan,
    avatarUrl: u.avatarUrl,
    emailVerified: u.emailVerified,
  };
}
