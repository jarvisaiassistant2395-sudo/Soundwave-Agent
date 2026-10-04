// The packaged desktop provisions Kokoro asynchronously; expose that progress
// before the sidecar is reachable, then switch to the live engine once ready.
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-kokoro-status-"));
const statusFile = path.join(dataDir, "status.json");
let voiceRequests = 0;
const sidecar = http.createServer((req, res) => {
  if (req.url?.startsWith("/tts/kokoro/voices")) {
    voiceRequests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ available: true, voices: [{ id: "af_heart", name: "Heart", gender: "Female", accent: "American" }] }));
    return;
  }
  res.writeHead(404).end();
});

await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
const { port } = sidecar.address() as AddressInfo;
process.env.LOCAL_VOICE_URL = `http://127.0.0.1:${port}`;
process.env.LOCAL_VOICE_STATUS_FILE = statusFile;

const { getLocalVoiceStatus } = await import("../src/lib/kokoro.js");

afterAll(async () => {
  delete process.env.LOCAL_VOICE_URL;
  delete process.env.LOCAL_VOICE_STATUS_FILE;
  await new Promise<void>((resolve) => sidecar.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("desktop-managed Kokoro setup status", () => {
  it("reports background setup immediately without waiting for the local service", async () => {
    fs.writeFileSync(statusFile, JSON.stringify({
      managed: true,
      phase: "installing-python",
      message: "Downloading the signed Python runtime for Kokoro.",
      progress: 42,
      progressLabel: "Python runtime download",
    }));

    const status = await getLocalVoiceStatus({ fresh: true });
    expect(status.available).toBe(false);
    expect(status.reason).toContain("Downloading the signed Python runtime");
    expect(status.setup).toMatchObject({ managed: true, phase: "installing-python", progress: 42, progressLabel: "Python runtime download" });
    expect(voiceRequests).toBe(0);
  });

  it("switches to the real local voice list when the manager marks Kokoro ready", async () => {
    fs.writeFileSync(statusFile, JSON.stringify({ managed: true, phase: "ready", message: "On-device Kokoro is ready." }));
    const status = await getLocalVoiceStatus({ fresh: true });
    expect(status.available).toBe(true);
    expect(status.setup?.phase).toBe("ready");
    expect(status.voices.map((voice) => voice.voiceId)).toEqual(["kokoro:af_heart"]);
    expect(voiceRequests).toBe(1);
  });

  it.each(["failed", "cancelled"])("keeps %s setup actionable without probing a stale sidecar", async (phase) => {
    const requestsBefore = voiceRequests;
    fs.writeFileSync(statusFile, JSON.stringify({ managed: true, phase, message: `Kokoro setup ${phase}.` }));
    const status = await getLocalVoiceStatus({ fresh: true });
    expect(status.available).toBe(false);
    expect(status.reason).toBe(`Kokoro setup ${phase}.`);
    expect(status.setup?.phase).toBe(phase);
    expect(voiceRequests).toBe(requestsBefore);
  });
});
