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
    const second = channels.registerChannel({ refreshToken: "1//second", channelTitle: "Second Channel", channelId: "UCsecond" });
    const list = channels.listChannels();
    expect(list.map((c) => c.name)).toEqual(["Main Channel", "Second Channel"]);
    expect(channels.defaultChannelId()).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    // The first one is still the default until someone says otherwise.
    expect(channels.channelFor(null)!.name).toBe("Main Channel");
    expect(channels.channelFor("second channel")!.id).toBe(second.id);
    expect(channels.channelFor("UCsecond")!.id).toBe(second.id);
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
    const demos = channels.registerChannel({ refreshToken: "1//second", channelTitle: "Second Channel", channelId: "UCsecond" });

    await channels.accessTokenFor(main);
    await channels.accessTokenFor(demos);
    const refreshes = fake.seen.filter((s) => s.path === "/token").map((s) => new URLSearchParams(s.raw).get("refresh_token"));
    expect(refreshes).toEqual(["1//main", "1//second"]);
  });

  it("uploads to the channel whose token it was given", async () => {
    const main = connect("Main Channel", "UCmain", "1//main");
    const demos = channels.registerChannel({ refreshToken: "1//second", channelTitle: "Second Channel", channelId: "UCsecond" });

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
    expect(fake.uploads.map((u) => u.description)).toEqual(["One", "Two"]);
    expect(fake.uploads.every((u) => !u.description?.includes("Made with Soundwave"))).toBe(true);
    expect(fake.uploads.every((u) => u.bytes === 64 * 1024)).toBe(true);
  });

  it("removing the original connection really disconnects it", () => {
    connect("Main Channel", "UCmain", "1//main");
    channels.registerChannel({ refreshToken: "1//second", channelTitle: "Second Channel", channelId: "UCsecond" });

    expect(channels.removeChannel("default")).toBe(true);
    expect(channels.listChannels().map((c) => c.name)).toEqual(["Second Channel"]);
    expect(youtubeService.getConfig().refreshToken).toBe("");
    expect(channels.removeChannel("nope")).toBe(false);
  });
});

describe("scheduled YouTube Shorts", () => {
  it("saves a regular Shorts topic and reports when it runs next", async () => {
    const channel = connect("Facts Daily", "UCfacts", "1//facts");
    const res = await request(app)
      .patch(`/api/v1/youtube/channels/${channel.id}`)
      .send({ plan: { what: "space facts", everyDays: 3, auto: true, time: "18:00" } });
    expect(res.status).toBe(200);
    const saved = res.body.channels.find((c: { id: string }) => c.id === channel.id);
    expect(saved.plan).toMatchObject({ what: "space facts", everyDays: 3, auto: true, time: "18:00" });
    expect(saved.plan).not.toHaveProperty("kind");
    expect(res.body.plan.active).toHaveLength(1);
  });

  it("builds a normal vertical Short for the channel's chosen topic", () => {
    const channel = connect("Facts Daily", "UCfacts", "1//facts");
    channels.updateChannel(channel.id, { plan: { what: "space facts", auto: true } });
    expect(plans.planRequest(channels.channelFor(channel.id)!)).toEqual({
      topic: "space facts",
      autoPublishYouTube: true,
      youtubeChannelId: channel.id,
    });
  });

  it("migrates and disables an old self-recorded marketing plan", async () => {
    const channel = connect("Main Channel", "UCmain", "1//main");
    const file = path.join(config.dataDir, "youtube", "channels.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.channels[0].plan = {
      what: "Soundwave app demos",
      kind: "demo",
      auto: true,
      everyDays: 2,
      time: "18:00",
      lastRunAt: Date.now() - 2 * 86_400_000,
      runs: 4,
      lastError: null,
    };
    fs.writeFileSync(file, JSON.stringify(saved), "utf8");

    const upgraded = channels.channelFor(channel.id)!.plan;
    expect(upgraded).toMatchObject({ what: "", auto: false, everyDays: 3, time: "", lastRunAt: null, runs: 0 });
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(persisted.channels[0].plan).not.toHaveProperty("kind");
    expect(plans.planStatus().active).toHaveLength(0);

    settings.saveBrainSettings({ apiKey: KEY });
    expect(await plans.runDuePlans()).toEqual([]);
    expect(mocks.startShortJob).not.toHaveBeenCalled();
  });

  it("is due immediately, then waits the channel's own number of days", () => {
    const channel = connect("Facts Daily", "UCfacts", "1//facts");
    channels.updateChannel(channel.id, { plan: { what: "space facts", auto: true, everyDays: 2 } });
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

  it("makes the Short for a due channel and posts it there", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    const channel = connect("Facts Daily", "UCfacts", "1//facts");
    channels.updateChannel(channel.id, { plan: { what: "space facts", auto: true, everyDays: 1 } });

    const started = await plans.runDuePlans();
    expect(started).toHaveLength(1);
    expect(mocks.startShortJob).toHaveBeenCalledTimes(1);
    expect(mocks.startShortJob.mock.calls[0]![0]).toEqual({
      topic: "space facts",
      autoPublishYouTube: true,
      youtubeChannelId: channel.id,
      userId: "agent-local",
    });
    expect(channels.planDue(channels.channelFor(channel.id)!.plan)).toBe(false);
  });

  it("won't start a second video while one is rendering", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    const channel = connect("Facts Daily", "UCfacts", "1//facts");
    channels.updateChannel(channel.id, { plan: { what: "space facts", auto: true, everyDays: 1 } });
    mocks.getActiveShortJobs.mockReturnValue([{ jobId: "job-busy", topic: "something else", startedAt: Date.now() }]);
    expect(await plans.runDuePlans()).toEqual([]);
    expect(mocks.startShortJob).not.toHaveBeenCalled();
  });

  it("says so when it can't run a plan without a Gemini key", async () => {
    const channel = connect("Facts Daily", "UCfacts", "1//facts");
    channels.updateChannel(channel.id, { plan: { what: "space facts", auto: true, everyDays: 1 } });
    expect(await plans.runDuePlans()).toEqual([]);
    expect(plans.planStatus().blocked).toMatch(/Gemini API key/);
  });
});



describe("channel planning tools", () => {
  it("lists channels and plans without leaking sign-ins or exposing self-promotion", async () => {
    const channel = connect("Facts Daily", "UCfacts", "1//facts");
    channels.updateChannel(channel.id, { plan: { what: "space facts", auto: true, everyDays: 2 } });
    const { toolsFor } = await import("../src/lib/brain/tools.js");
    const tools = toolsFor({ userId: "u", voice: "en-US-GuyNeural", resolution: "1080p", seconds: 60, desktop: true, platform: "linux", effects: { log: [] } } as never);
    expect(tools.map((t) => t.declaration.name)).not.toContain("record_demo");
    const tool = tools.find((t) => t.declaration.name === "list_youtube_channels")!;
    const result = await tool.run({}, {} as never);
    expect(result.connected).toBe(true);
    expect((result.channels as Array<{ name: string }>)[0]!.name).toBe("Facts Daily");
    expect(JSON.stringify(result)).not.toContain("1//");
  });

  it("sets a normal Shorts schedule from a sentence, and can turn it off", async () => {
    const channel = connect("Facts Daily", "UCfacts", "1//facts");
    const { toolsFor } = await import("../src/lib/brain/tools.js");
    const tool = toolsFor({ userId: "u", voice: "en-US-GuyNeural", resolution: "1080p", seconds: 60, desktop: true, platform: "linux", effects: { log: [] } } as never).find(
      (t) => t.declaration.name === "set_channel_plan",
    )!;
    const props = (tool.declaration.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty("kind");

    const set = await tool.run({ channel: "Facts Daily", what: "space facts", every_days: 2 }, {} as never);
    expect(set.ok).toBe(true);
    expect(channels.channelFor(channel.id)!.plan).toMatchObject({ what: "space facts", everyDays: 2, auto: true });

    const off = await tool.run({ channel: "Facts Daily", what: "space facts", auto: false }, {} as never);
    expect(off.ok).toBe(true);
    expect(channels.channelFor(channel.id)!.plan.auto).toBe(false);

    const missing = await tool.run({ channel: "Nope", what: "x" }, {} as never);
    expect(missing.ok).toBe(false);
    expect(String(missing.reason)).toContain("Facts Daily");
  });
});

describe("the channels API", () => {
  it("lists channels, marks the default, and can move it", async () => {
    connect("Main Channel", "UCmain", "1//main");
    const demos = channels.registerChannel({ refreshToken: "1//second", channelTitle: "Second Channel", channelId: "UCsecond" });

    const before = await request(app).get("/api/v1/youtube/channels");
    expect(before.body.defaultId).toBe("default");
    expect(before.body.channels.map((c: { default: boolean }) => c.default)).toEqual([true, false]);

    const moved = await request(app).post(`/api/v1/youtube/channels/${demos.id}/default`);
    expect(moved.status).toBe(200);
    expect(moved.body.defaultId).toBe(demos.id);
    expect(channels.channelFor(null)!.id).toBe(demos.id);
  });

  it("rejects the removed demo kind instead of scheduling old marketing content", async () => {
    const channel = connect("Main Channel", "UCmain", "1//main");
    const res = await request(app).patch(`/api/v1/youtube/channels/${channel.id}`).send({
      plan: { what: "Soundwave app demos", kind: "demo", auto: true },
    });
    expect(res.status).toBe(400);
    expect(channels.channelFor(channel.id)!.plan.auto).toBe(false);
  });

  it("runs one channel's plan right now, from the channel's own instruction", async () => {
    const channel = connect("Second Channel", "UCsecond", "1//second");
    channels.updateChannel(channel.id, { plan: { what: "space facts", auto: true, everyDays: 3 } });

    const res = await request(app).post(`/api/v1/youtube/channels/${channel.id}/publish-plan`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, jobId: "job-plan-1" });
    expect(mocks.startShortJob.mock.calls.at(-1)![0]).toEqual({
      topic: "space facts",
      youtubeChannelId: channel.id,
      autoPublishYouTube: true,
      userId: "agent-local",
    });
  });

  it("refuses a plan for a channel it doesn't have", async () => {
    const res = await request(app).post("/api/v1/youtube/channels/ch_missing/publish-plan");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NO_CHANNEL");
  });

  it("deletes a channel and everything it was told to do", async () => {
    const channel = connect("Second Channel", "UCsecond", "1//second");
    channels.updateChannel(channel.id, { plan: { what: "demos", auto: true, everyDays: 1 } });

    const res = await request(app).delete(`/api/v1/youtube/channels/${channel.id}`);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(0);
    expect(plans.planStatus().blocked).toMatch(/No channel has a plan/);

    const gone = await request(app).delete("/api/v1/youtube/channels/ch_missing");
    expect(gone.status).toBe(404);
  });
});

describe("retired self-promotion endpoints", () => {
  it("no longer exposes the app-recording demo route", async () => {
    const res = await request(app).post("/api/v1/youtube/demo").send({});
    expect(res.status).toBe(404);
  });
});

describe("Gemini can drive it too", () => {
  it("publishing to a named channel reaches the tool", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    const channel = connect("Second Channel", "UCsecond", "1//second");
    fake.gemini.push(call("make_youtube_short", { topic: "how one press makes a short", channel: "Second Channel" }, "c1"));
    fake.gemini.push(text("On it."));

    const res = await request(app).post("/api/v1/agent/chat").send({ message: "put a short about one-press shorts on my Second Channel channel" });
    expect(res.status).toBe(200);
    const started = mocks.startShortJob.mock.calls.at(-1)![0] as { youtubeChannelId?: string; autoPublishYouTube?: boolean; topic: string };
    expect(started.topic).toBe("how one press makes a short");
    expect(started.youtubeChannelId).toBe(channel.id);
    expect(started.autoPublishYouTube).toBe(true);
  });
});
