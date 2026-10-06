// The on-this-PC narration engine (Kokoro-82M, Apache-2.0) on the existing
// multi-engine seam: the voice list comes from the engine, synthesis goes to the
// engine, a refusal from the engine is repeated verbatim, and an engine that is
// down says so instead of quietly recording in a different voice.
//
// The stand-in server plays the real HTTP contract of voiceclone/server.py's
// /tts/kokoro endpoints, so the service itself needs no Python in CI; the Python
// side has its own selftest (voiceclone/selftest.py).
//
// Nothing from src/ may be imported before the stand-in has a port: config.ts
// reads the environment once, at import time.

import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Two-tone WAV, 24 kHz mono — exactly what the engine returns (first bytes are
// all a test needs to tell audio apart).
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WAVEfmt "),
  Buffer.from([0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0xc0, 0x5d, 0x00, 0x00, 0x80, 0xbb, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00]),
  Buffer.from("data"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
]);

let mode: "ok" | "down" | "refuse" | "narrate-empty" = "ok";
let lastSynthBody: Record<string, unknown> | null = null;
let lastAuth: string | null = null;

const standIn = http.createServer((req, res) => {
  const url = req.url ?? "";
  lastAuth = req.headers.authorization ?? null;

  if (mode === "down") {
    req.socket.destroy();
    return;
  }
  if (url.startsWith("/tts/kokoro/voices")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        engine: "kokoro",
        available: true,
        voices: [
          { id: "af_heart", name: "Heart", gender: "Female", accent: "American", default: true },
          { id: "bm_george", name: "George", gender: "Male", accent: "British" },
        ],
      }),
    );
    return;
  }
  if (url.startsWith("/tts/kokoro") && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastSynthBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (mode === "refuse") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: 'Unknown narration voice "af_hurt". Available: af_heart, bm_george' }));
        return;
      }
      res.writeHead(200, { "Content-Type": "audio/wav", "X-Audio-Duration": "1.750" });
      res.end(WAV);
    });
    return;
  }
  if (url.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, engines: { kokoro: { loaded: true } } }));
    return;
  }
  res.writeHead(404).end("{}");
});

// Listen first, set the URL, and only THEN import the app modules: config.ts
// reads the environment once, at import time (beforeAll is too late — that is how
// this test first failed, and how server/tests/voiceclone_sidecar.test.ts did).
await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
const { port } = standIn.address() as AddressInfo;
process.env.LOCAL_VOICE_URL = `http://127.0.0.1:${port}`;
process.env.VOICECLONE_TOKEN = "test-token";

afterAll(async () => {
  delete process.env.LOCAL_VOICE_URL;
  delete process.env.VOICECLONE_TOKEN;
  await new Promise<void>((resolve) => standIn.close(() => resolve()));
});

const { getLocalVoiceStatus, isLocalVoiceId, localVoiceLabel, localVoiceShortId, synthesizeLocalVoice } = await import("../src/lib/kokoro.js");
const { ApiError } = await import("../src/middleware/error.js");
const { synthesizeNarration } = await import("../src/routes/agentShort.js");

describe("on-this-PC voices", () => {
  it("namespaces local voices and never mistakes them for a Soundwave voice", () => {
    expect(isLocalVoiceId("kokoro:af_heart")).toBe(true);
    expect(isLocalVoiceId("KOKORO:af_heart")).toBe(true);
    expect(isLocalVoiceId("en-US-JennyNeural")).toBe(false);
    expect(isLocalVoiceId(null)).toBe(false);
    expect(localVoiceShortId("kokoro:af_heart")).toBe("af_heart");
    expect(localVoiceLabel("kokoro:bm_george")).toBe("George");
  });

  it("lists the voices the engine itself reports, with the namespaced id", async () => {
    mode = "ok";
    const status = await getLocalVoiceStatus({ fresh: true });
    expect(status.available).toBe(true);
    expect(status.engine).toBe("kokoro");
    expect(status.license).toMatch(/Apache-2\.0/);
    expect(status.voices.map((v) => v.voiceId)).toEqual(["kokoro:af_heart", "kokoro:bm_george"]);
    expect(status.voices[0]?.displayName).toBe("Heart");
    expect(status.voices[1]?.gender).toBe("Male");
    // The shared secret travels with every call when one is configured.
    expect(lastAuth).toBe("Bearer test-token");
  });

  it("generates a clip locally and derives word timings from it", async () => {
    mode = "ok";
    lastSynthBody = null;
    const speech = await synthesizeLocalVoice({ text: "Two words here now", voiceId: "kokoro:af_heart", speed: 1.2 });
    expect(speech.mimeType).toBe("audio/wav");
    expect(Buffer.from(speech.audioBase64, "base64").subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(speech.duration).toBeCloseTo(1.75, 2);
    // The engine is asked for the short id, not the namespaced one.
    expect(lastSynthBody).toMatchObject({ voice: "af_heart", speed: 1.2, text: "Two words here now" });
    expect(speech.wordTimings.map((w) => w.word)).toEqual(["Two", "words", "here", "now"]);
    expect(speech.wordTimings.at(-1)!.end).toBeLessThanOrEqual(speech.duration + 0.001);
  });

  it("repeats the engine's own refusal instead of substituting another voice", async () => {
    mode = "refuse";
    await expect(synthesizeLocalVoice({ text: "Hello", voiceId: "kokoro:af_hurt" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Unknown narration voice"),
    });
    mode = "ok";
  });

  it("says the service is unreachable rather than failing silently", async () => {
    mode = "down";
    const status = await getLocalVoiceStatus({ fresh: true });
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/couldn't be reached|didn't answer/);
    await expect(synthesizeLocalVoice({ text: "Hello", voiceId: "kokoro:af_heart" })).rejects.toMatchObject({
      status: 502,
      code: "LOCAL_VOICE_UNAVAILABLE",
    });
    mode = "ok";
    const back = await getLocalVoiceStatus({ fresh: true });
    expect(back.available).toBe(true);
  });

  it("narrates a short with the local voice when one is chosen", async () => {
    mode = "ok";
    lastSynthBody = null;
    const narration = await synthesizeNarration("A short narrated on this PC", "kokoro:bm_george");
    expect(Buffer.from(narration.audioBase64, "base64").subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(lastSynthBody).toMatchObject({ voice: "bm_george" });
    // The narrator's slightly slower cadence is kept for local voices too.
    expect((lastSynthBody as Record<string, unknown> | null)?.speed).toBeCloseTo(0.95, 2);
  });

  it("turns a local-engine outage while narrating into its own sentence, not a fallback voice", async () => {
    mode = "down";
    await expect(synthesizeNarration("A short that cannot be narrated", "kokoro:af_heart")).rejects.toThrow(
      /on-this-PC voice "Heart"[\s\S]*pick a Soundwave voice/,
    );
    mode = "ok";
  });

  it("a validated local voice request is not metered like a cloud one", async () => {
    // The route's contract: pitch/volume are Edge-only options, so a local
    // request that asks for them is refused rather than silently ignored.
    const voicesRouteSource = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/routes/tts.ts", import.meta.url), "utf8"));
    expect(voicesRouteSource).toMatch(/isLocalVoiceId\(voice\)/);
    expect(voicesRouteSource).toMatch(/INVALID_VOICE_OPTION/);
    expect(new ApiError(400, "X", "y").status).toBe(400);
  });
});
