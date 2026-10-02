import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { WebSocketServer } from "ws";

// A stand-in for Microsoft's Read Aloud endpoint: it records the handshake and
// the two client messages, then answers in the service's framing (text frames
// with "Path:" headers, binary audio frames with a 2-byte header length).
type Behaviour = "ok" | "forbidden-once" | "close-early" | "silent" | "no-audio";

interface Seen {
  url: URL;
  headers: http.IncomingHttpHeaders;
  messages: string[];
}

let behaviour: Behaviour = "ok";
let forbiddenServed = false;
const seen: Seen[] = [];

const AUDIO_1 = Buffer.alloc(6000, 1); // 1.0 s at 48 kbps
const AUDIO_2 = Buffer.alloc(3000, 2); // 0.5 s

function audioFrame(payload: Buffer): Buffer {
  const header = Buffer.from("X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nX-StreamId:1\r\nPath:audio\r\n");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(header.length);
  return Buffer.concat([len, header, payload]);
}

function textFrame(path: string, body = "{}"): string {
  return `X-RequestId:abc\r\nContent-Type:application/json; charset=utf-8\r\nPath:${path}\r\n\r\n${body}`;
}

const WORDS = {
  Metadata: [
    { Type: "WordBoundary", Data: { Offset: 1_000_000, Duration: 4_000_000, text: { Text: "Hello", Length: 5, BoundaryType: "WordBoundary" } } },
    { Type: "WordBoundary", Data: { Offset: 6_000_000, Duration: 5_000_000, text: { Text: "creator", Length: 7, BoundaryType: "WordBoundary" } } },
  ],
};

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const record: Seen = { url: new URL(req.url ?? "/", "http://stand-in"), headers: req.headers, messages: [] };
  seen.push(record);
  if (behaviour === "forbidden-once" && !forbiddenServed) {
    forbiddenServed = true;
    const serverDate = new Date(Date.now() + 3_600_000).toUTCString(); // this "PC" is an hour behind
    socket.end(`HTTP/1.1 403 Forbidden\r\nDate: ${serverDate}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (data) => {
      const text = data.toString();
      record.messages.push(text);
      if (!text.includes("Path:ssml")) return;
      if (behaviour === "silent") return;
      if (behaviour === "close-early") {
        ws.close(1011, "boom");
        return;
      }
      ws.send(textFrame("turn.start"));
      if (behaviour === "no-audio") {
        ws.send(textFrame("turn.end"));
        return;
      }
      ws.send(textFrame("audio.metadata", JSON.stringify(WORDS)));
      ws.send(audioFrame(AUDIO_1));
      ws.send(audioFrame(AUDIO_2));
      ws.send(textFrame("turn.end"));
    });
  });
});

const tts = await import("../src/lib/edgeTts.js");
const { createApp } = await import("../src/app.js");

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.EDGE_TTS_WSS_URL = `ws://127.0.0.1:${port}/consumer/speech/synthesize/readaloud/edge/v1`;
  process.env.EDGE_TTS_TIMEOUT_MS = "800";
});

afterAll(async () => {
  delete process.env.EDGE_TTS_WSS_URL;
  delete process.env.EDGE_TTS_TIMEOUT_MS;
  wss.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  behaviour = "ok";
  forbiddenServed = false;
  seen.length = 0;
  tts._resetClockSkewForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Soundwave voice client (Microsoft Edge neural TTS)", () => {
  it("connects the way the Edge browser does and turns the reply into MP3 + word timings", async () => {
    const r = await tts.synthesizeEdgeTTS({ text: "Hello <there> & welcome, creator", voice: "en-US-GuyNeural", speed: 1 }, { attempts: 1, pacing: false });

    expect(Buffer.from(r.audioBase64, "base64")).toEqual(Buffer.concat([AUDIO_1, AUDIO_2]));
    expect(r.mimeType).toBe("audio/mpeg");
    expect(r.duration).toBeCloseTo(1.5, 5);
    expect(r.wordTimings).toEqual([
      { word: "Hello", start: 0.1, end: 0.5 },
      { word: "creator", start: 0.6, end: 1.1 },
    ]);

    expect(seen).toHaveLength(1);
    const [{ url, headers, messages }] = seen as [Seen];
    expect(url.pathname).toBe("/consumer/speech/synthesize/readaloud/edge/v1");
    expect(url.searchParams.get("TrustedClientToken")).toBe("6A5AA1D4EAFF4E9FB37E23D68491D6F4");
    expect(url.searchParams.get("ConnectionId")).toMatch(/^[0-9a-f]{32}$/);
    expect(url.searchParams.get("Sec-MS-GEC")).toMatch(/^[0-9A-F]{64}$/);
    expect(url.searchParams.get("Sec-MS-GEC-Version")).toBe(`1-${tts.CHROMIUM_FULL_VERSION}`);
    expect(headers.origin).toBe("chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
    expect(headers["user-agent"]).toMatch(/Chrome\/143\.0\.0\.0 Safari\/537\.36 Edg\/143\.0\.0\.0$/);
    expect(headers.cookie).toMatch(/^muid=[0-9A-F]{32};$/);
    expect(headers.pragma).toBe("no-cache");

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/^X-Timestamp:\w{3} \w{3} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT\+0000 \(Coordinated Universal Time\)\r\n/);
    expect(messages[0]).toContain("Path:speech.config\r\n\r\n");
    expect(messages[0]).toContain('"wordBoundaryEnabled":"true"');
    expect(messages[0]).toContain(`"outputFormat":"${tts.OUTPUT_FORMAT}"`);
    expect(messages[1]).toMatch(/^X-RequestId:[0-9a-f]{32}\r\nContent-Type:application\/ssml\+xml\r\nX-Timestamp:.+Z\r\nPath:ssml\r\n\r\n<speak /);
    expect(messages[1]).toContain("<voice name='Microsoft Server Speech Text to Speech Voice (en-US, GuyNeural)'>");
    expect(messages[1]).toContain("<prosody pitch='+0Hz' rate='+0%' volume='+0%'>");
    expect(messages[1]).toContain("Hello &lt;there&gt; &amp; welcome, creator");
  });

  it("streams audio chunks to the caller as they arrive", async () => {
    const chunks: Buffer[] = [];
    const r = await tts.streamEdgeTTS({ text: "Hello creator", voice: "en-GB-RyanNeural" }, { onAudio: (c) => chunks.push(c) });
    expect(chunks).toEqual([AUDIO_1, AUDIO_2]);
    expect(r).toEqual({ bytes: 9000, duration: 1.5 });
    expect(seen[0]!.messages[1]).toContain("(en-GB, RyanNeural)");
    expect(seen[0]!.messages[1]).toContain("xml:lang='en-GB'");
  });

  it("retries once with the service's clock after a 403 (the token is time-based)", async () => {
    behaviour = "forbidden-once";
    const r = await tts.synthesizeEdgeTTS({ text: "Hello creator", voice: "en-US-GuyNeural" }, { attempts: 1 });
    expect(r.duration).toBeCloseTo(1.5, 5);
    expect(seen).toHaveLength(2);
    // An hour of skew lands in a different 5-minute token window.
    expect(seen[1]!.url.searchParams.get("Sec-MS-GEC")).not.toBe(seen[0]!.url.searchParams.get("Sec-MS-GEC"));
  });

  it("fails with a readable error — and no stand-in voice — when the service misbehaves", async () => {
    behaviour = "close-early";
    await expect(tts.synthesizeEdgeTTS({ text: "Hi", voice: "en-US-GuyNeural" }, { attempts: 1 })).rejects.toThrow(
      /Soundwave voice service.*closed the connection early \(code 1011: boom\)/,
    );
    behaviour = "no-audio";
    await expect(tts.synthesizeEdgeTTS({ text: "Hi", voice: "en-US-GuyNeural" }, { attempts: 1 })).rejects.toThrow(/No audio came back/);
    behaviour = "silent";
    await expect(tts.synthesizeEdgeTTS({ text: "Hi", voice: "en-US-GuyNeural" }, { attempts: 1 })).rejects.toThrow(/didn't respond \(no audio\)/);
    expect(tts.getVoiceHealth()).toMatchObject({ ok: false, lastError: expect.stringMatching(/didn't respond/) });
  });

  it("retries whole attempts before giving up", async () => {
    behaviour = "close-early";
    await expect(tts.synthesizeEdgeTTS({ text: "Hi", voice: "en-US-GuyNeural" }, { attempts: 2 })).rejects.toThrow(/closed the connection early/);
    expect(seen).toHaveLength(2);
  });

  it("computes Sec-MS-GEC exactly like node-edge-tts's reference implementation", async () => {
    const require = createRequire(import.meta.url);
    const drm = require("node-edge-tts/dist/drm.js") as { generateSecMsGecToken: () => string };
    for (const t of [Date.UTC(2026, 8, 28, 1, 7, 42), Date.UTC(2027, 0, 1, 0, 4, 59, 999), Date.UTC(2026, 5, 15, 12, 0, 0)]) {
      vi.useFakeTimers();
      vi.setSystemTime(t);
      expect(tts.generateSecMsGec(t)).toBe(drm.generateSecMsGecToken());
      vi.useRealTimers();
    }
  });

  it("handles voice ids and long text", () => {
    expect(tts.normalizeVoiceId("en-US-GuyNeural")).toBe("en-US-GuyNeural");
    expect(tts.normalizeVoiceId("robot")).toBe(tts.DEFAULT_AGENT_VOICE);
    expect(tts.normalizeVoiceId(undefined, "en-US-ChristopherNeural")).toBe("en-US-ChristopherNeural");
    expect(tts.longVoiceName("zh-CN-liaoning-XiaobeiNeural")).toBe("Microsoft Server Speech Text to Speech Voice (zh-CN-liaoning, XiaobeiNeural)");

    const sentence = "This sentence is exactly fifty characters long ok. ";
    const chunks = tts.splitForSynthesis(sentence.repeat(100).trim(), 2000);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 2000 && c.endsWith("."))).toBe(true);
    expect(chunks.join(" ")).toBe(sentence.repeat(100).trim());
  });
});

describe("Long explanations and natural pacing", () => {
  it("reads a long explanation to the end — nothing is dropped", async () => {
    // The guide's YouTube walkthrough is thousands of characters. It used to
    // stop mid-sentence (the reply was cut to ~1200 characters before it was
    // ever sent), so this is the regression test for "the voice stopped
    // talking halfway through".
    const long = Array.from(
      { length: 40 },
      (_, i) =>
        `Step ${i + 1}: open Settings, then pick Phone, and turn on Let my phone connect. That is how the app links your PC to your phone for the morning briefing.`,
    ).join(" ");
    expect(long.length).toBeGreaterThan(4000);

    const r = await tts.synthesizeEdgeTTS({ text: long, voice: "en-US-GuyNeural" }, { attempts: 1, pacing: false });

    // More than one connection (splitForSynthesis cuts at 2000 characters)…
    expect(seen.length).toBeGreaterThan(1);
    const ssml = seen
      .flatMap((s) => s.messages.filter((m) => m.includes("Path:ssml")))
      .map((m) => m.slice(m.indexOf("<speak")))
      .join("\n");
    // …and every sentence is in there, first to last.
    expect(ssml).toContain("Step 1: open Settings");
    expect(ssml).toContain("Step 40: open Settings");
    expect(r.duration).toBeGreaterThan(0);
  });

  it("speaks at a natural pace: symbols become words, sentences get a short pause", async () => {
    const chunks: Buffer[] = [];
    await tts.streamEdgeTTS(
      { text: "Settings → Brain & Memory. It's free. Try it!", voice: "en-US-GuyNeural" },
      { onAudio: (c) => chunks.push(c) },
    );
    const ssml = seen[0]!.messages.find((m) => m.includes("Path:ssml"))!;
    expect(ssml).toContain("Settings to Brain and Memory.");
    expect(ssml).not.toContain("→");
    expect(ssml).not.toContain("&amp;");
    // A pause after each sentence (and the default narrator cadence, -5%).
    expect(ssml).toMatch(/Memory\. <break time="170ms"\/>/);
    expect(ssml).toMatch(/rate='-5%'/);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("keeps abbreviations out of the voice: e.g. and i.e. are read as words", () => {
    expect(tts.formatNaturalSpeechPacing("Use a fine voice, e.g. Ava, i.e. the natural one.")).toBe(
      "Use a fine voice, for example Ava, that is the natural one.",
    );
  });

  it("speaks a full client piece (1100 characters) without cutting it", async () => {
    const sentence = "Open the settings page on your PC and follow the steps exactly as they are written here. ";
    const piece = sentence.repeat(13).trim(); // ~1160 characters — what the apps send
    expect(piece.length).toBeGreaterThan(1000);
    expect(piece.length).toBeLessThan(1200);

    seen.length = 0;
    const res = await request(createApp())
      .get("/api/v1/agent/speak/stream")
      .query({ text: piece, voice: "en-US-GuyNeural" })
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on("data", (c: Buffer) => parts.push(c));
        r.on("end", () => cb(null, Buffer.concat(parts)));
      });
    expect(res.status).toBe(200);
    const ssml = seen.flatMap((s) => s.messages.filter((m) => m.includes("Path:ssml"))).join(" ");
    expect(ssml).toContain("Open the settings page on your PC");
    // The last words of the piece really were sent to the service.
    expect(ssml).toContain("as they are written here.");
  });
});

describe("Agent speech endpoints", () => {
  it("streams the reply as same-origin MP3 (allowed by the desktop app's CSP)", async () => {
    const res = await request(createApp())
      .get("/api/v1/agent/speak/stream")
      .query({ text: "Hello creator", voice: "en-US-ChristopherNeural" })
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on("data", (c: Buffer) => parts.push(c));
        r.on("end", () => cb(null, Buffer.concat(parts)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(res.headers["x-soundwave-voice"]).toBe("en-US-ChristopherNeural");
    expect((res.body as Buffer).equals(Buffer.concat([AUDIO_1, AUDIO_2]))).toBe(true);
    expect(res.headers["content-security-policy"]).toMatch(/media-src 'self'/);
  });

  it("answers 400 without text and 502 (with the reason) when the voice service fails", async () => {
    const app = createApp();
    expect((await request(app).get("/api/v1/agent/speak/stream")).status).toBe(400);

    behaviour = "close-early";
    const res = await request(app).get("/api/v1/agent/speak/stream").query({ text: "Hi there" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: "VOICE_UNAVAILABLE", message: expect.stringMatching(/closed the connection early/) });

    const status = await request(app).get("/api/v1/agent/speak/status");
    expect(status.body).toMatchObject({ ok: false, lastError: expect.stringMatching(/closed the connection early/) });

    behaviour = "ok";
    await request(app).get("/api/v1/agent/speak/stream").query({ text: "Back again" });
    expect((await request(app).get("/api/v1/agent/speak/status")).body).toMatchObject({ ok: true, lastError: null });
  });

  it("keeps the JSON /speak endpoint (Python desktop runner) working", async () => {
    const app = createApp();
    const ok = await request(app).post("/api/v1/agent/speak").send({ text: "Hello creator", voice: "en-US-GuyNeural" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ success: true, mimeType: "audio/mpeg", duration: 1.5 });
    expect(Buffer.from(ok.body.audioBase64, "base64").length).toBe(9000);

    behaviour = "no-audio";
    const bad = await request(app).post("/api/v1/agent/speak").send({ text: "Hello creator" });
    expect(bad.status).toBe(502);
    expect(bad.body).toMatchObject({ success: false, error: expect.stringMatching(/No audio came back/) });
    expect(bad.body.fallbackToBrowser).toBeUndefined();
  });
});
