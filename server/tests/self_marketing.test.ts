// The whole self-marketing chain, end to end: the agent writes a promo script
// (brief in brain/core/promo.ts), it films its own window while it narrates,
// the frames become the background of a real ffmpeg render, and the finished
// video goes to the connected YouTube channel with that channel's own token.
// Gemini, the voice service and the YouTube upload are stand-ins on loopback
// (helpers/fakeGoogle.ts); the recorder, the render and the file on disk are real.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  synthesizeEdgeTTS: vi.fn(),
}));

vi.mock("../src/lib/edgeTts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/edgeTts.js")>();
  return { ...actual, synthesizeEdgeTTS: mocks.synthesizeEdgeTTS };
});

const { config } = await import("../src/config.js");
const { JsonStore, setStoreForTests, getStore } = await import("../src/lib/store.js");
const { startFakeGoogle, useFakeGoogle, text } = await import("./helpers/fakeGoogle.js");
const settings = await import("../src/lib/brain/settings.js");
const channels = await import("../src/lib/youtubeChannels.js");
const { youtubeService } = await import("../src/lib/youtube.js");
const { buildShortVideo } = await import("../src/routes/agentShort.js");
const { probeMedia, resolveFfmpegPath } = await import("../src/lib/ffmpeg.js");
const { PROMO_FEATURES } = await import("../src/lib/brain/core/promo.js");

/** What the model returns: a promo script that already passes the doctor. */
const PROMO_SCRIPT =
  "It writes the hook first, then the whole script around it. A real neural voice reads it as captions land word by word. But here is the part nobody expects: every few days it studies what is actually working on Shorts. It films its own window while it works, so the background is the app proving itself. One press renders and posts it to your channel. The brain is your own Gemini key. What would you post first?";

const WORK = path.join(config.uploadsDir, "self-marketing-test");
const PNG = path.join(WORK, "window.png");
const VOICE = path.join(WORK, "voice.mp3");
const hostRef = globalThis as { __soundwaveDesktopHost?: unknown };

let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
const runFfmpeg = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });

beforeAll(async () => {
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  fake = await startFakeGoogle();
  useFakeGoogle(config as unknown as Record<string, unknown>, fake);
  fs.mkdirSync(WORK, { recursive: true });
  await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:rate=1", "-frames:v", "1", PNG]);
  // Four seconds of real audio, the way the voice service hands it over.
  await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=420:duration=4", "-b:a", "128k", VOICE]);
}, 120_000);

afterAll(async () => {
  await fake.close();
  delete hostRef.__soundwaveDesktopHost;
  fs.rmSync(WORK, { recursive: true, force: true });
});

beforeEach(() => {
  fake.reset();
  settings.resetBrainSettingsForTests();
  channels.resetChannelsForTests();
  youtubeService.saveConfig({ clientId: "", clientSecret: "", refreshToken: "", channelTitle: undefined, channelId: undefined, autoPublish: false });
  delete hostRef.__soundwaveDesktopHost;
  const audioBase64 = fs.readFileSync(VOICE).toString("base64");
  mocks.synthesizeEdgeTTS.mockReset();
  mocks.synthesizeEdgeTTS.mockResolvedValue({
    audioBase64,
    duration: 4,
    wordTimings: PROMO_SCRIPT.split(/\s+/).map((word, i) => ({ word, start: (i * 4) / 78, end: ((i + 1) * 4) / 78 })),
  });
});

/** A channel, connected the way the real flow does it. */
function connect(name: string, token: string) {
  youtubeService.saveConfig({ clientId: "cid.apps.googleusercontent.com", clientSecret: "s3cret", refreshToken: token, clientSource: "own", connectedClientId: "cid.apps.googleusercontent.com" });
  return channels.registerChannel({ refreshToken: token, channelTitle: name, channelId: `UC${name.replace(/\W/g, "")}`, clientSource: "own", connectedClientId: "cid.apps.googleusercontent.com" });
}

describe("a demo the agent makes of itself", () => {
  it("writes the promo brief, films its own window, renders, and posts to the channel", async () => {
    settings.saveBrainSettings({ apiKey: "AIzaSySelfMarketing-test-012345wxyz" });
    const channel = connect("Soundwave Demos", "1//demos");
    hostRef.__soundwaveDesktopHost = { showWindow: () => undefined, captureWindow: async () => fs.readFileSync(PNG) };
    fake.gemini.push(text(PROMO_SCRIPT), text(PROMO_SCRIPT));

    const out = await buildShortVideo({
      topic: "show how Soundwave AI makes a short, start to finish, in one press",
      promo: true,
      selfRecord: true,
      aspect: "16:9",
      resolution: "720p",
      seconds: 30,
      autoPublishYouTube: true,
      youtubeChannelId: channel.id,
      userId: "marketer",
    });

    // 1. The script was written with the promo brief — the claim whitelist and
    //    the fact that the picture is the app are both in it.
    const brief = (fake.generateCalls()[0]!.body as { systemInstruction: { parts: Array<{ text: string }> } }).systemInstruction.parts[0]!.text;
    expect(brief).toContain("real recording of the app's own window");
    expect(brief).toContain(PROMO_FEATURES[0]!);
    expect(brief).toContain("Never claim a feature that is not in the list above.");
    expect(brief).toContain("63–78 words");

    // 2. The job remembers the truth: a self-recording, the promo script, and
    //    where it went.
    const job = await getStore().then((s) => s.getJob(out.jobId, "marketer"));
    const jobSettings = job!.settings as unknown as Record<string, unknown>;
    expect(job!.status).toBe("COMPLETED");
    expect(jobSettings).toMatchObject({
      scriptSource: "gemini",
      scriptNiche: "promo",
      voice: "en-US-ChristopherNeural",
      youtubeChannel: "Soundwave Demos",
      youtubeError: null,
    });
    expect((jobSettings.background as { source: string }).source).toBe("self_recording");
    expect((jobSettings.background as { frames: number }).frames).toBeGreaterThanOrEqual(1);

    // 3. The file on disk is the real render: landscape 720p, as long as the voice.
    const videoPath = path.join(config.uploadsDir, `soundwave_short_${out.jobId}.mp4`);
    expect(fs.existsSync(videoPath)).toBe(true);
    const probed = await probeMedia(videoPath);
    expect(probed.hasVideo).toBe(true);
    expect(probed.hasAudio).toBe(true);
    expect([probed.width, probed.height]).toEqual([1280, 720]);
    expect(probed.duration).toBeGreaterThan(3.5);
    expect(probed.duration).toBeLessThan(4.5);

    // 4. It was uploaded to the channel, on that channel's own token, with the
    //    script's first line as the title.
    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0]!.title).toContain("It writes the hook first");
    expect(fake.uploads[0]!.initAuth).toMatch(/^Bearer /);
    expect(fake.uploads[0]!.bytes).toBeGreaterThan(10_000);
    expect(channels.channelFor(channel.id)!.lastVideoUrl).toMatch(/youtube\.com\/shorts\/vid-1$/);
  }, 180_000);

  it("refuses to invent footage when there is no window, and says why", async () => {
    settings.saveBrainSettings({ apiKey: "AIzaSySelfMarketing-test-012345wxyz" });
    const channel = connect("Soundwave Demos", "1//demos");
    fake.gemini.push(text(PROMO_SCRIPT), text(PROMO_SCRIPT));

    await expect(
      buildShortVideo({
        topic: "show how Soundwave AI makes a short",
        promo: true,
        selfRecord: true,
        aspect: "16:9",
        resolution: "720p",
        seconds: 30,
        autoPublishYouTube: true,
        youtubeChannelId: channel.id,
        userId: "marketer",
      }),
    ).rejects.toThrow(/only film myself inside the Soundwave desktop app/);

    // Nothing was uploaded, and no video was quietly shipped from other footage.
    expect(fake.uploads).toHaveLength(0);
    const store = await getStore();
    const failed = (await store.listJobs("marketer")).find((j) => (j.settings as unknown as { topic?: string }).topic?.includes("show how Soundwave AI makes a short"));
    expect(failed?.status).toBe("FAILED");
    expect(fs.existsSync(path.join(config.uploadsDir, `soundwave_short_${failed!.id}.mp4`))).toBe(false);
  }, 120_000);

  it("uses the channel's own privacy, and finds it by the name the agent says", async () => {
    settings.saveBrainSettings({ apiKey: "AIzaSySelfMarketing-test-012345wxyz" });
    const channel = connect("Facts Daily", "1//facts");
    channels.updateChannel(channel.id, { privacy: "unlisted", plan: { what: "space facts", auto: false } });
    hostRef.__soundwaveDesktopHost = { showWindow: () => undefined, captureWindow: async () => fs.readFileSync(PNG) };
    fake.gemini.push(text(PROMO_SCRIPT), text(PROMO_SCRIPT));

    const out = await buildShortVideo({
      topic: "space facts",
      promo: true,
      selfRecord: true,
      aspect: "16:9",
      resolution: "720p",
      seconds: 30,
      autoPublishYouTube: true,
      youtubeChannelId: "Facts Daily", // by name, the way the agent's tool passes it
      userId: "marketer",
    });

    const job = await getStore().then((s) => s.getJob(out.jobId, "marketer"));
    expect((job!.settings as unknown as Record<string, unknown>).youtubeChannel).toBe("Facts Daily");
    const init = fake.seen.filter((s) => s.path === "/upload/youtube/v3/videos");
    expect(init).toHaveLength(1);
    expect((init[0]!.body as { status: { privacyStatus: string } }).status.privacyStatus).toBe("unlisted");
  }, 180_000);
});
