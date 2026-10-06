// ── Several YouTube channels, each with its own publishing plan ─────────────
// One Soundwave can post to more than one channel. Every channel keeps its own
// Google sign-in (its own refresh token — the OAuth client is shared, which is
// how Google works), its own privacy default, and its own plan for user content.
// The publish planner (lib/publishPlan.ts) reads these plans and can make a
// regular Short on schedule while the app is running.
//
// The single connection the app had before is not lost: on the first read it
// becomes the "default" channel, refresh token and all.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { youtubeService, type YouTubeConfig } from "./youtube.js";

export const LEGACY_CHANNEL_ID = "default";
export const MIN_EVERY_DAYS = 1;
export const MAX_EVERY_DAYS = 30;

export interface ChannelPlan {
  /** What user content to publish on this channel. */
  what: string;
  /** Make and post one Short every `everyDays` days while the app is running. */
  auto: boolean;
  everyDays: number;
  /** HH:MM local — empty means "as soon as it's due and the app is on". */
  time: string;
  lastRunAt: number | null;
  runs: number;
  lastError: string | null;
}

export interface ChannelRecord {
  id: string;
  /** What the person calls it, then the real channel title once Google answers. */
  name: string;
  channelId: string | null;
  refreshToken: string;
  clientSource?: "own" | "built-in";
  connectedClientId?: string;
  privacy: "public" | "unlisted" | "private";
  /** Post finished shorts here when no channel is named (the default channel). */
  autoPublish: boolean;
  addedAt: number;
  lastUploadAt: number | null;
  lastVideoUrl: string | null;
  plan: ChannelPlan;
}

interface ChannelStore {
  channels: ChannelRecord[];
  defaultId: string | null;
}

const EMPTY_PLAN: ChannelPlan = { what: "", auto: false, everyDays: 3, time: "", lastRunAt: null, runs: 0, lastError: null };

type StoredChannelPlan = Partial<ChannelPlan> & { kind?: string };

const normal = (p?: StoredChannelPlan | null): ChannelPlan => {
  const retiredDemo = p?.kind === "demo";
  return {
    // Retire old self-promotion plans instead of silently turning them into
    // scheduled regular Shorts after an app update.
    what: retiredDemo ? "" : (p?.what ?? EMPTY_PLAN.what).trim().slice(0, 400),
    auto: !retiredDemo && p?.auto === true,
    everyDays: retiredDemo
      ? EMPTY_PLAN.everyDays
      : Math.min(MAX_EVERY_DAYS, Math.max(MIN_EVERY_DAYS, Math.round(p?.everyDays ?? EMPTY_PLAN.everyDays) || EMPTY_PLAN.everyDays)),
    time: retiredDemo ? "" : /^\d{2}:\d{2}$/.test(p?.time ?? "") ? p!.time! : "",
    lastRunAt: !retiredDemo && typeof p?.lastRunAt === "number" && Number.isFinite(p.lastRunAt) ? p.lastRunAt : null,
    runs: retiredDemo ? 0 : Math.max(0, Math.round(p?.runs ?? 0)),
    lastError: !retiredDemo && typeof p?.lastError === "string" ? p.lastError.slice(0, 300) : null,
  };
};

export const newChannelId = (): string => `ch_${randomBytes(4).toString("hex")}`;

function fileFor(): string {
  return path.join(config.dataDir, "youtube", "channels.json");
}

function readStore(): ChannelStore {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as Partial<ChannelStore>;
    const rows = (Array.isArray(raw.channels) ? raw.channels : []).filter((c): c is ChannelRecord => Boolean(c?.id && typeof c.refreshToken === "string"));
    let migratedLegacyDemo = false;
    const channels = rows.map((channel) => {
      const storedPlan = channel.plan as StoredChannelPlan | undefined;
      if (storedPlan?.kind === "demo") migratedLegacyDemo = true;
      return { ...channel, plan: normal(storedPlan) };
    });
    const store = { channels, defaultId: typeof raw.defaultId === "string" ? raw.defaultId : (channels[0]?.id ?? null) };
    if (migratedLegacyDemo) writeStore(store);
    return store;
  } catch {
    return { channels: [], defaultId: null };
  }
}

function writeStore(store: ChannelStore): void {
  const file = fileFor();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[youtube] could not save the channel list: ${(err as Error).message}`);
  }
}

/** The connection the app had before channels existed, as a channel record. */
function legacyRecord(): ChannelRecord | null {
  const cfg: YouTubeConfig = youtubeService.getConfig();
  const token = (cfg.refreshToken ?? "").trim();
  if (!token) return null;
  return {
    id: LEGACY_CHANNEL_ID,
    name: cfg.channelTitle?.trim() || "My YouTube channel",
    channelId: cfg.channelId ?? null,
    refreshToken: token,
    ...(cfg.clientSource ? { clientSource: cfg.clientSource } : {}),
    ...(cfg.connectedClientId ? { connectedClientId: cfg.connectedClientId } : {}),
    privacy: cfg.defaultPrivacy ?? "public",
    autoPublish: cfg.autoPublish === true,
    addedAt: Date.now(),
    lastUploadAt: null,
    lastVideoUrl: null,
    plan: { ...EMPTY_PLAN },
  };
}

/** Every connected channel, oldest first (the existing connection becomes the first one). */
export function listChannels(): ChannelRecord[] {
  const store = readStore();
  const legacy = legacyRecord();
  if (legacy && !store.channels.some((c) => c.id === LEGACY_CHANNEL_ID || c.refreshToken === legacy.refreshToken)) {
    store.channels.unshift(legacy);
    if (!store.defaultId) store.defaultId = legacy.id;
    writeStore(store);
  }
  return store.channels.map((c) => ({ ...c, plan: normal(c.plan) }));
}

export function defaultChannelId(): string | null {
  const store = readStore();
  const channels = listChannels();
  if (!channels.length) return null;
  return channels.some((c) => c.id === store.defaultId) ? store.defaultId : channels[0]!.id;
}

/** Find a channel by id, real channel id, or the name the person gave it. */
export function channelFor(idOrName?: string | null): ChannelRecord | null {
  const channels = listChannels();
  if (!channels.length) return null;
  const wanted = (idOrName ?? "").trim().toLowerCase();
  if (!wanted) return channels.find((c) => c.id === defaultChannelId()) ?? channels[0]!;
  return (
    channels.find((c) => c.id === wanted) ??
    channels.find((c) => (c.channelId ?? "").toLowerCase() === wanted) ??
    channels.find((c) => c.name.toLowerCase() === wanted) ??
    // A loose name still finds a channel when the user gives only part of its name.
    channels.find((c) => c.name.toLowerCase().includes(wanted)) ??
    null
  );
}

export function isDefaultChannel(id: string): boolean {
  return defaultChannelId() === id;
}

export function setDefaultChannel(id: string): boolean {
  const store = readStore();
  const channel = listChannels().find((c) => c.id === id);
  if (!channel) return false;
  store.defaultId = channel.id;
  writeStore(store);
  return true;
}

/** The store with the app's original single connection materialized as a channel. */
function storeWithLegacy(): ChannelStore {
  listChannels();
  return readStore();
}

export function updateChannel(id: string, patch: { name?: string; plan?: Partial<ChannelPlan>; privacy?: ChannelRecord["privacy"]; autoPublish?: boolean }): ChannelRecord | null {
  const store = storeWithLegacy();
  const channel = store.channels.find((c) => c.id === id);
  if (!channel) return null;
  if (patch.name !== undefined) channel.name = patch.name.trim().slice(0, 80) || channel.name;
  if (patch.privacy) channel.privacy = patch.privacy;
  if (patch.autoPublish !== undefined) channel.autoPublish = patch.autoPublish;
  if (patch.plan) channel.plan = normal({ ...channel.plan, ...patch.plan });
  writeStore(store);
  return channel;
}

export function removeChannel(id: string): boolean {
  const store = storeWithLegacy();
  const before = store.channels.length;
  store.channels = store.channels.filter((c) => c.id !== id);
  if (store.channels.length === before) return false;
  if (store.defaultId === id) store.defaultId = store.channels[0]?.id ?? null;
  writeStore(store);
  // Removing the connection the app had before channels existed really disconnects it.
  if (id === LEGACY_CHANNEL_ID) {
    youtubeService.saveConfig({ refreshToken: "", channelTitle: undefined, channelId: undefined });
  }
  return true;
}

/** A new sign-in finished: add it, or refresh the channel it already belongs to. */
export function registerChannel(connected: { refreshToken: string; channelTitle?: string | null; channelId?: string | null; clientSource?: "own" | "built-in"; connectedClientId?: string }): ChannelRecord {
  const next = storeWithLegacy();
  const existing =
    (connected.channelId && next.channels.find((c) => c.channelId && c.channelId === connected.channelId)) ||
    next.channels.find((c) => c.refreshToken === connected.refreshToken);
  if (existing) {
    existing.refreshToken = connected.refreshToken;
    if (connected.channelId) existing.channelId = connected.channelId;
    if (connected.channelTitle) existing.name = connected.channelTitle;
    if (connected.clientSource) existing.clientSource = connected.clientSource;
    if (connected.connectedClientId) existing.connectedClientId = connected.connectedClientId;
    writeStore(next);
    return existing;
  }
  const record: ChannelRecord = {
    id: newChannelId(),
    name: connected.channelTitle?.trim() || "New channel",
    channelId: connected.channelId ?? null,
    refreshToken: connected.refreshToken,
    ...(connected.clientSource ? { clientSource: connected.clientSource } : {}),
    ...(connected.connectedClientId ? { connectedClientId: connected.connectedClientId } : {}),
    privacy: "public",
    autoPublish: false,
    addedAt: Date.now(),
    lastUploadAt: null,
    lastVideoUrl: null,
    plan: { ...EMPTY_PLAN },
  };
  next.channels.push(record);
  if (!next.defaultId) next.defaultId = record.id;
  writeStore(next);
  return record;
}

export function noteChannelUpload(id: string, videoUrl: string): void {
  const store = storeWithLegacy();
  const channel = store.channels.find((c) => c.id === id);
  if (!channel) return;
  channel.lastUploadAt = Date.now();
  channel.lastVideoUrl = videoUrl;
  channel.plan.lastError = null;
  writeStore(store);
}

export function noteChannelError(id: string, message: string): void {
  const store = storeWithLegacy();
  const channel = store.channels.find((c) => c.id === id);
  if (!channel) return;
  channel.plan.lastError = message.slice(0, 300);
  writeStore(store);
}

// ── Tokens: one sign-in per channel, one OAuth client for all of them ───────

interface CachedToken {
  token: string;
  expiry: number;
}

const tokens = new Map<string, CachedToken>();

/**
 * A usable access token for this channel's own sign-in. Throws with something
 * the person can act on (that channel needs connecting again).
 */
export async function accessTokenFor(channel: ChannelRecord): Promise<string> {
  const cached = tokens.get(channel.id);
  if (cached && cached.expiry > Date.now() + 60_000) return cached.token;
  const client = youtubeService.client();
  if (!client) {
    throw new Error("YouTube has no OAuth client in this build — connect a channel from Settings → YouTube & Shorts first.");
  }
  const res = await fetch(config.googleOAuthTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: channel.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`The sign-in for “${channel.name}” doesn't work any more (${body.error ?? `HTTP ${res.status}`}) — reconnect that channel in Settings → YouTube & Shorts.`);
  }
  tokens.set(channel.id, { token: body.access_token, expiry: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

/** What the app shows: names and plans, never the refresh tokens. */
export interface ChannelView {
  id: string;
  name: string;
  channelId: string | null;
  default: boolean;
  privacy: ChannelRecord["privacy"];
  autoPublish: boolean;
  addedAt: number;
  lastUploadAt: number | null;
  lastVideoUrl: string | null;
  plan: ChannelPlan & { due: boolean };
}

export function channelViews(now = new Date()): ChannelView[] {
  const defaultId = defaultChannelId();
  return listChannels().map((c) => ({
    id: c.id,
    name: c.name,
    channelId: c.channelId,
    default: c.id === defaultId,
    privacy: c.privacy,
    autoPublish: c.autoPublish,
    addedAt: c.addedAt,
    lastUploadAt: c.lastUploadAt,
    lastVideoUrl: c.lastVideoUrl,
    plan: { ...c.plan, due: planDue(c.plan, now) },
  }));
}

/** Is this channel's plan due for another video? */
export function planDue(plan: ChannelPlan, now = new Date()): boolean {
  if (!plan.auto || !plan.what.trim()) return false;
  if (plan.time) {
    const [h, m] = plan.time.split(":").map(Number);
    const due = new Date(now);
    due.setHours(h ?? 0, m ?? 0, 0, 0);
    if (now.getTime() < due.getTime()) return false;
  }
  if (!plan.lastRunAt) return true;
  return now.getTime() - plan.lastRunAt >= plan.everyDays * 86_400_000;
}

/** Mark a plan run (the planner uses this after it hands the video to the pipeline). */
export function notePlanRun(id: string, when = Date.now()): void {
  const store = storeWithLegacy();
  const channel = store.channels.find((c) => c.id === id);
  if (!channel) return;
  channel.plan.lastRunAt = when;
  channel.plan.runs += 1;
  channel.plan.lastError = null;
  writeStore(store);
}

export function resetChannelsForTests(): void {
  tokens.clear();
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}
