// Morning Setup (lib/morning.ts) and "Connect YouTube account" (lib/youtubeOAuth.ts),
// against stand-ins for Gemini, Open-Meteo, Google's OAuth and the YouTube API.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { call, startFakeGoogle, text, useFakeGoogle, type FakeGoogle } from "./helpers/fakeGoogle.js";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests, getStore } = await import("../src/lib/store.js");
const settings = await import("../src/lib/brain/settings.js");
const memory = await import("../src/lib/memory.js");
const morning = await import("../src/lib/morning.js");
const conversation = await import("../src/lib/conversation.js");
const { youtubeService } = await import("../src/lib/youtube.js");
const oauth = await import("../src/lib/youtubeOAuth.js");
const coreMorning = await import("../src/lib/brain/core/morning.js");

const KEY = "AIzaSyMorningTest-0123456789-abcdwxyz";
let fake: FakeGoogle;
let app: ReturnType<typeof createApp>;
const opened: string[] = [];

beforeAll(async () => {
  fake = await startFakeGoogle();
  useFakeGoogle(config as unknown as Record<string, unknown>, fake);
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
});

afterAll(async () => {
  await fake.close();
  delete (globalThis as { __soundwaveDesktopHost?: unknown }).__soundwaveDesktopHost;
});

beforeEach(() => {
  fake.reset();
  settings.resetBrainSettingsForTests();
  memory.resetMemoryForTests();
  oauth.resetYouTubeConnectForTests();
  for (const f of ["morning.json", "agent-conversation.json", path.join("youtube", "youtube_config.json")]) fs.rmSync(path.join(config.dataDir, f), { force: true });
  conversation.resetConversationForTests();
  opened.length = 0;
  (globalThis as { __soundwaveDesktopHost?: unknown }).__soundwaveDesktopHost = {
    openExternal: async (url: string) => void opened.push(url),
    openPath: async () => "",
  };
});

const local = (req: request.Test) => req.set("Host", "127.0.0.1");

async function finishedShort(topic: string, extra: Record<string, unknown> = {}) {
  const store = await getStore();
  return store.createJob({
    projectId: null,
    userId: "local-user",
    status: "COMPLETED",
    progress: 100,
    settings: { topic, ...extra } as never,
    outputUrl: null,
    errorMessage: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
}

describe("Settings → Morning Setup", () => {
  it("starts with YouTube Studio and the time zone's city, and saves what you choose", async () => {
    const first = await local(request(app).get("/api/v1/morning"));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ city: null, openFromPhone: true, ideas: true, weatherCityAuto: true, canOpen: true });
    expect(first.body.items).toEqual([{ kind: "website", value: "https://studio.youtube.com", label: "studio.youtube.com" }]);

    const bad = await local(request(app).put("/api/v1/morning")).send({ items: [{ kind: "website", value: "javascript:alert(1)" }] });
    expect(bad.status).toBe(400);

    const saved = await local(request(app).put("/api/v1/morning")).send({
      city: "Kruševac, Serbia",
      items: [
        { kind: "website", value: "youtube.com/feed/subscriptions" },
        { kind: "app", value: "Spotify" },
      ],
      openFromPhone: false,
      ideas: true,
    });
    expect(saved.body).toMatchObject({ city: "Kruševac, Serbia", weatherCity: "Kruševac, Serbia", weatherCityAuto: false, openFromPhone: false });
    expect(saved.body.items).toEqual([
      { kind: "website", value: "https://youtube.com/feed/subscriptions", label: "youtube.com/feed/subscriptions" },
      { kind: "app", value: "Spotify", label: "Spotify" },
    ]);

    const weather = await local(request(app).post("/api/v1/morning/weather")).send({ city: "Kruševac, Serbia" });
    expect(weather.body).toMatchObject({ ok: true, weather: { place: "Kruševac", country: "Serbia", tempC: 14, highC: 19, lowC: 8, rainChance: 10, description: "partly cloudy" } });
    const geocode = fake.seen.find((s) => s.path === "/geocode")!;
    expect(geocode.query.get("name")).toBe("Kruševac");

    fake.weather.place = null;
    const unknown = await local(request(app).post("/api/v1/morning/weather")).send({ city: "Atlantis" });
    expect(unknown.body).toMatchObject({ ok: false, error: expect.stringMatching(/couldn't find a place called “Atlantis”/) });
  });
});

describe("running Morning Setup", () => {
  it("without a Gemini key: opens your morning items and reads the facts", async () => {
    morning.saveMorningSettings({ city: "Kruševac" });
    const job = await finishedShort("deep sea creatures", { youtubeUrl: "https://youtube.com/shorts/xyz" });
    const res = await local(request(app).post("/api/v1/morning/run"));
    expect(res.status).toBe(200);
    expect(opened).toEqual(["https://studio.youtube.com/"]);
    expect(res.body).toMatchObject({ success: true, action: "morning_setup", tag: "SYS" });
    expect(res.body.reply).toMatch(/^Good morning! It's \w+day \d+ \w+ \d{4}\./);
    expect(res.body.reply).toMatch(/In Kruševac it's 14°C and partly cloudy, today between 8 and 19°C, 10% chance of rain\./);
    expect(res.body.reply).toMatch(/your short about “deep sea creatures” finished \(on YouTube\)/);
    expect(res.body.reply).toMatch(/I opened studio\.youtube\.com on your PC\./);
    expect(res.body.reply).toMatch(/Add a Gemini key in Settings → Brain/);
    expect(res.body.actionOutput).toMatch(/Opened studio\.youtube\.com\nWeather: Kruševac, Serbia \(Open-Meteo\)/);
    expect(memory.lastMorningAt()).toBeGreaterThan(Date.now() - 5000);
    await (await getStore()).updateJob(job.id, { status: "FAILED" });
  });

  it("with Gemini and a linked channel: a briefing written from real facts, with three new ideas", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    morning.saveMorningSettings({ city: "Kruševac", items: [{ kind: "website", value: "https://studio.youtube.com" }] });
    youtubeService.saveConfig({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test", refreshToken: "1//fake-refresh" });
    memory.addNote("The user's channel is about space facts for teenagers");
    memory.noteMorningRun(Date.now() - 20 * 3_600_000);
    const job = await finishedShort("black holes");

    fake.gemini.push(text("Good morning! It's Friday. Idea 1: Why Saturn could float in a bathtub. Idea 2: … Idea 3: …"));
    const res = await local(request(app).post("/api/v1/morning/run"));
    expect(res.body.reply).toMatch(/^Good morning! It's Friday\. Idea 1/);

    const req = fake.generateCalls()[0]!;
    expect(req.path).toBe("/v1beta/models/gemini-3.8-flash:generateContent");
    // The briefing is written in the agent's current mode, after the fixed
    // briefing instruction (brain/core/morning.ts imports it into the request).
    const instruction = String(req.body.systemInstruction.parts[0].text);
    expect(instruction.startsWith(coreMorning.MORNING_INSTRUCTION)).toBe(true);
    expect(instruction).toMatch(/your mode is “/);
    const prompt = req.body.contents[0].parts[0].text as string;
    expect(prompt).toMatch(/Weather: In Kruševac it's 14°C and partly cloudy/);
    expect(prompt).toMatch(/Shorts since your last Morning Setup \(20 hours ago\):\n- finished: “black holes”/);
    expect(prompt).toMatch(/YouTube channel “Orbit Facts”: 1234 subscribers, 98765 total views, 42 videos\./);
    expect(prompt).toMatch(/- recent upload “Black holes in 60 seconds”: 4321 views, posted 2 days ago/);
    expect(prompt).toMatch(/Opened on the PC: studio\.youtube\.com\./);
    expect(prompt).toMatch(/Memory:\n- The user's channel is about space facts for teenagers/);
    expect(prompt).toMatch(/Ideas: yes — three new ones\. Already made \(don't repeat\): .*“black holes”/);
    // The YouTube numbers came with the refreshed token.
    expect(fake.seen.find((s) => s.path === "/youtube/v3/channels")!.headers.authorization).toBe("Bearer ya29.fake-access-2");
    await (await getStore()).updateJob(job.id, { status: "FAILED" });
  });

  it("from the phone: doesn't open things on the PC unless that's allowed", async () => {
    morning.saveMorningSettings({ openFromPhone: false });
    const facts = await morning.prepareMorning({ via: "phone" });
    expect(opened).toEqual([]);
    expect(facts).toMatchObject({ where: "phone", opened: [] });
    morning.saveMorningSettings({ openFromPhone: true });
    await morning.prepareMorning({ via: "phone" });
    expect(opened).toEqual(["https://studio.youtube.com/"]);
  });

  it("is one of the agent's tools: “good morning, set me up”", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    morning.saveMorningSettings({ city: "Kruševac" });
    fake.gemini.push(call("run_morning_setup", {}, "m1"), text("Good morning! Here's your briefing…"));
    const res = await request(app).post("/api/v1/agent/chat").send({ message: "good morning, run my morning setup" });
    expect(res.body).toMatchObject({ reply: "Good morning! Here's your briefing…", tag: "SYS", actionOutput: "Opened studio.youtube.com" });
    const facts = fake.generateCalls()[1]!.body.contents.at(-1).parts[0].functionResponse.response;
    expect(facts).toMatchObject({ where: "pc", weather: { place: "Kruševac" }, opened: [{ label: "studio.youtube.com", ok: true }], ideas: true });
  });
});

describe("Connect YouTube account (Google sign-in from the desktop app)", () => {
  it("needs the Client ID and secret first", async () => {
    const res = await local(request(app).post("/api/v1/youtube/connect"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NO_CLIENT");
  });

  it("signs in through the browser and saves the refresh token — no copying tokens", async () => {
    await request(app).post("/api/v1/youtube/config").send({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test-secret" });
    const start = await local(request(app).post("/api/v1/youtube/connect"));
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.url}/auth`);
    const q = url.searchParams;
    expect(q.get("client_id")).toBe("123-abc.apps.googleusercontent.com");
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(q.get("scope")).toBe("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge_method")).toBe("S256");

    // Google sends the browser back to http://127.0.0.1:<port>/?code=…&state=…
    const back = await request(app).get(`/?state=${encodeURIComponent(q.get("state")!)}&code=4%2Fauth-code&scope=youtube`);
    expect(back.status).toBe(200);
    expect(back.headers["content-type"]).toMatch(/html/);
    expect(back.text).toMatch(/YouTube is connected/);
    expect(back.text).toMatch(/Channel: <b>Orbit Facts<\/b>/);

    const exchange = fake.seen.find((s) => s.path === "/token")!;
    const form = new URLSearchParams(exchange.raw);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", code: "4/auth-code", client_secret: "GOCSPX-test-secret", redirect_uri: q.get("redirect_uri") });
    const challenge = createHash("sha256").update(form.get("code_verifier")!).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(challenge).toBe(q.get("code_challenge"));

    const status = await request(app).get("/api/v1/youtube/status");
    expect(status.body).toMatchObject({ connected: true, channelTitle: "Orbit Facts", hasRefreshToken: true });
    expect(youtubeService.getConfig().refreshToken).toBe("1//fake-refresh-token");

    // The same link can't be used twice.
    const replay = await request(app).get(`/?state=${encodeURIComponent(q.get("state")!)}&code=again`);
    expect(replay.status).toBe(404);
  });

  it("explains what to fix when Google says no", async () => {
    youtubeService.saveConfig({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test-secret" });
    const { url } = (await local(request(app).post("/api/v1/youtube/connect"))).body;
    const state = new URL(url).searchParams.get("state")!;
    const denied = await request(app).get(`/?state=${state}&error=access_denied`);
    expect(denied.status).toBe(400);
    expect(denied.text).toMatch(/test user/);

    const { url: url2 } = (await local(request(app).post("/api/v1/youtube/connect"))).body;
    fake.token.push(() => ({ status: 400, body: { error: "redirect_uri_mismatch", error_description: "Bad redirect" } }));
    const mismatch = await request(app).get(`/?state=${new URL(url2).searchParams.get("state")}&code=x`);
    expect(mismatch.text).toMatch(/isn&#39;t a “Desktop app”/);
  });

  it("forgets the old account's token when the credentials change", () => {
    youtubeService.saveConfig({ clientId: "a", clientSecret: "b", refreshToken: "1//old" });
    youtubeService.saveConfig({ accessToken: "ya29.old", tokenExpiry: Date.now() + 3_600_000, channelTitle: "Old channel" });
    youtubeService.saveConfig({ refreshToken: "1//new" });
    const cfg = youtubeService.getConfig();
    expect(cfg.accessToken).toBeUndefined();
    expect(cfg.channelTitle).toBeUndefined();
  });
});

describe("Morning Setup helpers", () => {
  it("knows the weather words, the default city and a no-key briefing", () => {
    expect(coreMorning.weatherWords(61)).toBe("light rain");
    expect(coreMorning.weatherWords(999)).toBe("changeable weather");
    expect(coreMorning.cityFromTimeZone("Europe/Belgrade")).toBe("Belgrade");
    expect(coreMorning.cityFromTimeZone("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(coreMorning.cityFromTimeZone("UTC")).toBeNull();
    const text = coreMorning.templateBriefing({
      now: "Friday 2 October 2026, 08:14",
      where: "phone-offline",
      weather: null,
      since: "in the last 24 hours",
      shorts: { finished: [], failed: [{ topic: "volcanoes" }], rendering: null, total: 3 },
      backgroundsLeft: 4,
      youtube: null,
      opened: [],
      memory: "",
      madeTopics: [],
      ideas: false,
      topics: [{ topic: "open-source AI tools", summary: "Ollama 1.0 shipped with a new model library.\nLlama 5 weights were released.", sources: [], via: "search" }],
    });
    expect(text).toBe(
      "Good morning! It's Friday 2 October 2026. In the last 24 hours: “volcanoes” didn't finish. Only 4 unused backgrounds are left. On open-source AI tools: Ollama 1.0 shipped with a new model library. Llama 5 weights were released. Want me to make a short today?",
    );
  });
});
