// ── Phone companion: state, pairing and paired phones (PC side) ─────────────
// Settings → Phone in the desktop app drives this through routes/companion.ts
// (loopback only). The LAN listener the phone talks to is lib/companion/listener.ts.
//
// companion.json (in DATA_DIR, owner-only permissions):
//   { enabled, shareBrain, pcId, port, devices: [{ id, name, key (base64 device key), … }] }
//   shareBrain: paired phones get the Gemini key + the memory, so they can chat
//   while the PC is off ("Chat from the phone when this PC is off", default on).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../../config.js";
import { derivePairingKey, formatPairingCode, generatePairingCode, randomId } from "./crypto.js";

export interface CompanionDevice {
  id: string;
  name: string;
  platform: string;
  model?: string;
  appVersion?: string;
  /** 32-byte device key, base64. */
  key: string;
  pairedAt: string;
  lastSeenAt: string | null;
  lastAddress: string | null;
}

interface CompanionState {
  version: 1;
  enabled: boolean;
  shareBrain: boolean;
  pcId: string;
  port: number | null;
  devices: CompanionDevice[];
}

export interface PairingSession {
  code: string;
  key: Buffer;
  pcId: string;
  createdAt: number;
  expiresAt: number;
  failures: number;
}

export const PAIRING_TTL_MS = 10 * 60_000;
const MAX_PAIRING_FAILURES = 20;
/** A phone that asked something this recently counts as connected (it long-polls every ≤ 20 s). */
const ONLINE_WINDOW_MS = 45_000;

let state: CompanionState | null = null;
let stateFile = "";
let pairing: PairingSession | null = null;
let lastPersistAt = 0;
/** The latest pairing that succeeded (Settings → Phone says "Paired with …"). */
let lastPaired: { deviceId: string; name: string; at: number } | null = null;

function fileFor(): string {
  return path.join(config.dataDir, "companion.json");
}

export function loadState(): CompanionState {
  const file = fileFor();
  if (state && stateFile === file) return state;
  stateFile = file;
  let raw: Partial<CompanionState> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CompanionState>;
  } catch {
    /* first run */
  }
  state = {
    version: 1,
    enabled: raw.enabled === true,
    shareBrain: raw.shareBrain !== false,
    pcId: typeof raw.pcId === "string" && /^pc_[0-9a-f]{16}$/.test(raw.pcId) ? raw.pcId : randomId("pc_"),
    port: typeof raw.port === "number" && raw.port > 0 && raw.port < 65536 ? raw.port : null,
    devices: Array.isArray(raw.devices)
      ? raw.devices.filter((d): d is CompanionDevice => Boolean(d && typeof d.id === "string" && typeof d.key === "string" && typeof d.name === "string"))
      : [],
  };
  if (!raw.pcId) saveState();
  return state;
}

export function saveState(): void {
  const s = loadState();
  const file = fileFor();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    lastPersistAt = Date.now();
  } catch (err) {
    console.warn(`[companion] could not save ${file}: ${(err as Error).message}`);
  }
}

export function pcName(): string {
  return os.hostname() || "Your PC";
}

// ── Pairing ─────────────────────────────────────────────────────────────────

export function startPairing(): PairingSession {
  const s = loadState();
  const code = generatePairingCode();
  const now = Date.now();
  pairing = { code, key: derivePairingKey(code, s.pcId), pcId: s.pcId, createdAt: now, expiresAt: now + PAIRING_TTL_MS, failures: 0 };
  return pairing;
}

export function activePairing(): PairingSession | null {
  if (pairing && Date.now() > pairing.expiresAt) pairing = null;
  return pairing;
}

export function cancelPairing(): void {
  pairing = null;
}

/** A pairing request that didn't decrypt (wrong/old code). Too many → the code is retired. */
export function notePairingFailure(): void {
  if (!pairing) return;
  pairing.failures += 1;
  if (pairing.failures >= MAX_PAIRING_FAILURES) pairing = null;
}

export function completePairing(info: { name: string; platform: string; model?: string; appVersion?: string; address: string | null }): {
  device: CompanionDevice;
  deviceKey: Buffer;
} {
  const s = loadState();
  const deviceKey = crypto.randomBytes(32);
  const now = new Date().toISOString();
  const device: CompanionDevice = {
    id: randomId("d_"),
    name: info.name.slice(0, 60) || "Phone",
    platform: info.platform.slice(0, 20) || "android",
    ...(info.model ? { model: info.model.slice(0, 80) } : {}),
    ...(info.appVersion ? { appVersion: info.appVersion.slice(0, 20) } : {}),
    key: deviceKey.toString("base64"),
    pairedAt: now,
    lastSeenAt: now,
    lastAddress: info.address,
  };
  s.devices.push(device);
  pairing = null; // one code, one phone
  lastPaired = { deviceId: device.id, name: device.name, at: Date.now() };
  saveState();
  return { device, deviceKey };
}

// ── Paired phones ───────────────────────────────────────────────────────────

/** Every paired phone (whether or not it's reachable right now). */
export function pairedPhones(): CompanionDevice[] {
  return loadState().devices;
}

/**
 * A paired phone that asked something in the last ~45 s (it long-polls every
 * ≤20 s, so this is what "connected" means) — the one an alarm can be set on
 * right away. Null when no phone is paired or none is answering.
 */
export function connectedPhone(now = Date.now()): CompanionDevice | null {
  const phones = loadState().devices;
  return phones.find((d) => d.lastSeenAt && now - Date.parse(d.lastSeenAt) < ONLINE_WINDOW_MS) ?? null;
}

export function findDevice(id: string): CompanionDevice | null {
  return loadState().devices.find((d) => d.id === id) ?? null;
}

export function removeDevice(id: string): boolean {
  const s = loadState();
  const before = s.devices.length;
  s.devices = s.devices.filter((d) => d.id !== id);
  if (s.devices.length === before) return false;
  saveState();
  return true;
}

/** Called for every authenticated request (saved to disk at most every 30 s). */
export function touchDevice(device: CompanionDevice, address: string | null): void {
  device.lastSeenAt = new Date().toISOString();
  if (address) device.lastAddress = address;
  if (Date.now() - lastPersistAt > 30_000) saveState();
}

export function setEnabledFlag(enabled: boolean): void {
  const s = loadState();
  s.enabled = enabled;
  if (!enabled) pairing = null;
  saveState();
}

export function setShareBrainFlag(share: boolean): void {
  const s = loadState();
  s.shareBrain = share;
  saveState();
}

export function setPort(port: number): void {
  const s = loadState();
  if (s.port === port) return;
  s.port = port;
  saveState();
}

// ── Network addresses the phone can use ─────────────────────────────────────

export interface LocalAddress {
  address: string;
  /** Adapter name (e.g. "Wi-Fi", "Ethernet", "Tailscale"). */
  name: string;
  kind: "lan" | "vpn" | "other";
}

const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vbox|virbr|^br-|^veth|Loopback|ZeroTier One Virtual|Npcap/i;

function isPrivateLan(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isCgnat(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 100 && b >= 64 && b <= 127; // Tailscale and other overlay VPNs
}

/**
 * Addresses for the pairing code: any set in COMPANION_HOSTS first (someone
 * chose them on purpose — the code holds at most six), then this PC's own.
 */
export function pairingAddresses(): LocalAddress[] {
  const extra = config.companionHosts.map((h) => ({ address: h, name: "configured", kind: "other" as const }));
  return [...extra, ...localAddresses().filter((a) => !config.companionHosts.includes(a.address))];
}

/** IPv4 addresses of this PC, best first: Wi-Fi/Ethernet, then VPNs (Tailscale), then the rest. */
export function localAddresses(interfaces = os.networkInterfaces()): LocalAddress[] {
  const out: Array<LocalAddress & { rank: number }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const e of entries ?? []) {
      if (e.family !== "IPv4" || e.internal) continue;
      if (e.address.startsWith("169.254.")) continue; // no DHCP answer — unreachable
      const virtual = VIRTUAL_ADAPTER.test(name);
      const kind: LocalAddress["kind"] = isPrivateLan(e.address) ? "lan" : isCgnat(e.address) || /tailscale|zerotier|wireguard|vpn/i.test(name) ? "vpn" : "other";
      const rank = (virtual ? 10 : 0) + (kind === "lan" ? 0 : kind === "vpn" ? 1 : 2);
      out.push({ address: e.address, name, kind, rank });
    }
  }
  return out.sort((x, y) => x.rank - y.rank).map(({ rank: _rank, ...a }) => a);
}

/** soundwave://pair?… — what the QR code holds (the app also accepts it typed in by hand). */
export function pairingLink(session: PairingSession, port: number, addresses: LocalAddress[]): string {
  const params = new URLSearchParams({
    v: "1",
    c: session.code,
    i: session.pcId,
    n: pcName(),
    p: String(port),
    h: addresses.map((a) => a.address).slice(0, 6).join(","),
  });
  return `soundwave://pair?${params.toString()}`;
}

// ── Status for Settings → Phone ─────────────────────────────────────────────

export interface CompanionStatus {
  available: boolean;
  enabled: boolean;
  /** Phones may chat with Gemini themselves while the PC is off (they get the key and the memory). */
  shareBrain: boolean;
  listening: boolean;
  port: number | null;
  error: string | null;
  pcName: string;
  pcId: string;
  addresses: LocalAddress[];
  devices: Array<Omit<CompanionDevice, "key"> & { online: boolean }>;
  pairing: { code: string; link: string; expiresAt: string } | null;
  lastPaired: { deviceId: string; name: string; at: string } | null;
}

export function buildStatus(listener: { listening: boolean; port: number | null; error: string | null }): CompanionStatus {
  const s = loadState();
  const addresses = pairingAddresses();
  const session = listener.listening ? activePairing() : null;
  const now = Date.now();
  return {
    available: config.companionAvailable,
    enabled: s.enabled,
    shareBrain: s.shareBrain,
    listening: listener.listening,
    port: listener.port,
    error: listener.error,
    pcName: pcName(),
    pcId: s.pcId,
    addresses,
    devices: s.devices.map(({ key: _key, ...d }) => ({
      ...d,
      online: Boolean(d.lastSeenAt && now - Date.parse(d.lastSeenAt) < ONLINE_WINDOW_MS),
    })),
    pairing:
      session && listener.port
        ? { code: formatPairingCode(session.code), link: pairingLink(session, listener.port, addresses), expiresAt: new Date(session.expiresAt).toISOString() }
        : null,
    lastPaired: lastPaired ? { ...lastPaired, at: new Date(lastPaired.at).toISOString() } : null,
  };
}

/** Tests: forget in-memory state (the data dir is wiped between tests). */
export function resetCompanionStateForTests(): void {
  state = null;
  stateFile = "";
  pairing = null;
  lastPaired = null;
  lastPersistAt = 0;
}
