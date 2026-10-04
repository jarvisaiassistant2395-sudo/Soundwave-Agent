import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken, sha256, randomToken } from "../src/lib/auth.js";
import { PLANS, resolutionAllowed } from "../src/lib/plans.js";
import { buildAss } from "../src/lib/ffmpeg.js";

describe("passwords", () => {
  it("hashes with bcrypt and verifies", async () => {
    const hash = await hashPassword("Str0ng!Pass");
    expect(hash).not.toContain("Str0ng!Pass");
    expect(await verifyPassword("Str0ng!Pass", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});

describe("tokens", () => {
  it("round-trips access + refresh tokens", () => {
    const access = signAccessToken("user-1");
    const a = verifyAccessToken(access);
    expect(a?.sub).toBe("user-1");
    expect(a?.type).toBe("access");

    const refresh = signRefreshToken("user-1", "session-1");
    const r = verifyRefreshToken(refresh);
    expect(r?.sub).toBe("user-1");
    expect(r?.sid).toBe("session-1");
    expect(verifyAccessToken("garbage")).toBeNull();
  });

  it("generates random tokens and hashes", () => {
    const t = randomToken(24);
    expect(t.length).toBe(48);
    expect(sha256(t)).toHaveLength(64);
    expect(sha256(t)).toBe(sha256(t));
  });
});

describe("plans", () => {
  it("enforces resolution limits", () => {
    expect(resolutionAllowed("FREE", "720p")).toBe(true);
    expect(resolutionAllowed("FREE", "1080p")).toBe(false);
    expect(resolutionAllowed("PRO", "1080p")).toBe(true);
    expect(resolutionAllowed("PRO", "4K")).toBe(false);
    expect(resolutionAllowed("ENTERPRISE", "4K")).toBe(true);
  });

  it("has sensible quotas", () => {
    expect(PLANS.FREE.characterLimit).toBe(10_000);
    expect(PLANS.PRO.characterLimit).toBe(200_000);
    expect(PLANS.ENTERPRISE.characterLimit).toBe(2_000_000);
  });
});

describe("voice-clone helpers", () => {
  it("estimates word timings that cover the duration in order", async () => {
    const { estimateWordTimings } = await import("../src/lib/voiceclone.js");
    const t = estimateWordTimings("Hello there brave new world", 2.5);
    expect(t).toHaveLength(5);
    expect(t[0]!.start).toBe(0);
    expect(t[t.length - 1]!.end).toBeGreaterThan(2);
    for (let i = 1; i < t.length; i++) expect(t[i]!.start).toBeGreaterThanOrEqual(t[i - 1]!.end);
    expect(estimateWordTimings("", 2)).toEqual([]);
    expect(estimateWordTimings("hello", 0)).toEqual([]);
  });

  it("sniffs common audio containers", async () => {
    const { sniffAudio } = await import("../src/lib/voiceclone.js");
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)]);
    const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]); // ID3
    const mpeg = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]);
    const ogg = Buffer.from("OggS00000000", "latin1");
    expect(sniffAudio(wav)).toBe(true);
    expect(sniffAudio(mp3)).toBe(true);
    expect(sniffAudio(mpeg)).toBe(true);
    expect(sniffAudio(ogg)).toBe(true);
    expect(sniffAudio(Buffer.from("%PDF-1.7.xxx", "latin1"))).toBe(false);
    expect(sniffAudio(Buffer.alloc(4))).toBe(false);
  });
});

describe("config", () => {
  it("defaults new accounts to FREE unless DEFAULT_SIGNUP_PLAN is set", async () => {
    // Guard for the local-testing switch: the shipped default must stay FREE
    // (env is unset in the test environment, mirroring a fresh .env.example).
    const { config } = await import("../src/config.js");
    expect(config.defaultSignupPlan).toBe("FREE");
  });
});

describe("ffmpeg filter path escaping", () => {
  it("quotes paths and escapes drive colons (Windows) and backslashes", async () => {
    const { ffmpegFilterPath } = await import("../src/lib/ffmpeg.js");
    expect(ffmpegFilterPath(String.raw`C:\Users\A B\tmp\file.ass`)).toBe("'C\\:/Users/A B/tmp/file.ass'");
    expect(ffmpegFilterPath("/home/user/jobs/x.ass")).toBe("'/home/user/jobs/x.ass'");
    expect(ffmpegFilterPath(String.raw`D:\we\i'rd\y.ass`)).toBe("'D\\:/we/i\\'rd/y.ass'");
  });
});

describe("ASS subtitle generation", () => {
  it("produces a valid ASS document with styles and events", () => {
    const ass = buildAss(
      [{ start: 1, end: 3, text: "Hello world" }],
      { fontFamily: "Inter", fontSize: 44, color: "#FFFFFF", hAlign: "center", vAlign: "bottom", strokeEnabled: true, strokeWidth: 2 },
      1920,
      1080,
      true,
    );
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("Style: Default");
    expect(ass).toContain("Style: Watermark");
    expect(ass).toContain("Dialogue: 0,0:00:01.00,0:00:03.00");
    expect(ass).toContain("Hello world");
    expect(ass).toContain("Soundwave AI"); // watermark
  });

  it("escapes ASS tag injection", () => {
    const ass = buildAss([{ start: 0, end: 1, text: "evil {\\pos(0,0)} text" }], {}, 1280, 720);
    expect(ass).not.toContain("{\\pos(0,0)}");
  });
});
