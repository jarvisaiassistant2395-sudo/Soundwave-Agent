// ── The encrypted channel to the PC (phone side, Web Crypto) ────────────────
// Byte-for-byte the same as server/src/lib/companion/crypto.ts — the server's
// tests run this file against the real PC listener.
//
//   pairing key  = PBKDF2-SHA256(code, "soundwave-pair-v1|<pcId>", 150 000 rounds)
//   device keys  = HKDF-SHA256(deviceKey, "soundwave-companion-v1", "c2s|<id>" / "s2c|<id>")
//   envelope     = 0x01 ‖ iv (12) ‖ AES-256-GCM(ciphertext ‖ tag)
//   plaintext    = u32be(len(header)) ‖ header JSON ‖ payload bytes
//   AAD          = "sw1|<channel>|<direction>|<id>[|<request nonce>]"

const te = new TextEncoder();
const td = new TextDecoder();

export const ENVELOPE_VERSION = 1;
export const PAIR_ITERATIONS = 150_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 12;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("This device can't do secure encryption (Web Crypto is missing).");
  return s;
}

// ── Pairing codes and links ─────────────────────────────────────────────────

/** "abcd-efgh-jkmn" → "ABCDEFGHJKMN" (Crockford base32: I/L → 1, O → 0), or null. */
export function normalizePairingCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function formatPairingCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

export interface PairingLink {
  code: string;
  pcId: string;
  pcName: string;
  port: number;
  /** Where to find the PC: IPv4 addresses (or full http(s) origins). */
  hosts: string[];
}

export const DEFAULT_PORT = 47800;

/** soundwave://pair?v=1&c=CODE&i=pc_…&n=NAME&p=47800&h=192.168.1.5,100.64.0.2 → PairingLink, or null. */
export function parsePairingLink(text: string): PairingLink | null {
  const trimmed = text.trim();
  const m = /^soundwave:\/\/pair\/?\?(.*)$/i.exec(trimmed);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const code = normalizePairingCode(q.get("c") ?? "");
  const pcId = q.get("i") ?? "";
  const port = Number.parseInt(q.get("p") ?? "", 10);
  const hosts = (q.get("h") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => isValidHost(h));
  if (!code || !/^pc_[0-9a-f]{16}$/.test(pcId) || !hosts.length) return null;
  return {
    code,
    pcId,
    pcName: (q.get("n") ?? "").slice(0, 80) || "Your PC",
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    hosts: hosts.slice(0, 8),
  };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isIPv4(host: string): boolean {
  return IPV4.test(host);
}

/** An address the user may type or a pairing link may carry. */
export function isValidHost(host: string): boolean {
  if (!host || host.length > 200) return false;
  if (/^https?:\/\/[^\s/?#]+\/?$/i.test(host)) return true;
  if (IPV4.test(host)) return true;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
}

/** "192.168.1.5" + 47800 → "http://192.168.1.5:47800"; full origins pass through. */
export function baseUrlFor(host: string, port: number): string {
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, "");
  return `http://${host}:${port}`;
}

/** "192.168.1.23:47800" / "192.168.1.23" (typed by hand) → { host, port }. */
export function parseTypedAddress(input: string): { host: string; port: number } | null {
  const t = input.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(t)) return isValidHost(t) ? { host: t, port: DEFAULT_PORT } : null;
  const m = /^([^:\s]+)(?::(\d{1,5}))?$/.exec(t);
  if (!m || !isValidHost(m[1]!)) return null;
  const port = m[2] ? Number(m[2]) : DEFAULT_PORT;
  return port > 0 && port < 65536 ? { host: m[1]!, port } : null;
}

// ── Keys ────────────────────────────────────────────────────────────────────

export async function derivePairingKey(code: string, pcId: string): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", te.encode(code), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: te.encode(`soundwave-pair-v1|${pcId}`), iterations: PAIR_ITERATIONS },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveDeviceKeys(deviceKey: Uint8Array, deviceId: string): Promise<{ c2s: CryptoKey; s2c: CryptoKey }> {
  const base = await subtle().importKey("raw", deviceKey, "HKDF", false, ["deriveKey"]);
  const derive = (dir: string) =>
    subtle().deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: te.encode("soundwave-companion-v1"), info: te.encode(`${dir}|${deviceId}`) },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  const [c2s, s2c] = await Promise.all([derive("c2s"), derive("s2c")]);
  return { c2s, s2c };
}

// ── Envelopes ───────────────────────────────────────────────────────────────

export function aad(...parts: string[]): Uint8Array {
  return te.encode(["sw1", ...parts].join("|"));
}

export async function seal(key: CryptoKey, plaintext: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, plaintext));
  const out = new Uint8Array(1 + IV_BYTES + body.length);
  out[0] = ENVELOPE_VERSION;
  out.set(iv, 1);
  out.set(body, 1 + IV_BYTES);
  return out;
}

export class EnvelopeError extends Error {}

export async function open(key: CryptoKey, envelope: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array> {
  if (envelope.length < 1 + IV_BYTES + TAG_BYTES || envelope[0] !== ENVELOPE_VERSION) throw new EnvelopeError("bad envelope");
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: "AES-GCM", iv: envelope.subarray(1, 1 + IV_BYTES), additionalData, tagLength: 128 },
        key,
        envelope.subarray(1 + IV_BYTES),
      ),
    );
  } catch {
    throw new EnvelopeError("could not decrypt");
  }
}

export function frame(header: unknown, payload?: Uint8Array): Uint8Array {
  const json = te.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + (payload?.length ?? 0));
  new DataView(out.buffer).setUint32(0, json.length, false);
  out.set(json, 4);
  if (payload) out.set(payload, 4 + json.length);
  return out;
}

export function unframe(buf: Uint8Array): { header: Record<string, unknown>; payload: Uint8Array } {
  if (buf.length < 4) throw new EnvelopeError("short frame");
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
  if (len > buf.length - 4) throw new EnvelopeError("bad frame length");
  const header = JSON.parse(td.decode(buf.subarray(4, 4 + len))) as unknown;
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new EnvelopeError("bad frame header");
  return { header: header as Record<string, unknown>, payload: buf.subarray(4 + len) };
}

export function randomNonce(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
