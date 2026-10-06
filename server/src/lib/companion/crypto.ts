// ── Phone companion: the encrypted channel (PC side) ────────────────────────
// Mirrored byte-for-byte by the phone app (mobile/src/lib/protocol.ts, Web
// Crypto); tests/companion.test.ts runs the two against each other.
//
// Pairing: the PC shows a one-time code (in a QR code and as text). Both
// sides derive an AES-256 key from it with PBKDF2-SHA256; the code itself
// never crosses the network. The phone's pairing request and the PC's answer
// (which hands the phone its own random 256-bit device key) are sealed with
// that key.
//
// After pairing, every request/response is sealed with a per-direction key
// derived from the device key (HKDF-SHA256), with AES-256-GCM:
//
//   envelope  = 0x01 ‖ iv (12 random bytes) ‖ ciphertext ‖ tag (16)
//   plaintext = u32be(len(header)) ‖ header (UTF-8 JSON) ‖ payload bytes
//   AAD       = "sw1|<channel>|<direction>|<id>[|<request nonce>]"
//
// Requests carry a timestamp and a random nonce (replays are refused);
// responses are bound to the request's nonce through their AAD.

import crypto from "node:crypto";

export const ENVELOPE_VERSION = 1;
export const PAIR_ITERATIONS = 150_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Crockford base32: no I, L, O, U — easy to read aloud and to type.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 12; // 60 bits

export function generatePairingCode(): string {
  const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i]! & 31];
  return out;
}

/** "abcd-efgh-jkmn" / "ABCD EFGH JKMN" → "ABCDEFGHJKMN" (Crockford: I/L → 1, O → 0), or null. */
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

export function derivePairingKey(code: string, pcId: string): Buffer {
  return crypto.pbkdf2Sync(Buffer.from(code, "utf8"), Buffer.from(`soundwave-pair-v1|${pcId}`, "utf8"), PAIR_ITERATIONS, 32, "sha256");
}

export function deriveDeviceKeys(deviceKey: Buffer, deviceId: string): { c2s: Buffer; s2c: Buffer } {
  const salt = Buffer.from("soundwave-companion-v1", "utf8");
  const derive = (dir: string) => Buffer.from(crypto.hkdfSync("sha256", deviceKey, salt, Buffer.from(`${dir}|${deviceId}`, "utf8"), 32));
  return { c2s: derive("c2s"), s2c: derive("s2c") };
}

export function aad(...parts: string[]): Buffer {
  return Buffer.from(["sw1", ...parts].join("|"), "utf8");
}

export function seal(key: Buffer, plaintext: Buffer, additionalData: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, body, cipher.getAuthTag()]);
}

export class EnvelopeError extends Error {}

/** Opens an envelope; throws EnvelopeError if it's malformed, from another key, or tampered with. */
export function open(key: Buffer, envelope: Buffer, additionalData: Buffer): Buffer {
  if (envelope.length < 1 + IV_BYTES + TAG_BYTES || envelope[0] !== ENVELOPE_VERSION) throw new EnvelopeError("bad envelope");
  const iv = envelope.subarray(1, 1 + IV_BYTES);
  const tag = envelope.subarray(envelope.length - TAG_BYTES);
  const body = envelope.subarray(1 + IV_BYTES, envelope.length - TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new EnvelopeError("could not decrypt");
  }
}

export function frame(header: unknown, payload?: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([len, json, payload ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength) : Buffer.alloc(0)]);
}

export function unframe(buf: Buffer): { header: Record<string, unknown>; payload: Buffer } {
  if (buf.length < 4) throw new EnvelopeError("short frame");
  const len = buf.readUInt32BE(0);
  if (len > buf.length - 4) throw new EnvelopeError("bad frame length");
  let header: unknown;
  try {
    header = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
  } catch {
    throw new EnvelopeError("bad frame header");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new EnvelopeError("bad frame header");
  return { header: header as Record<string, unknown>, payload: buf.subarray(4 + len) };
}

export function randomId(prefix: string, bytes = 8): string {
  return `${prefix}${crypto.randomBytes(bytes).toString("hex")}`;
}
