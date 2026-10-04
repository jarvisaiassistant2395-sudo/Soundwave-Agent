// ── The cloning sidecar's refusals must reach the person, not be papered over ─
// The rest of the suite runs with VOICECLONE_URL unset, so the sidecar branch is
// never exercised there. This file starts a stand-in Chatterbox sidecar on
// loopback and pins the one behaviour that matters for honesty: when the engine
// *understands* a request and refuses it (HTTP 400 — e.g. a speed change, which
// the cloning model has no knob for), the caller hears that sentence. Falling
// through to the fallback voice at that point would answer in a different voice
// than the one that was asked for.
//
// The URL has to be in place before src/lib/voiceclone.ts reads config, hence the
// dynamic import in beforeAll.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Nothing from src/ may be imported statically here: `config.ts` reads the
// environment once, at import time, and VOICECLONE_URL is only known after the
// stand-in sidecar has a port. Every app module is therefore imported
// dynamically inside beforeAll, after the URL is in place.
//
// The one exception is this pre-check: `describe.skipIf` runs at collection
// time, so it can't wait for beforeAll. It looks for the same vendored binary
// config's resolver does, and skips honestly when there is none (the packaged CI
// run has no ffmpeg during the test step).
function preFfmpeg(): string | null {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(process.cwd(), "..", "vendor", "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    path.join(process.cwd(), "vendor", "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    "ffmpeg",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["-version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}
const hasFfmpeg = preFfmpeg() !== null;
const REFUSAL = "Cloned voices don't support a speed change — set the speed on the narration voice instead.";
function makeWav(): Buffer {
  const sampleRate = 24_000;
  const sampleCount = 2_400;
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); // PCM format chunk size
  wav.writeUInt16LE(1, 20); // linear PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // byte rate
  wav.writeUInt16LE(2, 32); // block alignment
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

describe.skipIf(!hasFfmpeg)("the cloning sidecar's answers", () => {
  let server: http.Server;
  let serverUrl = "";
  let cloneCalls: Array<{ path: string; body: string }> = [];
  let mode: "refuse" | "ok" | "down" = "refuse";
  let synthesizeClone: typeof import("../src/lib/voiceclone.js").synthesizeClone;
  let createCloneProfile: typeof import("../src/lib/voiceclone.js").createCloneProfile;
  let validateCloneReference: typeof import("../src/lib/voiceclone.js").validateCloneReference;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        cloneCalls.push({ path: req.url ?? "", body });
        if (req.url === "/health") {
          res.writeHead(mode === "down" ? 503 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: mode !== "down",
            clone_ready: mode !== "down",
            clone_engine: mode === "down" ? null : "chatterbox",
            model_loaded: mode !== "down",
            device: "cpu",
            mock: false,
            reference_limits_seconds: { chatterbox: { min: 3, max: 60 }, moss: { min: 3, max: 10 } },
          }));
          return;
        }
        if (req.url === "/clone/validate-reference") {
          if (mode === "down") {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ detail: "clone model is unavailable" }));
          } else if (mode === "refuse") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ detail: "The reference clip is too short — use at least 3 seconds." }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ valid: true, durationSeconds: 3, engine: "chatterbox" }));
          }
          return;
        }
        if (mode === "refuse") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: REFUSAL }));
          return;
        }
        if (mode === "down") {
          res.writeHead(503);
          res.end("no");
          return;
        }
        res.writeHead(200, { "Content-Type": "audio/wav", "X-Audio-Duration": "1.000" });
        res.end(makeWav());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    serverUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    process.env.VOICECLONE_URL = serverUrl;
    process.env.VOICECLONE_TOKEN = "";

    const storeMod = await import("../src/lib/store.js");
    const store = new storeMod.JsonStore();
    await store.init();
    storeMod.setStoreForTests(store);

    const mod = await import("../src/lib/voiceclone.js");
    synthesizeClone = mod.synthesizeClone;
    createCloneProfile = mod.createCloneProfile;
    validateCloneReference = mod.validateCloneReference;
  });

  afterAll(async () => {
    delete process.env.VOICECLONE_URL;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("asks the active sidecar to validate duration before saving a clone profile", async () => {
    mode = "ok";
    cloneCalls = [];
    const validated = await validateCloneReference({
      audio: Buffer.from("RIFF" + "x".repeat(1_100)),
      filename: "reference.wav",
      mimeType: "audio/wav",
    });
    expect(validated).toEqual({ durationSeconds: 3, engine: "chatterbox" });
    const call = cloneCalls.find((entry) => entry.path === "/clone/validate-reference");
    expect(call).toBeTruthy();
    expect(call?.body).toContain("reference.wav");
  });

  it("passes a refusal back with the engine's own sentence (no silent voice swap)", async () => {
    const { resolveFfmpegPath } = await import("../src/config.js");
    const clip = path.join(os.tmpdir(), `sw-ref-${process.pid}.wav`);
    spawnSync(resolveFfmpegPath(), ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-ar", "24000", "-ac", "1", clip]);
    const profile = await createCloneProfile("sidecar-user-1", {
      name: "Refusal check",
      audio: fs.readFileSync(clip),
      filename: "ref.wav",
      mimeType: "audio/wav",
      consentConfirmedAt: new Date().toISOString(),
    });

    mode = "refuse";
    cloneCalls = [];
    await expect(synthesizeClone("sidecar-user-1", { text: "Hello there.", profileId: profile.id, speed: 1.5 })).rejects.toThrow(
      /speed change/i,
    );
    // It really asked the engine, and it did not silently fall back.
    expect(cloneCalls.some((c) => c.path === "/clone/ephemeral")).toBe(true);
    fs.unlinkSync(clip);
  });

  it("fails cloned profiles closed when the local model goes offline (no Edge or sine substitution)", async () => {
    mode = "ok";
    const profile = await createCloneProfile("sidecar-offline-user", {
      name: "Offline check",
      audio: Buffer.from("RIFF" + "x".repeat(1_100)),
      filename: "ref.wav",
      mimeType: "audio/wav",
      consentConfirmedAt: new Date().toISOString(),
    });

    mode = "down";
    cloneCalls = [];
    await expect(synthesizeClone("sidecar-offline-user", { text: "Keep this voice.", profileId: profile.id }))
      .rejects.toMatchObject({ status: 503, code: "VOICECLONE_UNAVAILABLE" });
    expect(cloneCalls.some((c) => c.path === "/clone/ephemeral")).toBe(false);
  });

  it("returns the engine's audio when it answers, and the request carries the reference clip", async () => {
    const { resolveFfmpegPath } = await import("../src/config.js");
    const clip = path.join(os.tmpdir(), `sw-ref-ok-${process.pid}.wav`);
    spawnSync(resolveFfmpegPath(), ["-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=3", "-ar", "24000", "-ac", "1", clip]);
    const profile = await createCloneProfile("sidecar-user-2", {
      name: "Success check",
      audio: fs.readFileSync(clip),
      filename: "ref.wav",
      mimeType: "audio/wav",
      consentConfirmedAt: new Date().toISOString(),
    });

    mode = "ok";
    cloneCalls = [];
    const result = await synthesizeClone("sidecar-user-2", { text: "A short line.", profileId: profile.id });
    expect(result.duration).toBeCloseTo(1, 3);
    expect(result.audioBase64.length).toBeGreaterThan(0);
    const sent = cloneCalls.find((c) => c.path === "/clone/ephemeral");
    expect(sent).toBeTruthy();
    expect(sent?.body).toContain("A short line."); // the text went with the clip
    fs.unlinkSync(clip);
  });
});
