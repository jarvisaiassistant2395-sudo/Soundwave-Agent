// ── Which Stripe webhooks have already been handled ────────────────────────
// Stripe delivers an event at least once, and it retries anything it thinks
// failed — so the same "subscription is now active" can arrive twice, seconds
// apart. Acting twice is mostly harmless here (setting the same plan again),
// but invoices would be duplicated and a cancellation could be replayed after
// the person re-subscribed. So each event id is recorded once, with a cap:
// Stripe stops retrying long before the oldest ids fall off.
//
// A tiny JSON file next to the other small stores in DATA_DIR (youtube/,
// brain/, chat-files/), and — like them — it notices the file going away.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const MAX_REMEMBERED = 500;

function file(): string {
  return path.join(config.dataDir, "billing", "stripe-events.json");
}

let cached: string[] | null = null;
let cachedMtime = 0;

function load(): string[] {
  const target = file();
  try {
    const stat = fs.statSync(target);
    if (cached && stat.mtimeMs === cachedMtime) return cached;
    const parsed = JSON.parse(fs.readFileSync(target, "utf-8")) as unknown;
    const ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    cached = ids;
    cachedMtime = stat.mtimeMs;
    return ids;
  } catch {
    // No file (or it was just deleted between tests): start empty.
    cached = [];
    cachedMtime = 0;
    return cached;
  }
}

function persist(ids: string[]): void {
  const target = file();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(ids, null, 2), "utf-8");
    cached = ids;
    cachedMtime = fs.statSync(target).mtimeMs;
  } catch {
    /* a read-only data dir must not break a payment webhook */
  }
}

/** Has this event already been handled? */
export function alreadyHandled(eventId: string): boolean {
  return load().includes(eventId);
}

/** Remember an event so a redelivery is ignored. */
export function rememberHandled(eventId: string): void {
  const ids = [eventId, ...load().filter((id) => id !== eventId)].slice(0, MAX_REMEMBERED);
  persist(ids);
}

/** Tests: forget everything. */
export function resetBillingEventsForTests(): void {
  cached = null;
  cachedMtime = 0;
  try {
    fs.rmSync(file(), { force: true });
  } catch {
    /* nothing saved */
  }
}
