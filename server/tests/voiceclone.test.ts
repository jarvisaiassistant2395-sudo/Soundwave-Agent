import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createApp } from "../src/app.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";
import { createCloneProfile, listCloneProfiles, synthesizeClone } from "../src/lib/voiceclone.js";
import { resolveFfmpegPath } from "../src/config.js";

// The reference clip is synthesized with ffmpeg (absent while CI runs the tests).
const hasFfmpeg = spawnSync(resolveFfmpegPath(), ["-version"], { stdio: "ignore" }).status === 0;

let app: ReturnType<typeof createApp>;
const testUserId = "test-clone-user-123";
let testAudioClip: Buffer;

beforeAll(async () => {
  if (!hasFfmpeg) return;
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();

  // Create synthetic 2-second audio reference clip
  const tmpClip = path.join(os.tmpdir(), `test_ref_clip_${process.pid}.wav`);
  spawnSync(resolveFfmpegPath(), [
    "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=2",
    "-ar", "24000", "-ac", "1",
    tmpClip,
  ]);
  testAudioClip = fs.readFileSync(tmpClip);
  fs.unlinkSync(tmpClip);
});

describe.skipIf(!hasFfmpeg)("Multi-Engine Voice Cloning", () => {
  let createdProfileId = "";

  it("creates a custom cloned voice profile with pre-generated sample", async () => {
    const profile = await createCloneProfile(testUserId, {
      name: "Strahinja Voice (Deep)",
      audio: testAudioClip,
      filename: "ref_sample.wav",
      mimeType: "audio/wav",
      refText: "Testing voice clone reference.",
      consentConfirmedAt: new Date().toISOString(),
    });

    expect(profile.id).toBeDefined();
    expect(profile.name).toBe("Strahinja Voice (Deep)");
    expect(profile.sampleUrl).toContain(profile.id);

    createdProfileId = profile.id;

    const list = await listCloneProfiles(testUserId);
    expect(list.some((p) => p.id === profile.id)).toBe(true);
  });

  it("synthesizes voiceover with the cloned voice profile", async () => {
    const result = await synthesizeClone(testUserId, {
      text: "This is an automated test of the Soundwave AI cloned voice engine.",
      profileId: createdProfileId,
    });

    expect(result.audioBase64).toBeDefined();
    expect(result.duration).toBeGreaterThan(0.5);
    expect(result.wordTimings.length).toBeGreaterThan(0);
    expect(result.mimeType).toBe("audio/mpeg");
  });
});
