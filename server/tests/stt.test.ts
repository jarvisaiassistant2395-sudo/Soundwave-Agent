import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";
import {
  STT_SAMPLE_RATE,
  analyzePcm,
  cleanTranscript,
  encodeWav,
  modelLabel,
  parseWav,
  resolveWhisper,
  sttBusy,
  transcribe,
} from "../src/lib/stt.js";

// ── Test audio ──────────────────────────────────────────────────────────────

/** `seconds` of a 220 Hz "voice" (amplitude 0.3) framed by quiet noise. */
function speechLikePcm(seconds = 1, padSeconds = 0.4): Int16Array {
  const pad = Math.round(padSeconds * STT_SAMPLE_RATE);
  const body = Math.round(seconds * STT_SAMPLE_RATE);
  const pcm = new Int16Array(pad * 2 + body);
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 40; // ~-60 dBFS hiss
  };
  for (let i = 0; i < pcm.length; i++) {
    const inBody = i >= pad && i < pad + body;
    const v = inBody ? Math.sin((2 * Math.PI * 220 * i) / STT_SAMPLE_RATE) * 0.3 * 32767 : 0;
    pcm[i] = Math.round(v + noise());
  }
  return pcm;
}

function silentPcm(seconds = 1.5): Int16Array {
  return new Int16Array(Math.round(seconds * STT_SAMPLE_RATE));
}

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("voice input — audio helpers", () => {
  it("encodes and parses 16 kHz mono PCM WAV", () => {
    const pcm = speechLikePcm(0.2, 0);
    const wav = encodeWav(pcm);
    const info = parseWav(wav);
    expect(info).toMatchObject({ audioFormat: 1, channels: 1, sampleRate: 16_000, bitsPerSample: 16, dataOffset: 44 });
    expect(info!.dataLength).toBe(pcm.length * 2);
    expect(wav.readInt16LE(44 + 200)).toBe(pcm[100]);
  });

  it("parses streamed WAVs whose sizes were never filled in", () => {
    const wav = encodeWav(speechLikePcm(0.1, 0));
    wav.writeUInt32LE(0xffffffff, 4);
    wav.writeUInt32LE(0xffffffff, 40);
    expect(parseWav(wav)!.dataLength).toBe(wav.length - 44);
    wav.writeUInt32LE(0, 40);
    expect(parseWav(wav)!.dataLength).toBe(wav.length - 44);
  });

  it("rejects things that aren't WAV", () => {
    expect(parseWav(Buffer.from("definitely not a riff file, just text padding it out"))).toBeNull();
    expect(parseWav(Buffer.alloc(10))).toBeNull();
  });

  it("tells speech from silence", () => {
    const talk = analyzePcm(speechLikePcm(1));
    expect(talk.durationMs).toBeCloseTo(1800, -1);
    expect(talk.voicedMs).toBeGreaterThan(800);
    expect(talk.peakDb).toBeGreaterThan(-12);

    const quiet = analyzePcm(silentPcm());
    expect(quiet.voicedMs).toBe(0);
    expect(quiet.peakDb).toBeLessThan(-90);
  });

  it("cleans whisper's output", () => {
    expect(cleanTranscript("\n Make a YouTube short about space.\n")).toBe("Make a YouTube short about space.");
    expect(cleanTranscript(" Open Spotify\n and play some music .")).toBe("Open Spotify and play some music.");
    expect(cleanTranscript("[BLANK_AUDIO]")).toBe("");
    expect(cleanTranscript(" (upbeat music) ♪ ♪ ")).toBe("");
    expect(cleanTranscript("*laughs* What's the weather?")).toBe("What's the weather?");
    // Whisper's classic inventions on near-silence are dropped…
    expect(cleanTranscript(" Thank you.", { voicedMs: 300 })).toBe("");
    expect(cleanTranscript(" you", { voicedMs: 200 })).toBe("");
    // …but a real, longer "thank you" stays.
    expect(cleanTranscript(" Thank you.", { voicedMs: 1500 })).toBe("Thank you.");
  });

  it("names models", () => {
    expect(modelLabel("/x/ggml-base.en-q5_1.bin")).toBe("base.en");
    expect(modelLabel("C:\\Soundwave\\ggml-tiny.bin")).toBe("tiny");
  });
});

// ── Engine discovery + the HTTP route ───────────────────────────────────────

const ENV_KEYS = ["WHISPER_CLI_PATH", "WHISPER_MODEL_PATH", "FAKE_WHISPER_OUTPUT", "FAKE_WHISPER_EXIT", "FAKE_WHISPER_LOG", "FAKE_WHISPER_SLEEP"] as const;
const savedEnv: Record<string, string | undefined> = {};
let tmp = "";
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-stt-"));
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A stand-in whisper-cli: logs its args + working dir, prints FAKE_WHISPER_OUTPUT. */
function installFakeWhisper(): { cli: string; model: string; log: string } {
  const dir = fs.mkdtempSync(path.join(tmp, "engine-"));
  const cli = path.join(dir, "whisper-cli");
  const model = path.join(dir, "ggml-base.en-q5_1.bin");
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(
    cli,
    [
      "#!/bin/sh",
      'bytes=$(wc -c)',
      'printf "%s\\n" "args=$*" "cwd=$(pwd)" "stdin=$bytes" >> "$FAKE_WHISPER_LOG"',
      '[ -n "$FAKE_WHISPER_SLEEP" ] && sleep "$FAKE_WHISPER_SLEEP"',
      'if [ -n "$FAKE_WHISPER_EXIT" ]; then echo "whisper_init: failed to open something" >&2; echo "boom: out of cheese" >&2; exit "$FAKE_WHISPER_EXIT"; fi',
      'printf "%s\\n" "$FAKE_WHISPER_OUTPUT"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(model, "ggml-fake-model");
  process.env.WHISPER_CLI_PATH = cli;
  process.env.WHISPER_MODEL_PATH = model;
  process.env.FAKE_WHISPER_LOG = log;
  return { cli, model, log };
}

describe("voice input — engine discovery", () => {
  it("reports a clear reason when the engine is missing", () => {
    process.env.WHISPER_CLI_PATH = path.join(tmp, "nope", "whisper-cli");
    const r = resolveWhisper();
    expect(r.setup).toBeNull();
    expect(r.problem).toMatch(/speech engine is missing/i);
  });

  it("reports a clear reason when the model is missing", () => {
    const { cli } = installFakeWhisper();
    process.env.WHISPER_CLI_PATH = cli;
    process.env.WHISPER_MODEL_PATH = path.join(tmp, "nope.bin");
    expect(resolveWhisper().problem).toMatch(/speech model is missing/i);
  });

  it("uses the configured engine and model", () => {
    const { cli, model } = installFakeWhisper();
    expect(resolveWhisper()).toEqual({ setup: { cli, model, modelName: "base.en" }, problem: null });
  });
});

describe("voice input — POST /api/v1/agent/transcribe", () => {
  it("GET /transcribe/status says why voice input is unavailable", async () => {
    process.env.WHISPER_CLI_PATH = path.join(tmp, "missing-whisper-cli");
    const res = await request(app).get("/api/v1/agent/transcribe/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false, engine: "whisper.cpp", model: null });
    expect(res.body.reason).toMatch(/missing/i);
  });

  it("answers 503 STT_UNAVAILABLE without an engine", async () => {
    process.env.WHISPER_CLI_PATH = path.join(tmp, "missing-whisper-cli");
    const res = await request(app).post("/api/v1/agent/transcribe").set("Content-Type", "audio/wav").send(encodeWav(speechLikePcm()));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("STT_UNAVAILABLE");
  });

  it("rejects an empty recording", async () => {
    installFakeWhisper();
    const res = await request(app).post("/api/v1/agent/transcribe").set("Content-Type", "audio/wav").send(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_AUDIO");
  });

  it("skips the engine for a silent clip", async () => {
    const { log } = installFakeWhisper();
    const res = await request(app).post("/api/v1/agent/transcribe").set("Content-Type", "audio/wav").send(encodeWav(silentPcm()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: "", noSpeech: true, elapsedMs: 0, model: "base.en" });
    expect(fs.existsSync(log)).toBe(false);
  });

  describe.skipIf(process.platform === "win32")("with a stand-in whisper-cli", () => {
    it("transcribes: model by file name from its own folder, audio on stdin, text on stdout", async () => {
      const { model, log } = installFakeWhisper();
      process.env.FAKE_WHISPER_OUTPUT = " Make a YouTube short about black holes.";
      const wav = encodeWav(speechLikePcm());
      const res = await request(app).post("/api/v1/agent/transcribe").set("Content-Type", "audio/wav").send(wav);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ text: "Make a YouTube short about black holes.", noSpeech: false, model: "base.en" });
      expect(res.body.durationMs).toBeCloseTo(1800, -1);

      const calls = fs.readFileSync(log, "utf8");
      // No absolute paths on whisper's (ANSI) command line; "-of" keeps results on stdout.
      expect(calls).toMatch(/args=-m ggml-base\.en-q5_1\.bin -f - -of soundwave-stt -l en -t \d+ -nt -np -sns/);
      expect(calls).toContain(`cwd=${fs.realpathSync(path.dirname(model))}`);
      expect(calls).toMatch(new RegExp(`stdin=\\s*${wav.length}\\b`));
    });

    it("serves a person's recording before background work, and never behind it", async () => {
      const { log } = installFakeWhisper();
      process.env.FAKE_WHISPER_OUTPUT = " Make a YouTube short about black holes.";
      process.env.FAKE_WHISPER_SLEEP = "2"; // a slow engine, so there is a queue to get in
      const wav = encodeWav(speechLikePcm());

      // The person's recording, in the engine. (.then() starts it: supertest
      // only dispatches a request when it is awaited.)
      const mine = request(app).post("/api/v1/agent/transcribe").set("Content-Type", "audio/wav").send(wav).then((r) => r);
      for (let i = 0; i < 60 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 25));
      expect(fs.existsSync(log), "the person's recording should be in the engine by now").toBe(true);

      // The hidden wake listener checking what it just heard: refused, not
      // queued — it throws the utterance away and checks the next one.
      const background = await request(app).post("/api/v1/agent/transcribe?background=1").set("Content-Type", "audio/wav").send(wav);
      expect(background.status).toBe(429);
      expect(background.body.error.code).toBe("STT_BUSY");

      // …and the person's own request still answers, unharmed.
      expect((await mine).status).toBe(200);

      // With the engine free, the same background request is served normally.
      const later = await request(app).post("/api/v1/agent/transcribe?background=1").set("Content-Type", "audio/wav").send(wav);
      expect(later.status).toBe(200);
      expect(later.body.text).toBe("Make a YouTube short about black holes.");
      delete process.env.FAKE_WHISPER_SLEEP;
    });

    it("says when the engine is busy, so background work can step aside", async () => {
      // The trends scan (shortsTrends) asks this before taking the machine: a
      // person's voice input must never share the CPU with two yt-dlp searches
      // on a small PC — that is what pushed a voice command past the engine's
      // 90-second limit in the packaged-app end-to-end run.
      installFakeWhisper();
      process.env.FAKE_WHISPER_OUTPUT = " And so, my fellow Americans.";
      process.env.FAKE_WHISPER_SLEEP = "1";
      expect(sttBusy()).toBe(false);

      const running = request(app).post("/api/v1/agent/transcribe").set("Content-Type", "audio/wav").send(encodeWav(speechLikePcm())).then((r) => r);
      for (let i = 0; i < 80 && !sttBusy(); i++) await new Promise((r) => setTimeout(r, 25));
      expect(sttBusy()).toBe(true);

      const done = await running;
      expect(done.status).toBe(200);
      expect(sttBusy()).toBe(false);
      delete process.env.FAKE_WHISPER_SLEEP;
    });

    it("reports what whisper heard as no speech", async () => {
      installFakeWhisper();
      process.env.FAKE_WHISPER_OUTPUT = "[BLANK_AUDIO]";
      const res = await request(app).post("/api/v1/agent/transcribe").set("Content-Type", "audio/wav").send(encodeWav(speechLikePcm()));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ text: "", noSpeech: true });
    });

    it("surfaces an engine failure with its reason", async () => {
      installFakeWhisper();
      process.env.FAKE_WHISPER_EXIT = "3";
      const res = await request(app).post("/api/v1/agent/transcribe").set("Content-Type", "audio/wav").send(encodeWav(speechLikePcm()));
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("STT_FAILED");
      expect(res.body.error.message).toMatch(/model couldn't be loaded|out of cheese/);
      const status = await request(app).get("/api/v1/agent/transcribe/status");
      expect(status.body.lastError).toBe(res.body.error.message);
    });

    it("converts other formats (a 44.1 kHz stereo WAV) with ffmpeg first", async (ctx) => {
      const { log } = installFakeWhisper();
      process.env.FAKE_WHISPER_OUTPUT = " Open Spotify.";
      // 44.1 kHz stereo 16-bit — not what whisper wants.
      const mono = speechLikePcm(1, 0.3);
      const frames = Math.round((mono.length * 44_100) / STT_SAMPLE_RATE);
      const data = Buffer.alloc(frames * 4);
      for (let i = 0; i < frames; i++) {
        const v = mono[Math.min(mono.length - 1, Math.floor((i * STT_SAMPLE_RATE) / 44_100))]!;
        data.writeInt16LE(v, i * 4);
        data.writeInt16LE(v, i * 4 + 2);
      }
      const header = encodeWav(new Int16Array(0));
      header.writeUInt16LE(2, 22);
      header.writeUInt32LE(44_100, 24);
      header.writeUInt32LE(44_100 * 4, 28);
      header.writeUInt16LE(4, 32);
      header.writeUInt32LE(data.length, 40);
      header.writeUInt32LE(36 + data.length, 4);
      const res = await request(app)
        .post("/api/v1/agent/transcribe")
        .set("Content-Type", "audio/wav")
        .send(Buffer.concat([header, data]));
      if (res.status === 400 && /ffmpeg/i.test(res.body.error?.message ?? "")) {
        ctx.skip(); // no ffmpeg on this machine
        return;
      }
      expect(res.status).toBe(200);
      expect(res.body.text).toBe("Open Spotify.");
      const calls = fs.readFileSync(log, "utf8");
      // whisper got 16 kHz mono: 44-byte header + 2 bytes per sample.
      const bytes = Number(/stdin=\s*(\d+)/.exec(calls)![1]);
      expect(Math.abs(bytes - (44 + mono.length * 2))).toBeLessThan(400);
    });
  });
});

// Optional: the real engine (vendor/whisper or WHISPER_* env) on a real
// recording. Run with STT_REAL_SAMPLE=/path/to/jfk.wav.
describe.skipIf(!process.env.STT_REAL_SAMPLE)("voice input — real whisper.cpp", () => {
  it("transcribes the sample", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const result = await transcribe(fs.readFileSync(process.env.STT_REAL_SAMPLE!));
    expect(result.noSpeech).toBe(false);
    expect(result.text.toLowerCase()).toMatch(/ask not what your country/);
  }, 120_000);
});
