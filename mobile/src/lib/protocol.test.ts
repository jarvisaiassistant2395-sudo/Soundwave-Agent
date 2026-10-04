// npm test (vitest) — the phone side on its own. The PC ⇄ phone interop runs
// in server/tests/companion.test.ts against the real listener.
import { describe, expect, it } from "vitest";
import {
  aad,
  baseUrlFor,
  derivePairingKey,
  deriveDeviceKeys,
  formatPairingCode,
  frame,
  fromBase64,
  normalizePairingCode,
  open,
  parsePairingLink,
  parseTypedAddress,
  randomNonce,
  seal,
  toBase64,
  unframe,
} from "./protocol";
import { decodeRecord, encodeRecord } from "./client";

describe("pairing codes", () => {
  it("reads codes however they're typed", () => {
    expect(normalizePairingCode("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(normalizePairingCode(" ABCD EFGH JKMN ")).toBe("ABCDEFGHJKMN");
    expect(normalizePairingCode("0O1I-L234-5678")).toBe("001112345678");
    expect(normalizePairingCode("ABCD-EFGH-JKM")).toBeNull();
    expect(normalizePairingCode("ABCD-EFGH-JKMU")).toBeNull();
    expect(formatPairingCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
  });
});

describe("pairing links (the QR code)", () => {
  const link = "soundwave://pair?v=1&c=ABCDEFGHJKMN&i=pc_0123456789abcdef&n=DESKTOP-4F2K&p=47801&h=192.168.1.23%2C100.64.1.2";

  it("parses what the PC puts in the QR code", () => {
    expect(parsePairingLink(link)).toEqual({
      code: "ABCDEFGHJKMN",
      pcId: "pc_0123456789abcdef",
      pcName: "DESKTOP-4F2K",
      port: 47801,
      hosts: ["192.168.1.23", "100.64.1.2"],
    });
  });

  it("accepts full origins (a tunnel/VPN name) and drops junk hosts", () => {
    const l = parsePairingLink("soundwave://pair?c=ABCDEFGHJKMN&i=pc_0123456789abcdef&p=47800&h=https%3A%2F%2Fpc.example.ts.net,bad host,javascript:alert(1)");
    expect(l?.hosts).toEqual(["https://pc.example.ts.net"]);
    expect(baseUrlFor("https://pc.example.ts.net", 47800)).toBe("https://pc.example.ts.net");
    expect(baseUrlFor("192.168.1.23", 47800)).toBe("http://192.168.1.23:47800");
  });

  it("refuses anything that isn't a Soundwave pairing code", () => {
    expect(parsePairingLink("https://example.com")).toBeNull();
    expect(parsePairingLink("soundwave://pair?c=SHORT&i=pc_0123456789abcdef&h=1.2.3.4")).toBeNull();
    expect(parsePairingLink("soundwave://pair?c=ABCDEFGHJKMN&i=nope&h=1.2.3.4")).toBeNull();
    expect(parsePairingLink("soundwave://pair?c=ABCDEFGHJKMN&i=pc_0123456789abcdef")).toBeNull();
  });

  it("reads a typed PC address", () => {
    expect(parseTypedAddress("192.168.1.23")).toEqual({ host: "192.168.1.23", port: 47800 });
    expect(parseTypedAddress(" 192.168.1.23:47805 ")).toEqual({ host: "192.168.1.23", port: 47805 });
    expect(parseTypedAddress("my-pc.local")).toEqual({ host: "my-pc.local", port: 47800 });
    expect(parseTypedAddress("192.168.1.23:99999")).toBeNull();
    expect(parseTypedAddress("not a host")).toBeNull();
  });
});

describe("envelopes", () => {
  it("round-trips a framed message with a payload", async () => {
    const keys = await deriveDeviceKeys(new Uint8Array(32).fill(3), "d_1");
    const ad = aad("rpc", "c2s", "d_1");
    const env = await seal(keys.c2s, frame({ op: "send", n: randomNonce() }, new Uint8Array([9, 8, 7])), ad);
    expect(env[0]).toBe(1);
    const { header, payload } = unframe(await open(keys.c2s, env, ad));
    expect(header.op).toBe("send");
    expect([...payload]).toEqual([9, 8, 7]);
    await expect(open(keys.s2c, env, ad)).rejects.toThrow();
    await expect(open(keys.c2s, env, aad("rpc", "c2s", "d_2"))).rejects.toThrow();
  });

  it("derives the pairing key from the code (same code + PC → same key)", async () => {
    const a = await derivePairingKey("ABCDEFGHJKMN", "pc_0123456789abcdef");
    const b = await derivePairingKey("ABCDEFGHJKMN", "pc_0123456789abcdef");
    const ad = aad("pair", "c2s", "pc_0123456789abcdef");
    const env = await seal(a, new TextEncoder().encode("hi"), ad);
    expect(new TextDecoder().decode(await open(b, env, ad))).toBe("hi");
    const other = await derivePairingKey("ABCDEFGHJKMP", "pc_0123456789abcdef");
    await expect(open(other, env, ad)).rejects.toThrow();
  });

  it("base64 and nonces", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(60_000));
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(randomNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomNonce()).not.toBe(randomNonce());
  });
});

describe("the stored pairing", () => {
  it("round-trips and rejects junk", () => {
    const r = { pcId: "pc_0123456789abcdef", pcName: "PC", deviceId: "d_1", deviceKey: "AAAA", hosts: ["192.168.1.2"], port: 47800, pairedAt: "2026-01-01T00:00:00Z" };
    expect(decodeRecord(encodeRecord(r))).toEqual(r);
    expect(decodeRecord("{}")).toBeNull();
    expect(decodeRecord("not json")).toBeNull();
    expect(decodeRecord(null)).toBeNull();
  });
});
