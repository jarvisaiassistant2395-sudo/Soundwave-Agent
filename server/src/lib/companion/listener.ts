// ── Phone companion: the listener on the local network (PC side) ────────────
// Only runs while Settings → Phone → "Let my phone connect" is on, and only
// answers three things:
//
//   GET  /companion/v1/hello  who is this (app, PC name/id, time) — no secrets
//   POST /companion/v1/pair   pairing request, sealed with the one-time code
//   POST /companion/v1/rpc    everything else, sealed with the phone's device key
//
// The rest of the app's API stays on 127.0.0.1. Crypto: lib/companion/crypto.ts.

import http from "node:http";
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "../../config.js";
import { agentChat } from "../../routes/agent.js";
import { resolveJobVideoFile } from "../../routes/export.js";
import { SttError, getSttStatus, transcribe } from "../stt.js";
import { normalizeVoiceId, synthesizeEdgeTTS } from "../edgeTts.js";
import { chatTime, newMessageId, openJobs, replyToMessage, type ChatMessage, type ChatReply } from "../chatMessages.js";
import { appendToConversation, findJob, getConversation, mergeIntoConversation, recentHistory, waitForChange, type JobSnapshot } from "../conversation.js";
import { HISTORY_MESSAGES } from "../brain/chat.js";
import { modelLabel } from "../brain/gemini.js";
import { activeBrain, FALLBACK_MODEL, type ThinkingLevel } from "../brain/settings.js";
import { OPEN_METEO_FORECAST, OPEN_METEO_GEOCODING } from "../brain/core/morning.js";
import { MAX_NOTE_CHARS, type MemoryOp } from "../brain/core/memory.js";
import { applyPhoneMemoryOps, memoryAvailable, memorySnapshot } from "../memory.js";
import { loadMorningSettings, morningCity, runMorningSetup } from "../morning.js";
import { briefingStatus, markBriefingHeard, prepareTodaysBriefing } from "../briefing.js";
import { sanitizeMessages } from "../chatMessages.js";
import { getStore } from "../store.js";
import { EnvelopeError, aad, deriveDeviceKeys, frame, open, seal, unframe } from "./crypto.js";
import {
  activePairing,
  buildStatus,
  completePairing,
  findDevice,
  loadState,
  notePairingFailure,
  pcName,
  removeDevice,
  setEnabledFlag,
  setPort,
  touchDevice,
  type CompanionDevice,
  type CompanionStatus,
} from "./service.js";

export const PROTOCOL_VERSION = 1;
/** How far a request's clock may be from the PC's. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** Longest a `sync` waits for news before answering "nothing new". */
const SYNC_WAIT_MS = 20_000;
/** Largest video chunk per `video.read`. */
const MAX_VIDEO_CHUNK = 2 * 1024 * 1024;
const PORT_ATTEMPTS = 10;

// ── Errors a request can end with ───────────────────────────────────────────

class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function plainError(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: { code, message, ...extra } });
}

// ── Small per-IP rate limit (fixed window) ──────────────────────────────────

function rateLimit(limitPerMinute: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = clientAddress(req) ?? "?";
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now > h.resetAt) {
      h = { count: 0, resetAt: now + 60_000 };
      hits.set(key, h);
      if (hits.size > 5000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    }
    h.count += 1;
    if (h.count > limitPerMinute) return plainError(res, 429, "RATE_LIMITED", "Too many requests — slow down.");
    next();
  };
}

function clientAddress(req: Request): string | null {
  const a = req.socket.remoteAddress;
  if (!a) return null;
  return a.startsWith("::ffff:") ? a.slice(7) : a;
}

// ── Replay protection ───────────────────────────────────────────────────────

const seenNonces = new Map<string, Map<string, number>>();

function checkFresh(deviceId: string, n: unknown, t: unknown): "ok" | "stale" | "replay" | "bad" {
  if (typeof n !== "string" || !/^[0-9a-f]{32}$/.test(n) || typeof t !== "number" || !Number.isFinite(t)) return "bad";
  const now = Date.now();
  if (Math.abs(now - t) > MAX_CLOCK_SKEW_MS) return "stale";
  let seen = seenNonces.get(deviceId);
  if (!seen) seenNonces.set(deviceId, (seen = new Map()));
  if (seen.has(n)) return "replay";
  seen.set(n, now + 2 * MAX_CLOCK_SKEW_MS);
  if (seen.size > 2000) for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  return "ok";
}

// ── Operations the phone can run ────────────────────────────────────────────

interface OpContext {
  device: CompanionDevice;
  payload: Buffer;
  signal: AbortSignal;
  /** The address the phone reached this PC at (Host header, no port). */
  host: string | null;
}

interface OpResult {
  result?: unknown;
  payload?: Buffer;
}

type Args = Record<string, unknown>;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Guard for one phone speech piece (the phone splits replies at 1200 characters). */
const MAX_COMPANION_SPEECH_CHARS = 2000;

async function openJobSnapshots(messages: ChatMessage[]): Promise<JobSnapshot[]> {
  const out: JobSnapshot[] = [];
  for (const { jobId, topic } of openJobs(messages).slice(-3)) {
    const job = await findJob(jobId).catch(() => null);
    if (job) out.push({ ...job, topic: job.topic || topic });
  }
  return out;
}

async function videoFileFor(jobId: string): Promise<{ path: string; size: number; mime: string }> {
  if (!/^[\w-]{1,120}$/.test(jobId)) throw new OpError("NOT_FOUND", "No such video.");
  const store = await getStore();
  const job = (await store.getJobById(jobId).catch(() => null)) ?? null;
  if (!job) throw new OpError("NOT_FOUND", "That video isn't on your PC anymore.");
  if (job.status !== "COMPLETED") throw new OpError("NOT_READY", "That short is still rendering.");
  const file = resolveJobVideoFile(job);
  if (!file) throw new OpError("NOT_FOUND", "The video file was deleted from your PC.");
  const { size } = await fs.promises.stat(file.path);
  return { path: file.path, size, mime: file.ext === ".webm" ? "video/webm" : "video/mp4" };
}

// ── The brain kit: what a phone needs to chat while the PC is off ───────────

export interface BrainKit {
  enabled: true;
  apiKey: string;
  model: string;
  modelLabel: string;
  fallbackModel: string;
  thinking: ThinkingLevel;
  /** Gemini's address, only when it isn't Google's (tests). */
  apiBase?: string;
  /** Morning Setup on the phone: the weather city (and the service, only when it isn't Open-Meteo's). */
  weather: { city: string | null; geocodingUrl?: string; forecastUrl?: string };
  ideas: boolean;
  /** The agent's Soundwave voice (the phone speaks with it when the PC is off). */
  voice: string | null;
  rev: string;
}

export type KitResult = BrainKit | { enabled: false; reason: "sharing_off" | "no_key"; rev: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** A service on this PC's loopback (a test stand-in) is reached through the PC's address from the phone. */
function forPhone(url: string, host: string | null): string {
  try {
    const u = new URL(url);
    if (host && LOOPBACK.has(u.hostname)) u.hostname = host;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

export function brainKit(host: string | null = null): KitResult {
  if (!loadState().shareBrain) return { enabled: false, reason: "sharing_off", rev: "sharing_off" };
  const brain = activeBrain();
  if (!brain) return { enabled: false, reason: "no_key", rev: "no_key" };
  const settings = loadMorningSettings();
  const base = config.companionGeminiBase || (config.geminiApiBase !== "https://generativelanguage.googleapis.com" ? forPhone(config.geminiApiBase, host) : "");
  const body = {
    apiKey: brain.apiKey,
    model: brain.model,
    modelLabel: modelLabel(brain.model),
    fallbackModel: FALLBACK_MODEL,
    thinking: brain.thinking,
    ...(base ? { apiBase: base } : {}),
    weather: {
      city: morningCity(settings).city,
      ...(config.openMeteoGeocodingUrl !== OPEN_METEO_GEOCODING ? { geocodingUrl: forPhone(config.openMeteoGeocodingUrl, host) } : {}),
      ...(config.openMeteoForecastUrl !== OPEN_METEO_FORECAST ? { forecastUrl: forPhone(config.openMeteoForecastUrl, host) } : {}),
    },
    ideas: settings.ideas,
    voice: getConversation().voice ?? null,
  };
  return { enabled: true, ...body, rev: createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16) };
}

/** Notes added / forgotten on the phone while the PC was off. */
function memoryOpsFrom(input: unknown): MemoryOp[] {
  if (!Array.isArray(input)) return [];
  const ops: MemoryOp[] = [];
  for (const raw of input.slice(0, 100)) {
    const op = raw as Record<string, unknown>;
    if (op?.op === "forget" && typeof op.id === "string") ops.push({ op: "forget", id: op.id.slice(0, 40) });
    else if (op?.op === "add" && op.note && typeof op.note === "object") {
      const note = op.note as Record<string, unknown>;
      if (typeof note.id === "string" && typeof note.text === "string") ops.push({ op: "add", note: { id: note.id.slice(0, 40), text: note.text.slice(0, MAX_NOTE_CHARS * 2), at: Number(note.at) || Date.now(), from: "phone" } });
    }
  }
  return ops;
}

const OPS: Record<string, (args: Args, ctx: OpContext) => Promise<OpResult>> = {
  // Still paired? What can this PC do?
  async hello(_args, { device }) {
    const stt = getSttStatus();
    return {
      result: {
        protocol: PROTOCOL_VERSION,
        pcId: loadState().pcId,
        pcName: pcName(),
        device: { id: device.id, name: device.name },
        voiceInput: { available: stt.available, reason: stt.reason },
        voice: getConversation().voice ?? null,
        time: Date.now(),
        // Chat while the PC is off: is it allowed, and which kit/memory is current.
        brain: (() => {
          const kit = brainKit();
          return kit.enabled ? { phoneChat: true, modelLabel: kit.modelLabel, kitRev: kit.rev } : { phoneChat: false, reason: kit.reason, kitRev: kit.rev };
        })(),
        memoryRev: memoryAvailable() ? (await memorySnapshot()).rev : null,
      },
    };
  },

  // The Gemini key and settings for chatting while the PC is off (or why not).
  async "brain.kit"(_args, { host }) {
    return { result: brainKit(host) };
  },

  // Offline messages and memory changes from the phone, back into the PC's conversation and memory.
  async merge(args) {
    const incoming = sanitizeMessages(args.messages)
      .slice(-100)
      .flatMap((m): ChatMessage[] => (m.sender === "user" ? [{ ...m, via: "phone" }] : m.sender === "assistant" ? [{ ...m, answeredBy: "phone" }] : []));
    const ops = memoryOpsFrom(args.memoryOps);
    if (ops.length && memoryAvailable()) applyPhoneMemoryOps(ops);
    const snap = incoming.length ? mergeIntoConversation(incoming) : getConversation();
    // A briefing the phone made (and spoke) while the PC was off, or the PC's one it spoke offline: heard.
    for (const m of incoming) if (m.sender === "assistant" && m.briefingDate) markBriefingHeard(m.briefingDate, "phone");
    if (Array.isArray(args.heard)) for (const d of args.heard.slice(0, 14)) if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) markBriefingHeard(d, "phone");
    const memory = memoryAvailable() ? await memorySnapshot() : null;
    return { result: { epoch: snap.epoch, rev: snap.rev, messages: snap.messages, merged: incoming.length, memoryOps: ops.length, memoryRev: memory?.rev ?? null, memory } };
  },

  // "🌅 Morning Setup" on the phone: runs on the PC (opens the morning items here if allowed).
  async morning() {
    const now = Date.now();
    appendToConversation({ id: newMessageId(now), sender: "user", text: "🌅 Morning Setup", time: chatTime(new Date(now)), at: now, via: "phone" });
    let reply: ChatReply;
    try {
      reply = await runMorningSetup({ via: "phone" });
    } catch (err) {
      console.error("[companion] morning setup failed:", err);
      reply = { success: false, reply: `I couldn't run the Morning Setup just now: ${(err as Error).message}`, tag: "SYS" };
    }
    const aiMsg = replyToMessage(reply, "Morning Setup", Math.max(Date.now(), now + 1));
    const snap = appendToConversation(aiMsg);
    if (aiMsg.briefingDate) markBriefingHeard(aiMsg.briefingDate, "phone");
    return { result: { epoch: snap.epoch, rev: snap.rev, messages: snap.messages, reply: aiMsg } };
  },

  // Opened in the morning: today's briefing (written when it was due) — or written now when asked.
  async "briefing.today"(args) {
    let status = briefingStatus();
    if (args.prepare === true && status.inWindow && !status.message) {
      await prepareTodaysBriefing("phone");
      status = briefingStatus();
    }
    const snap = getConversation();
    return { result: { ...status, epoch: snap.epoch, rev: snap.rev, messages: snap.messages } };
  },

  // The phone spoke today's briefing: the Command Center won't speak it again.
  async "briefing.heard"(args) {
    const day = str(args.day, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new OpError("BAD_ARGS", "Which day?");
    markBriefingHeard(day, "phone");
    return { result: { ok: true } };
  },

  // The conversation (+ progress of shorts it's waiting on). With `wait`, holds
  // the request until something changes (≤ 20 s) — the phone's live updates.
  async sync(args, { signal }) {
    const epoch = str(args.epoch, 40);
    const rev = typeof args.rev === "number" ? args.rev : -1;
    let snap = getConversation();
    let jobs = await openJobSnapshots(snap.messages);
    if (args.wait === true && snap.epoch === epoch && snap.rev === rev && jobs.length === 0) {
      await waitForChange(snap.rev, SYNC_WAIT_MS, signal);
      snap = getConversation();
      jobs = await openJobSnapshots(snap.messages);
    }
    const upToDate = snap.epoch === epoch && snap.rev === rev;
    const memory = memoryAvailable() ? await memorySnapshot() : null;
    return {
      result: {
        epoch: snap.epoch,
        rev: snap.rev,
        ...(upToDate ? {} : { messages: snap.messages }),
        jobs,
        voice: snap.voice ?? null,
        kitRev: brainKit().rev,
        memoryRev: memory?.rev ?? null,
        ...(memory && memory.rev !== str(args.memoryRev, 40) ? { memory } : {}),
      },
    };
  },

  // Say something to the agent (typed or already transcribed).
  async send(args) {
    const message = str(args.text, 4000).trim();
    if (!message) throw new OpError("EMPTY", "Type or say something first.");
    const history = recentHistory(HISTORY_MESSAGES);
    const now = Date.now();
    const userMsg: ChatMessage = {
      id: newMessageId(now),
      sender: "user",
      text: message,
      time: chatTime(new Date(now)),
      at: now,
      via: "phone",
      ...(args.viaVoice === true ? { viaVoice: true } : {}),
    };
    appendToConversation(userMsg);
    const voice = normalizeVoiceId(args.voice || getConversation().voice);
    let reply: ChatReply;
    try {
      reply = await agentChat({ message, history, voice, resolution: args.resolution === "1080p" ? "1080p" : "720p", userId: "local-user", via: "phone" });
    } catch (err) {
      console.error("[companion] agent failed:", err);
      reply = { success: false, reply: `I couldn't process "${message}" just now: ${(err as Error).message}`, tag: "SYS" };
    }
    const aiMsg = replyToMessage(reply, message, Math.max(Date.now(), now + 1));
    const snap = appendToConversation(aiMsg);
    return { result: { epoch: snap.epoch, rev: snap.rev, messages: snap.messages, reply: aiMsg } };
  },

  // Speech → text on the PC (whisper.cpp); the payload is the recording.
  async transcribe(_args, { payload, signal }) {
    try {
      return { result: await transcribe(payload, { signal }) };
    } catch (err) {
      if (err instanceof SttError) throw new OpError(err.code, err.message);
      throw err;
    }
  },

  // A reply read aloud in a Soundwave voice; the payload is the MP3.
  // The phone sends one piece at a time (<= 1200 characters), so the cap below
  // is only a guard — and it warns instead of quietly dropping the tail.
  async speak(args) {
    const asked = str(args.text, 4000).replace(/\s+/g, " ").trim();
    const text = asked.slice(0, MAX_COMPANION_SPEECH_CHARS);
    if (asked.length > text.length) {
      console.warn(`[companion] speech text longer than ${MAX_COMPANION_SPEECH_CHARS} characters (${asked.length}) — speaking only the first part; the phone should send it in pieces`);
    }
    if (!text) throw new OpError("EMPTY", "Nothing to say.");
    const voice = normalizeVoiceId(args.voice || getConversation().voice);
    try {
      // No explicit speed: the shared default is the relaxed narrator cadence
      // (same as the PC's own playback).
      const out = await synthesizeEdgeTTS({ text, voice }, { attempts: 2 });
      return { result: { mime: out.mimeType, voice, duration: out.duration }, payload: Buffer.from(out.audioBase64, "base64") };
    } catch (err) {
      throw new OpError("VOICE_UNAVAILABLE", (err as Error).message || "The Soundwave voice service didn't answer.");
    }
  },

  async "video.info"(args) {
    const { size, mime } = await videoFileFor(str(args.jobId, 120));
    return { result: { size, mime } };
  },

  async "video.read"(args) {
    const file = await videoFileFor(str(args.jobId, 120));
    const offset = typeof args.offset === "number" && args.offset >= 0 ? Math.floor(args.offset) : 0;
    const length = Math.min(MAX_VIDEO_CHUNK, typeof args.length === "number" && args.length > 0 ? Math.floor(args.length) : MAX_VIDEO_CHUNK);
    if (offset >= file.size) return { result: { size: file.size, offset, length: 0 }, payload: Buffer.alloc(0) };
    const handle = await fs.promises.open(file.path, "r");
    try {
      const buf = Buffer.alloc(Math.min(length, file.size - offset));
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      return { result: { size: file.size, offset, length: bytesRead }, payload: buf.subarray(0, bytesRead) };
    } finally {
      await handle.close();
    }
  },

  // "Unpair this phone" in the app.
  async unpair(_args, { device }) {
    removeDevice(device.id);
    return { result: { ok: true } };
  },
};

// ── HTTP ────────────────────────────────────────────────────────────────────

const keyCache = new Map<string, { key: string; c2s: Buffer; s2c: Buffer }>();

function keysFor(device: CompanionDevice): { c2s: Buffer; s2c: Buffer } {
  const hit = keyCache.get(device.id);
  if (hit && hit.key === device.key) return hit;
  const keys = { key: device.key, ...deriveDeviceKeys(Buffer.from(device.key, "base64"), device.id) };
  keyCache.set(device.id, keys);
  return keys;
}

function abortOnClose(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

async function handlePair(req: Request, res: Response): Promise<void> {
  const session = activePairing();
  if (!session) {
    return plainError(res, 409, "NO_PAIRING", "Pairing isn't open on the PC. Open Soundwave AI → Settings → Phone to show a new code.");
  }
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let header: Record<string, unknown>;
  try {
    header = unframe(open(session.key, body, aad("pair", "c2s", session.pcId))).header;
  } catch {
    notePairingFailure();
    return plainError(res, 400, "WRONG_CODE", "That code doesn't match the one on the PC (it changes every 10 minutes).");
  }
  const n = header.n;
  if (header.op !== "pair" || checkFresh(`pair:${session.pcId}`, n, header.t) !== "ok") {
    return plainError(res, 400, "BAD_REQUEST", "Pairing request rejected — check the phone's date and time.");
  }
  const args = (header.args ?? {}) as Args;
  const { device, deviceKey } = completePairing({
    name: str(args.name, 60) || "Phone",
    platform: str(args.platform, 20) || "android",
    model: str(args.model, 80) || undefined,
    appVersion: str(args.appVersion, 20) || undefined,
    address: clientAddress(req),
  });
  console.log(`[companion] paired "${device.name}" (${device.id})`);
  const reply = frame({
    n,
    ok: true,
    t: Date.now(),
    result: { deviceId: device.id, deviceKey: deviceKey.toString("base64"), pcId: session.pcId, pcName: pcName(), protocol: PROTOCOL_VERSION },
  });
  res.status(200).type("application/octet-stream").send(seal(session.key, reply, aad("pair", "s2c", session.pcId, String(n))));
}

async function handleRpc(req: Request, res: Response): Promise<void> {
  const deviceId = req.header("x-soundwave-device") ?? "";
  const device = deviceId ? findDevice(deviceId) : null;
  if (!device) return plainError(res, 401, "UNKNOWN_DEVICE", "This phone isn't paired with the PC (anymore). Pair it again from Settings → Phone.");
  const keys = keysFor(device);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let header: Record<string, unknown>;
  let payload: Buffer;
  try {
    ({ header, payload } = unframe(open(keys.c2s, body, aad("rpc", "c2s", device.id))));
  } catch (err) {
    if (err instanceof EnvelopeError) return plainError(res, 400, "BAD_ENVELOPE", "The request couldn't be read.");
    throw err;
  }
  const fresh = checkFresh(device.id, header.n, header.t);
  if (fresh === "stale") return plainError(res, 409, "CLOCK", "The phone's clock is too far from the PC's.", { time: Date.now() });
  if (fresh === "replay") return plainError(res, 409, "REPLAY", "Request already seen.");
  if (fresh === "bad") return plainError(res, 400, "BAD_REQUEST", "Malformed request.");
  touchDevice(device, clientAddress(req));

  const n = String(header.n);
  const op = typeof header.op === "string" ? OPS[header.op] : undefined;
  let out: Buffer;
  try {
    if (!op) throw new OpError("UNKNOWN_OP", `Unknown request "${String(header.op)}" — update the Soundwave app.`);
    const signal = abortOnClose(res);
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "") || null;
    const { result, payload: outPayload } = await op((header.args ?? {}) as Args, { device, payload, signal, host });
    if (signal.aborted) return;
    out = frame({ n, ok: true, t: Date.now(), result: result ?? null }, outPayload);
  } catch (err) {
    const code = err instanceof OpError ? err.code : "FAILED";
    const message = err instanceof OpError ? err.message : "Something went wrong on the PC.";
    if (!(err instanceof OpError)) console.error(`[companion] ${String(header.op)} failed:`, err);
    out = frame({ n, ok: false, t: Date.now(), error: { code, message } });
  }
  if (res.writableEnded || res.destroyed) return;
  res.status(200).type("application/octet-stream").send(seal(keys.s2c, out, aad("rpc", "s2c", device.id, n)));
}

export function createCompanionApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  // The app page (https://localhost in the WebView) calls the PC cross-origin.
  // No cookies are involved: every request proves itself cryptographically.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Soundwave-Device");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.headers["access-control-request-private-network"]) res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  });

  app.get("/companion/v1/hello", rateLimit(240), (_req, res) => {
    res.json({ app: "soundwave", protocol: PROTOCOL_VERSION, pcId: loadState().pcId, pcName: pcName(), time: Date.now(), pairing: Boolean(activePairing()) });
  });
  app.post("/companion/v1/pair", rateLimit(30), express.raw({ type: () => true, limit: "64kb" }), (req, res, next) => {
    handlePair(req, res).catch(next);
  });
  app.post("/companion/v1/rpc", rateLimit(900), express.raw({ type: () => true, limit: "16mb" }), (req, res, next) => {
    handleRpc(req, res).catch(next);
  });

  app.use((_req, res) => plainError(res, 404, "NOT_FOUND", "Not here."));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err.type === "entity.too.large" || err.status === 413) return plainError(res, 413, "TOO_LARGE", "That's too big to send.");
    console.error("[companion] request failed:", err);
    plainError(res, 500, "FAILED", "Something went wrong on the PC.");
  });
  return app;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let server: http.Server | null = null;
let sockets = new Set<Socket>();
let listenError: string | null = null;
let starting: Promise<void> | null = null;

function listenOn(port: number, host: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(createCompanionApp());
    srv.requestTimeout = 60_000;
    srv.headersTimeout = 20_000;
    srv.keepAliveTimeout = 5_000;
    const onError = (err: Error) => {
      srv.close();
      reject(err);
    };
    srv.once("error", onError);
    srv.listen(port, host, () => {
      srv.off("error", onError);
      resolve(srv);
    });
  });
}

export function listenerState(): { listening: boolean; port: number | null; error: string | null } {
  const addr = server?.address() as AddressInfo | null | undefined;
  return { listening: Boolean(server && addr), port: addr?.port ?? null, error: listenError };
}

export function companionStatus(): CompanionStatus {
  return buildStatus(listenerState());
}

/** Opens the LAN listener (the port the phone remembers, else the next free one). */
export async function startListener(opts: { host?: string; port?: number } = {}): Promise<void> {
  if (server) return;
  if (starting) return starting;
  starting = (async () => {
    const host = opts.host ?? "0.0.0.0";
    const first = opts.port ?? loadState().port ?? config.companionPort;
    let lastErr: Error | null = null;
    for (let i = 0; i < (opts.port === 0 ? 1 : PORT_ATTEMPTS); i++) {
      try {
        const srv = await listenOn(opts.port === 0 ? 0 : first + i, host);
        sockets = new Set();
        srv.on("connection", (s: Socket) => {
          sockets.add(s);
          s.on("close", () => sockets.delete(s));
        });
        server = srv;
        listenError = null;
        const port = (srv.address() as AddressInfo).port;
        if (opts.port !== 0) setPort(port);
        console.log(`[companion] phone listener on ${host}:${port}`);
        return;
      } catch (err) {
        lastErr = err as Error;
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") break;
      }
    }
    listenError = `Couldn't open the phone connection: ${lastErr?.message ?? "unknown error"}`;
    console.warn(`[companion] ${listenError}`);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

export async function stopListener(): Promise<void> {
  const srv = server;
  server = null;
  if (!srv) return;
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  console.log("[companion] phone listener closed");
}

/** Settings → Phone toggle. */
export async function setCompanionEnabled(enabled: boolean): Promise<CompanionStatus> {
  setEnabledFlag(enabled);
  if (enabled) await startListener();
  else await stopListener();
  return companionStatus();
}

/** At startup: reopen the listener if the person left phone access on. */
export async function initCompanion(): Promise<void> {
  if (!config.companionAvailable) return;
  if (loadState().enabled) await startListener();
}
