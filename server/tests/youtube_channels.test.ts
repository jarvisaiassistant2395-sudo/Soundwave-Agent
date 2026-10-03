// Several YouTube channels at once: each one keeps its own sign-in (its own
// refresh token), its own privacy default, and its own instruction about what
// to publish there. The single connection the app had before becomes the
// "default" channel, so nothing that worked yesterday stops working.
// Gemini/YouTube are stand-ins on loopback (helpers/fakeGoogle.ts).
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1"; // Settings → Brain / PC tools available
});

const mocks = vi.hoisted(() => ({
  startShortJob: vi.fn(async (_p: Record<string, unknown>) => ({ jobId: "job-plan-1" })),
  getActiveShortJobs: vi.fn((): Array<{ jobId: string; topic: string; startedAt: number }> => []),
}));

vi.mock("../src/routes/agentShort.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/agentShort.js")>();
  return { ...actual, startShortJob: mocks.startShortJob, getActiveShortJobs: mocks.getActiveShortJobs };
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const { startFakeGoogle, useFakeGoogle, call, text } = await import("./helpers/fakeGoogle.js");
const settings = await import("../src/lib/brain/settings.js");
const channels = await import("../src/lib/youtubeChannels.js");
const { youtubeService } = await import("../src/lib/youtube.js");
const { buildPromoInstruction, PROMO_FEATURES } = await import("../src/lib/brain/core/promo.js");
const plans = await import("../src/lib/publishPlan.js");

const KEY = "AIzaSyCHANNELS-test-000000wxyz";

let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
let app: ReturnType<typeof createApp>;

const SAMPLE = path.join(config.uploadsDir, "channel-test.mp4");

beforeAll(async () => {
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  fake = await startFakeGoogle();
  useFakeGoogle(config as unknown as Record<string, unknown>, fake);
  app = createApp();
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.writeFileSync(SAMPLE, Buffer.alloc(64 * 1024, 7)); // the upload path only checks existence/size
});

afterAll(async () => {
  await fake.close();
  fs.rmSync(SAMPLE, { force: true });
});

beforeEach(() => {
  fake.reset();
  settings.resetBrainSettingsForTests();
  channels.resetChannelsForTests();
  // The YouTube connection lives in the shared data dir too: another file's
  // leftover sign-in must not show up as a "legacy" channel here.
  youtubeService.saveConfig({ clientId: "", clientSecret: "", refreshToken: "", channelTitle: undefined, channelId: undefined, autoPublish: false });
  delete (globalThis as { __soundwaveDesktopHost?: unknown }).__soundwaveDesktopHost;
  mocks.startShortJob.mockClear();
  mocks.getActiveShortJobs.mockReset();
  mocks.getActiveShortJobs.mockReturnValue([]);
});

/** Sign a channel in the way the real flow does (register after Google answers). */
function connect(name: string, channelId: string, token: string) {
  youtubeService.saveConfig({ clientId: "cid.apps.googleusercontent.com", clientSecret: "s3cret", refreshToken: token, clientSource: "own", connectedClientId: "cid.apps.googleusercontent.com" });
  return channels.registerChannel({ refreshToken: token, channelTitle: name, channelId, clientSource: "own", connectedClientId: "cid.apps.googleusercontent.com" });
}

describe("connected channels", () => {
  it("turns the app's original single connection into the default channel", () => {
    youtubeService.saveConfig({
      clientId: "cid.apps.googleusercontent.com",
      clientSecret: "s3cret",
      refreshToken: "1//legacy-token",
      channelTitle: "My Main Channel",
      channelId: "UCmain",
    });
    const list = channels.listChannels();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "default", name: "My Main Channel", channelId: "UCmain" });
    expect(channels.defaultChannelId()).toBe("default");
  });

  it("keeps both channels when a second one is connected", () => {
    const first = connect("Main Channel", "UCmain", "1//main");
    const second = channels.registerChannel({ refreshToken: "1//demos", channelTitle: "Soundwave Demos", channelId: "UCdemos" });
    const list = channels.listChannels();
    expect(list.map((c) => c.name)).toEqual(["Main Channel", "Soundwave Demos"]);
    expect(channels.defaultChannelId()).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    // The first one is still the default until someone says otherwise.
    expect(channels.channelFor(null)!.name).toBe("Main Channel");
    expect(channels.channelFor("soundwave demos")!.id).toBe(second.id);
    expect(channels.channelFor("UCdemos")!.id).toBe(second.id);
  });

  it("re-connecting the same channel updates it instead of duplicating it", () => {
    connect("Main Channel", "UCmain", "1//main");
    channels.registerChannel({ refreshToken: "1//main-again", channelTitle: "Main Channel renamed", channelId: "UCmain" });
    const list = channels.listChannels();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Main Channel renamed", refreshToken: "1//main-again" });
  });

  it("never hands the refresh tokens back to the app", async () => {
    connect("Main Channel", "UCmain", "1//main");
    const res = await request(app).get("/api/v1/youtube/channels");
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("1//main");
  });

  it("mints a token per channel, from that channel's own sign-in", async () => {
    const main = connect("Main Channel", "UCmain", "1//main");
    const demos = channels.registerChannel({ refreshToken: "1//demos", channelTitle: "Soundwave Demos", channelId: "UCdemos" });

    await channels.accessTokenFor(main);
    await channels.accessTokenFor(demos);
    const refreshes = fake.seen.filter((s) => s.path === "/token").map((s) => new URLSearchParams(s.raw).get("refresh_token"));
    expect(refreshes).toEqual(["1//main", "1//demos"]);
  });

  it("uploads to the channel whose token it was given", async () => {
    const main = connect("Main Channel", "UCmain", "1//main");
    const demos = channels.registerChannel({ refreshToken: "1//demos", channelTitle: "Soundwave Demos", channelId: "UCdemos" });

    const first = await youtubeService.uploadWithToken(await channels.accessTokenFor(main), { videoPath: SAMPLE, title: "One", privacy: "public" });
    const second = await youtubeService.uploadWithToken(await channels.accessTokenFor(demos), { videoPath: SAMPLE, title: "Two", privacy: "unlisted" });

    expect(first.videoId).toBe("vid-1");
    expect(second.videoId).toBe("vid-2");
    expect(fake.uploads).toHaveLength(2);
    // Both uploads really carried the file, each on a real bearer token.
    expect(fake.uploads.map((u) => [u.title, u.initAuth])).toEqual([
      ["One #shorts #viral", "Bearer ya29.fake-access-2"],
      ["Two #shorts #viral", "Bearer ya29.fake-access-2"],
    ]);
    expect(fake.uploads.every((u) => u.bytes === 64 * 1024)).toBe(true);
  });

  it("removing the original connection really disconnects it", () => {
    connect("Main Channel", "UCmain", "1//main");
    channels.registerChannel({ refreshToken: "1//demos", channelTitle: "Soundwave Demos", channelId: "UCdemos" });

    expect(channels.removeChannel("default")).toBe(true);
    expect(channels.listChannels().map((c) => c.name)).toEqual(["Soundwave Demos"]);
    expect(youtubeService.getConfig().refreshToken).toBe("");
    expect(channels.removeChannel("nope")).toBe(false);
  });
});

describe("what to publish on which channel", () => {
  it("saves the instruction and reports when it runs next", async () => {
    const demo = connect("Soundwave Demos", "UCdemos", "1//demos");
    const res = await request(app)
      .patch(`/api/v1/youtube/channels/${demo.id}`)
      .send({ plan: { what: "demos of the app making a short in one press", kind: "demo", everyDays: 3, auto: true, time: "18:00" } });
    expect(res.status).toBe(200);
    const saved = res.body.channels.find((c: { id: string }) => c.id === demo.id);
    expect(saved.plan).toMatchObject({ what: "demos of the app making a short in one press", kind: "demo", everyDays: 3, auto: true, time: "18:00" });
    expect(res.body.plan.active).toHaveLength(1);
  });

  it("turns a channel's plan into the right kind of video", () => {
    const channel = connect("Soundwave Demos", "UCdemos", "1//demos");
    channels.updateChannel(channel.id, { plan: { what: "demos of the app", kind: "demo", auto: true } });
    const request = plans.planRequest(channels.channelFor(channel.id)!);
    expect(request).toMatchObject({ topic: "demos of the app", promo: true, selfRecord: true, aspect: "16:9", autoPublishYouTube: true, youtubeChannelId: channel.id });

    channels.updateChannel(channel.id, { plan: { kind: "short", what: "space facts" } });
    const short = plans.planRequest(channels.channelFor(channel.id)!);
    expect(short).toMatchObject({ topic: "space facts", promo: false, selfRecord: false, aspect: "9:16" });
  });

  it("is due immediately, then waits the channel's own number of days", () => {
    const channel = connect("Facts Daily", "UCfacts", "1//facts");
    channels.updateChannel(channel.id, { plan: { what: "space facts", kind: "short", auto: true, everyDays: 2 } });
    const now = new Date();
    expect(channels.planDue(channels.channelFor(channel.id)!.plan, now)).toBe(true);

    channels.notePlanRun(channel.id, now.getTime());
    const after = channels.channelFor(channel.id)!;
    expect(after.plan.runs).toBe(1);
    expect(channels.planDue(after.plan, now)).toBe(false);
    expect(channels.planDue(after.plan, new Date(now.getTime() + 2 * 86_400_000))).toBe(true);
  });

  it("respects the time of day it was given", () => {
    const channel = connect("Evening", "UCevening", "1//evening");
    channels.updateChannel(channel.id, { plan: { what: "stories", auto: true, everyDays: 1, time: "18:00" } });
    const plan = channels.channelFor(channel.id)!.plan;
    const morning = new Date();
    morning.setHours(9, 0, 0, 0);
    const evening = new Date();
    evening.setHours(19, 0, 0, 0);
    expect(channels.planDue(plan, morning)).toBe(false);
    expect(channels.planDue(plan, evening)).toBe(true);
  });

  it("does nothing at all without a plan, and says what's missing", async () => {
    connect("Idle", "UCidle", "1//idle");
    settings.saveBrainSettings({ apiKey: KEY });
    expect(await plans.runDuePlans()).toEqual([]);
    expect(mocks.startShortJob).not.toHaveBeenCalled();
    expect(plans.planStatus().blocked).toMatch(/No channel has a plan/);
  });

  it("makes the video for a due channel and posts it there", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    const channel = connect("Soundwave Demos", "UCdemos", "1//demos");
    channels.updateChannel(channel.id, { plan: { what: "show how I make a short", kind: "demo", auto: true, everyDays: 1 } });

    const started = await plans.runDuePlans();
    expect(started).toHaveLength(1);
    expect(mocks.startShortJob).toHaveBeenCalledTimes(1);
    expect(mocks.startShortJob.mock.calls[0]![0]).toMatchObject({
      topic: "show how I make a short",
      promo: true,
      selfRecord: true,
      aspect: "16:9",
      autoPublishYouTube: true,
      youtubeChannelId: channel.id,
    });
    // It ran once, so it isn't due again right now.
    expect(channels.planDue(channels.channelFor(channel.id)!.plan)).toBe(false);
  });

  it("won't start a second video while one is rendering", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    const channel = connect("Soundwave Demos", "UCdemos", "1//demos");
    channels.updateChannel(channel.id, { plan: { what: "demos", auto: true, everyDays: 1 } });
    mocks.getActiveShortJobs.mockReturnValue([{ jobId: "job-busy", topic: "something else", startedAt: Date.now() }]);
    expect(await plans.runDuePlans()).toEqual([]);
    expect(mocks.startShortJob).not.toHaveBeenCalled();
  });

  it("says so when it can't run a plan without a Gemini key", async () => {
    const channel = connect("Soundwave Demos", "UCdemos", "1//demos");
    channels.updateChannel(channel.id, { plan: { what: "demos", auto: true, everyDays: 1 } });
    expect(await plans.runDuePlans()).toEqual([]);
    expect(plans.planStatus().blocked).toMatch(/Gemini API key/);
  });

  it("starts a demo right now when asked (the button / the tool)", async () => {
    const channel = connect("Soundwave Demos", "UCdemos", "1//demos");
    const started = await plans.startDemo({ channelId: channel.id });
    expect(started).toMatchObject({ jobId: "job-plan-1", channelId: channel.id, channelName: "Soundwave Demos" });
    expect(mocks.startShortJob.mock.calls.at(-1)![0]).toMatchObject({ promo: true, selfRecord: true, aspect: "16:9", youtubeChannelId: channel.id });
  });
});

describe("the pitch it writes for itself", () => {
  it("only allows claims that are in the shipped feature list", () => {
    const brief = buildPromoInstruction({ seconds: 60, subject: "demo", what: "show one-press shorts", showsAppOnScreen: true });
    for (const feature of PROMO_FEATURES) expect(brief).toContain(feature);
    expect(brief).toMatch(/Never invent users, testimonials, download numbers/);
    expect(brief).toMatch(/Never claim a feature that is not in the list/);
    expect(brief).toMatch(/no call to action/i);
  });

  it("describes what is on screen when the picture is the app", () => {
    const brief = buildPromoInstruction({ seconds: 30, subject: "demo", what: "x", showsAppOnScreen: true });
    expect(brief).toMatch(/real recording of the app's own window/);
    expect(brief).toContain("63–78 words");
  });

  it("never pitches something the app doesn't do", () => {
    const all = PROMO_FEATURES.join(" ").toLowerCase();
    for (const never of ["wake word", "voice cloning", "clone your voice", "download any video", "download video", "subscribe", "free trial", "best on the market"]) {
      expect(all).not.toContain(never);
    }
  });
});

describe("the agent's own tools for this", () => {
  it("lists channels and their plans without leaking sign-ins", async () => {
    const channel = connect("Soundwave Demos", "UCdemos", "1//demos");
    channels.updateChannel(channel.id, { plan: { what: "app demos", kind: "demo", auto: true, everyDays: 2 } });
    const { toolsFor } = await import("../src/lib/brain/tools.js");
    const tool = toolsFor({ userId: "u", voice: "en-US-GuyNeural", resolution: "1080p", seconds: 60, desktop: true, platform: "linux", effects: { log: [] } } as never).find(
      (t) => t.declaration.name === "list_youtube_channels",
    )!;
    const result = await tool.run({}, {} as never);
    expect(result.connected).toBe(true);
    expect((result.channels as Array<{ name: string }>)[0]!.name).toBe("Soundwave Demos");
    expect(JSON.stringify(result)).not.toContain("1//");
  });

  it("sets a channel's plan from a sentence, and can turn it off", async () => {
    const channel = connect("Soundwave Demos", "UCdemos", "1//demos");
    const { toolsFor } = await import("../src/lib/brain/tools.js");
    const tool = toolsFor({ userId: "u", voice: "en-US-GuyNeural", resolution: "1080p", seconds: 60, desktop: true, platform: "linux", effects: { log: [] } } as never).find(
      (t) => t.declaration.name === "set_channel_plan",
    )!;

    const set = await tool.run({ channel: "Soundwave Demos", what: "demos of the app", kind: "demo", every_days: 2 }, {} as never);
    expect(set.ok).toBe(true);
    expect(channels.channelFor(channel.id)!.plan).toMatchObject({ what: "demos of the app", kind: "demo", everyDays: 2, auto: true });

    const off = await tool.run({ channel: "Soundwave Demos", what: "demos of the app", auto: false }, {} as never);
    expect(off.ok).toBe(true);
    expect(channels.channelFor(channel.id)!.plan.auto).toBe(false);

    const missing = await tool.run({ channel: "Nope", what: "x" }, {} as never);
    expect(missing.ok).toBe(false);
    expect(String(missing.reason)).toContain("Soundwave Demos");
  });
});

describe("the channels API", () => {
  it("lists channels, marks the default, and can move it", async () => {
    connect("Main Channel", "UCmain", "1//main");
    const demos = channels.registerChannel({ refreshToken: "1//demos", channelTitle: "Soundwave Demos", channelId: "UCdemos" });

    const before = await request(app).get("/api/v1/youtube/channels");
    expect(before.body.defaultId).toBe("default");
    expect(before.body.channels.map((c: { default: boolean }) => c.default)).toEqual([true, false]);

    const moved = await request(app).post(`/api/v1/youtube/channels/${demos.id}/default`);
    expect(moved.status).toBe(200);
    expect(moved.body.defaultId).toBe(demos.id);
    expect(channels.channelFor(null)!.id).toBe(demos.id);
  });

  it("runs one channel's plan right now, from the channel's own instruction", async () => {
    const channel = connect("Soundwave Demos", "UCdemos", "1//demos");
    channels.updateChannel(channel.id, { plan: { what: "show the one-press flow", kind: "demo", auto: true, everyDays: 3 } });

    const res = await request(app).post(`/api/v1/youtube/channels/${channel.id}/publish-plan`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, jobId: "job-plan-1", aspect: "16:9", selfRecord: true });
    expect(mocks.startShortJob.mock.calls.at(-1)![0]).toMatchObject({
      topic: "show the one-press flow",
      promo: true,
      selfRecord: true,
      youtubeChannelId: channel.id,
      autoPublishYouTube: true,
    });
  });

  it("refuses a plan for a channel it doesn't have", async () => {
    const res = await request(app).post("/api/v1/youtube/channels/ch_missing/publish-plan");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NO_CHANNEL");
  });

  it("deletes a channel and everything it was told to do", async () => {
    const channel = connect("Soundwave Demos", "UCdemos", "1//demos");
    channels.updateChannel(channel.id, { plan: { what: "demos", auto: true, everyDays: 1 } });

    const res = await request(app).delete(`/api/v1/youtube/channels/${channel.id}`);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(0);
    expect(plans.planStatus().blocked).toMatch(/No channel has a plan/);

    const gone = await request(app).delete("/api/v1/youtube/channels/ch_missing");
    expect(gone.status).toBe(404);
  });
});

describe("the API for the Record-a-demo button", () => {
  it("refuses honestly when there is no window to film", async () => {
    const res = await request(app).post("/api/v1/youtube/demo").send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NO_WINDOW");
    expect(res.body.error.message).toMatch(/desktop app/);
  });

  it("records when the app really provides a window", async () => {
    const host = { captureWindow: async () => Buffer.alloc(2048), showWindow: () => undefined };
    (globalThis as { __soundwaveDesktopHost?: unknown }).__soundwaveDesktopHost = host;
    try {
      connect("Soundwave Demos", "UCdemos", "1//demos");
      const res = await request(app).post("/api/v1/youtube/demo").send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, jobId: "job-plan-1" });
      expect(mocks.startShortJob.mock.calls.at(-1)![0]).toMatchObject({ promo: true, selfRecord: true });
    } finally {
      delete (globalThis as { __soundwaveDesktopHost?: unknown }).__soundwaveDesktopHost;
    }
  });
});

describe("Gemini can drive it too", () => {
  it("publishing to a named channel reaches the tool", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    const channel = connect("Soundwave Demos", "UCdemos", "1//demos");
    fake.gemini.push(call("make_youtube_short", { topic: "how one press makes a short", channel: "Soundwave Demos" }, "c1"));
    fake.gemini.push(text("On it."));

    const res = await request(app).post("/api/v1/agent/chat").send({ message: "put a short about one-press shorts on my Soundwave Demos channel" });
    expect(res.status).toBe(200);
    const started = mocks.startShortJob.mock.calls.at(-1)![0] as { youtubeChannelId?: string; autoPublishYouTube?: boolean; topic: string };
    expect(started.topic).toBe("how one press makes a short");
    expect(started.youtubeChannelId).toBe(channel.id);
    expect(started.autoPublishYouTube).toBe(true);
  });
});
