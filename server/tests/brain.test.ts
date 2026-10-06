// The agent's brain (lib/brain): Settings → Brain, and chat answered by
// Gemini through a fake Gemini API on loopback — the requests are checked
// against the JSON the official @google/genai SDK sends.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => {
  // The desktop app: Settings → Brain is available, PC tools may be offered.
  process.env.DESKTOP_APP = "1";
  return {
    startShortJob: vi.fn(async (_p: Record<string, unknown>) => ({ jobId: "job-test-1" })),
    getActiveShortJobs: vi.fn((): Array<{ jobId: string; topic: string; startedAt: number }> => []),
    synthesizeEdgeTTS: vi.fn(async () => {
      throw new Error("no voice service in tests");
    }),
  };
});

vi.mock("../src/routes/agentShort.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/agentShort.js")>();
  return { ...actual, startShortJob: mocks.startShortJob, getActiveShortJobs: mocks.getActiveShortJobs };
});

vi.mock("../src/lib/edgeTts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/edgeTts.js")>();
  return { ...actual, synthesizeEdgeTTS: mocks.synthesizeEdgeTTS };
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests, getStore } = await import("../src/lib/store.js");
const settings = await import("../src/lib/brain/settings.js");
const gemini = await import("../src/lib/brain/gemini.js");
const prompt = await import("../src/lib/brain/prompt.js");
const pc = await import("../src/lib/brain/pc.js");
const { writeShortScript } = await import("../src/lib/brain/script.js");
const trends = await import("../src/lib/trends.js");
const viral = await import("../src/lib/brain/core/viral.js");
const { contentsFor, buildRequest } = await import("../src/lib/brain/chat.js");
const { buildShortVideo } = await import("../src/routes/agentShort.js");

// ── A fake Gemini API ───────────────────────────────────────────────────────

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
type Reply = { status?: number; body: unknown };

const fake = {
  seen: [] as Seen[],
  queue: [] as Array<(req: Seen) => Reply>,
  url: "",
};

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const seen: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : null };
    fake.seen.push(seen);
    const next = fake.queue.shift();
    const out = next ? next(seen) : { status: 500, body: { error: { code: 500, message: "test: nothing queued", status: "INTERNAL" } } };
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
});

const text = (t: string, sig = "c2lnLXRleHQ=") => () => ({
  body: { candidates: [{ content: { role: "model", parts: [{ text: t, thoughtSignature: sig }] }, finishReason: "STOP" }], modelVersion: "fake" },
});
const call = (name: string, args: Record<string, unknown>, id: string, sig: string) => () => ({
  body: { candidates: [{ content: { role: "model", parts: [{ functionCall: { id, name, args }, thoughtSignature: sig }] }, finishReason: "STOP" }] },
});
const googleError = (status: number, statusName: string, message: string, details: unknown[] = []) => () => ({
  status,
  body: { error: { code: status, message, status: statusName, details } },
});
const quotaPerDay = googleError(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota.\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 20\nPlease retry in 41.5s.", [
  { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
  { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" },
]);

const KEY = "AIzaSyTestKey-0123456789-abcdwxyz";
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (config as { geminiApiBase: string }).geminiApiBase = fake.url;
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  settings.resetBrainSettingsForTests();
  // The trend digest lives in the shared data dir (lib/trends.ts) — no test
  // here should be written to whatever another file researched.
  trends.resetTrendsForTests();
  fake.seen.length = 0;
  fake.queue.length = 0;
  mocks.startShortJob.mockClear();
  mocks.getActiveShortJobs.mockReset();
  mocks.getActiveShortJobs.mockReturnValue([]);
  delete (globalThis as { __soundwaveDesktopHost?: unknown }).__soundwaveDesktopHost;
});

const chat = (message: string, extra: Record<string, unknown> = {}) => request(app).post("/api/v1/agent/chat").send({ message, ...extra });
const generateCalls = () => fake.seen.filter((s) => s.url.includes(":generateContent"));

// ── Settings → Brain ────────────────────────────────────────────────────────

describe("Settings → Brain", () => {
  it("saves the key on this PC and never sends it back", async () => {
    const before = await request(app).get("/api/v1/brain");
    expect(before.body).toMatchObject({ configured: false, provider: "gemini", settingsAvailable: true, model: "gemini-3.8-flash" });

    const saved = await request(app).put("/api/v1/brain").send({ apiKey: KEY, model: "models/gemini-3.7-flash" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, source: "settings", keyHint: "AIza…wxyz", model: "gemini-3.7-flash", modelLabel: "Gemini 3.7 Flash" });
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    expect(JSON.stringify((await request(app).get("/api/v1/brain")).body)).not.toContain(KEY);
    expect(settings.activeBrain()).toMatchObject({ apiKey: KEY, model: "gemini-3.7-flash", thinking: "low", webSearch: false });

    const removed = await request(app).delete("/api/v1/brain/key");
    expect(removed.body.configured).toBe(false);
    expect(settings.activeBrain()).toBeNull();
  });

  it("rejects keys with spaces, and other sites", async () => {
    expect((await request(app).put("/api/v1/brain").send({ apiKey: "not a key with spaces in it" })).status).toBe(400);
    const evil = await request(app).put("/api/v1/brain").set("Origin", "https://evil.example").send({ apiKey: KEY });
    expect(evil.status).toBe(403);
    expect(settings.activeBrain()).toBeNull();
  });

  it("isn't there outside the desktop app (hosted servers use GEMINI_API_KEY)", async () => {
    const c = config as { brainSettingsAvailable: boolean };
    c.brainSettingsAvailable = false;
    try {
      expect((await request(app).put("/api/v1/brain").send({ apiKey: KEY })).status).toBe(404);
      expect((await request(app).get("/api/v1/brain")).body.keyHint).toBeNull();
    } finally {
      c.brainSettingsAvailable = true;
    }
  });

  it("Test: one tiny request, with the key in the header", async () => {
    fake.queue.push(text("ready"));
    const res = await request(app).post("/api/v1/brain/test").send({ apiKey: KEY });
    expect(res.body).toMatchObject({ ok: true, model: "gemini-3.8-flash", reply: "ready" });
    expect(fake.seen[0]!.url).toBe("/v1beta/models/gemini-3.8-flash:generateContent");
    expect(fake.seen[0]!.headers["x-goog-api-key"]).toBe(KEY);

    // Saving the key that just passed keeps the result ("Connected"), no second request.
    const saved = await request(app).put("/api/v1/brain").send({ apiKey: KEY });
    expect(saved.body.lastOkAt).toEqual(expect.any(String));
    expect(fake.seen).toHaveLength(1);

    fake.queue.push(googleError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }]));
    const bad = await request(app).post("/api/v1/brain/test").send({ apiKey: KEY });
    expect(bad.body).toMatchObject({ ok: false, kind: "invalid_key" });
    expect(bad.body.message).toMatch(/isn't valid/);
  });

  it("lists the models the key can chat with", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.queue.push(() => ({
      body: {
        models: [
          { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
          { name: "models/gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
        ],
      },
    }));
    const res = await request(app).get("/api/v1/brain/models");
    expect(fake.seen[0]!.url).toBe("/v1beta/models?pageSize=1000");
    expect(res.body.listed).toBe(true);
    expect(res.body.recommended.find((m: { id: string }) => m.id === "gemini-3.8-flash").available).toBe(true);
    expect(res.body.recommended.find((m: { id: string }) => m.id === "gemini-3.7-flash").available).toBe(false);
    expect(res.body.more).toEqual([{ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" }]);
  });
});

// ── Chat with Gemini ────────────────────────────────────────────────────────

describe("Chat answered by Gemini", () => {
  beforeEach(() => {
    settings.saveBrainSettings({ apiKey: KEY });
  });

  it("sends what the official SDK sends, and answers in plain text", async () => {
    fake.queue.push(text("**Hi!** I'm Soundwave.\n\n- I make shorts\n- I open apps"));
    const res = await chat("hello", { history: [{ sender: "assistant", text: "Welcome back!" }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, tag: "VOICE", brain: { provider: "gemini", model: "gemini-3.8-flash" } });
    expect(res.body.reply).toBe("Hi! I'm Soundwave.\n\n• I make shorts\n• I open apps");

    const [req] = generateCalls();
    expect(req!.method).toBe("POST");
    expect(req!.url).toBe("/v1beta/models/gemini-3.8-flash:generateContent");
    expect(req!.headers["x-goog-api-key"]).toBe(KEY);
    expect(req!.headers["content-type"]).toBe("application/json");
    const body = req!.body;
    expect(Object.keys(body).sort()).toEqual(["contents", "generationConfig", "systemInstruction", "tools"]);
    expect(body.systemInstruction.role).toBe("user");
    expect(body.systemInstruction.parts[0].text).toMatch(/^You are Soundwave/);
    expect(body.systemInstruction.parts[0].text).toMatch(/Right now it is /);
    // The greeting before the first question is dropped: Gemini wants the user first.
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: "LOW" } });
    expect(body.tools).toHaveLength(1);
    const names = body.tools[0].functionDeclarations.map((d: { name: string }) => d.name);
    expect(names).toEqual(expect.arrayContaining(["make_youtube_short", "get_short_progress", "list_my_videos", "show_video", "get_pc_status", "open_website"]));
    // open_app needs the Windows Start menu.
    expect(names.includes("open_app")).toBe(process.platform === "win32");
    // Gemini 3.8: no sampling parameters, no search unless turned on.
    expect(JSON.stringify(body)).not.toMatch(/temperature|topP|topK|googleSearch|toolConfig/);
  });

  it("runs a tool, then sends the model's turn back exactly (thought signature) with the result", async () => {
    fake.queue.push(call("make_youtube_short", { topic: "black holes", details: "for kids" }, "call-1", "U0lHLTE="));
    fake.queue.push(text("On it! Your short about black holes is rendering — it'll appear here when it's done."));
    const res = await chat("make a short about black holes for kids", { voice: "en-GB-RyanNeural", resolution: "1080p" });

    expect(mocks.startShortJob).toHaveBeenCalledTimes(1);
    expect(mocks.startShortJob.mock.calls[0]![0]).toMatchObject({ topic: "black holes", scriptBrief: "for kids", voice: "en-GB-RyanNeural", resolution: "1080p" });
    expect(res.body).toMatchObject({
      success: true,
      action: "soundwave_shorts",
      status: "PROCESSING",
      jobId: "job-test-1",
      topic: "black holes",
      pollUrl: "/api/v1/export/jobs/job-test-1",
      tag: "AUDIO",
    });
    expect(res.body.reply).toMatch(/rendering/);

    const second = generateCalls()[1]!.body.contents;
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { id: "call-1", name: "make_youtube_short", args: { topic: "black holes", details: "for kids" } }, thoughtSignature: "U0lHLTE=" }],
    });
    expect(second[2].role).toBe("user");
    expect(second[2].parts[0].functionResponse).toMatchObject({ id: "call-1", name: "make_youtube_short", response: { started: true, topic: "black holes" } });
  });

  it("follows the short that's already rendering instead of stacking another", async () => {
    mocks.getActiveShortJobs.mockReturnValue([{ jobId: "job-running", topic: "volcanoes", startedAt: Date.now() - 60_000 }]);
    fake.queue.push(call("make_youtube_short", { topic: "sharks" }, "c1", "c2ln"));
    fake.queue.push(text("I'm still finishing the volcano short — I'll do sharks after that."));
    const res = await chat("make a short about sharks");
    expect(mocks.startShortJob).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ status: "PROCESSING", jobId: "job-running", topic: "volcanoes" });
    expect(generateCalls()[1]!.body.contents[2].parts[0].functionResponse.response).toMatchObject({ started: false, busy: true, renderingNow: "volcanoes" });
  });

  it("gives Gemini the recent conversation, in turns", async () => {
    fake.queue.push(text("Sure."));
    await chat("and one more?", {
      history: [
        { sender: "assistant", text: "Hi! How can I help?" },
        { sender: "user", text: "tell me a fact" },
        { sender: "assistant", text: "Octopuses have three hearts." },
        { sender: "system", text: "(ignored)" },
        { sender: "user", text: "wow" },
        { sender: "user", text: "really?" },
      ],
    });
    expect(generateCalls()[0]!.body.contents).toEqual([
      { role: "user", parts: [{ text: "tell me a fact" }] },
      { role: "model", parts: [{ text: "Octopuses have three hearts." }] },
      { role: "user", parts: [{ text: "wow\n\nreally?" }] },
      { role: "model", parts: [{ text: "(no reply)" }] },
      { role: "user", parts: [{ text: "and one more?" }] },
    ]);
  });

  it("switches to Flash-Lite when the chosen model's free requests run out", async () => {
    fake.queue.push(quotaPerDay, text("Hello from Flash-Lite."));
    const res = await chat("hi");
    expect(res.body.reply).toBe("Hello from Flash-Lite.");
    expect(res.body.brain).toEqual({ provider: "gemini", model: "gemini-3.5-flash-lite", fallbackFrom: "gemini-3.8-flash" });
    expect(generateCalls().map((s) => s.url)).toEqual([
      "/v1beta/models/gemini-3.8-flash:generateContent",
      "/v1beta/models/gemini-3.5-flash-lite:generateContent",
    ]);
  });

  it("says what's wrong when Gemini can't answer — and still makes shorts without it", async () => {
    fake.queue.push(quotaPerDay, quotaPerDay);
    const res = await chat("what's the capital of France?");
    expect(res.body.success).toBe(false);
    expect(res.body.reply).toMatch(/Today's free Gemini requests for Gemini 3\.8 Flash and Gemini 3\.5 Flash-Lite are used up/);
    expect(settings.brainHealth().lastError?.kind).toBe("quota");

    fake.queue.push(quotaPerDay, quotaPerDay);
    const short = await chat("make a short about cats");
    expect(mocks.startShortJob).toHaveBeenCalledTimes(1);
    expect(short.body).toMatchObject({ action: "soundwave_shorts", status: "PROCESSING", jobId: "job-test-1", topic: "cats" });
  });

  it("never repeats an action when Gemini fails after it", async () => {
    fake.queue.push(call("make_youtube_short", { topic: "the moon" }, "c1", "c2ln"), quotaPerDay);
    const res = await chat("make a short about the moon");
    expect(mocks.startShortJob).toHaveBeenCalledTimes(1);
    expect(generateCalls()).toHaveLength(2); // no restart on the other model
    expect(res.body).toMatchObject({ success: true, status: "PROCESSING", jobId: "job-test-1" });
    expect(res.body.reply).toBe("On it — I'm making a short about “the moon”. It'll show up here when it's rendered.");
  });

  it("retries a busy Gemini only within the phone's 45-second wait", async () => {
    const { brainChat, TURN_BUDGET_MS } = await import("../src/lib/brain/chat.js");
    const brain = { provider: "gemini" as const, apiKey: KEY, source: "settings" as const, model: "gemini-3.8-flash", thinking: "low" as const, webSearch: false };
    let clock = Date.now();
    const realNow = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      // Busy after 20 s: the one retry only gets what's left of the turn.
      const timeouts: number[] = [];
      const busyOnce = vi.fn(async (args: { timeoutMs?: number }) => {
        timeouts.push(args.timeoutMs!);
        if (timeouts.length > 1) return { candidates: [{ content: { role: "model", parts: [{ text: "Back again." }] }, finishReason: "STOP" }] };
        clock += 20_000;
        throw new gemini.GeminiError("overloaded", "The model is overloaded. Please try again later.");
      });
      const reply = await brainChat({ message: "hi", via: "phone" }, brain, { generate: busyOnce as never, now: () => new Date(clock), tools: [] });
      expect(reply.reply).toBe("Back again.");
      expect(timeouts).toEqual([30_000, TURN_BUDGET_MS - 20_000 - 700]);

      // Connection dropped after 38 s: a retry couldn't finish in time, so none — the agent explains instead.
      const dropped = vi.fn(async () => {
        clock += 38_000;
        throw new gemini.GeminiError("network", "ECONNRESET");
      });
      await expect(brainChat({ message: "hi", via: "phone" }, brain, { generate: dropped as never, now: () => new Date(clock), tools: [] })).rejects.toMatchObject({ kind: "network" });
      expect(dropped).toHaveBeenCalledTimes(1);
    } finally {
      realNow.mockRestore();
    }
  });

  it("explains a bad key", async () => {
    fake.queue.push(googleError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [{ reason: "API_KEY_INVALID" }]));
    const res = await chat("hey");
    expect(res.body.reply).toMatch(/Gemini API key isn't valid.*Settings → Brain/);
  });

  it("answers without Google Search when the key can't use it (free tier), and remembers", async () => {
    settings.saveBrainSettings({ webSearch: true });
    fake.queue.push(googleError(400, "INVALID_ARGUMENT", "Grounding with Google Search is not available on the free tier."), text("I can't check the weather live from here."));
    const res = await chat("weather in Kruševac?");
    expect(res.body.reply).toMatch(/can't check/);
    const [first, second] = generateCalls();
    expect(first!.body.tools[0]).toEqual({ googleSearch: {} });
    expect(first!.body.toolConfig).toEqual({ includeServerSideToolInvocations: true });
    expect(JSON.stringify(second!.body)).not.toMatch(/googleSearch|toolConfig/);
    expect(settings.brainHealth().searchUnavailable).toBe(true);
    expect((await request(app).get("/api/v1/brain")).body.searchUnavailable).toBe(true);
  });

  it("names its sources when it searched", async () => {
    settings.saveBrainSettings({ webSearch: true });
    fake.queue.push(() => ({
      body: {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "It's 18 degrees and sunny." }] },
            finishReason: "STOP",
            groundingMetadata: { webSearchQueries: ["weather Kruševac"], groundingChunks: [{ web: { title: "weather.com", uri: "https://x" } }, { web: { title: "accuweather.com" } }] },
          },
        ],
      },
    }));
    const res = await chat("weather in Kruševac?");
    expect(res.body.reply).toBe("It's 18 degrees and sunny.\n\nSources: weather.com, accuweather.com");
  });

  it("opens a web page in this PC's browser", async () => {
    const openExternal = vi.fn(async () => undefined);
    (globalThis as { __soundwaveDesktopHost?: unknown }).__soundwaveDesktopHost = { openExternal, openPath: vi.fn(async () => "") };
    fake.queue.push(call("open_website", { url: "youtube.com/results?search_query=lofi music" }, "w1", "c2ln"), text("Opened YouTube for you."));
    const res = await chat("search youtube for lofi music");
    expect(openExternal).toHaveBeenCalledWith("https://youtube.com/results?search_query=lofi%20music");
    expect(res.body).toMatchObject({ reply: "Opened YouTube for you.", actionOutput: "Opened https://youtube.com/results?search_query=lofi%20music", tag: "SYS" });
  });

  it("refuses non-web addresses", async () => {
    const openExternal = vi.fn(async () => undefined);
    (globalThis as { __soundwaveDesktopHost?: unknown }).__soundwaveDesktopHost = { openExternal, openPath: vi.fn(async () => "") };
    fake.queue.push(call("open_website", { url: "file:///C:/Windows/System32/cmd.exe" }, "w1", "c2ln"), text("I can only open web pages."));
    await chat("open my C drive");
    expect(openExternal).not.toHaveBeenCalled();
    expect(generateCalls()[1]!.body.contents[2].parts[0].functionResponse.response.ok).toBe(false);
  });

  it("shows the newest finished short with a player", async () => {
    const store = await getStore();
    const job = await store.createJob({
      projectId: null,
      userId: "local-user",
      status: "COMPLETED",
      progress: 100,
      settings: { topic: "honey never spoils" } as never,
      outputUrl: "/uploads/short-honey.mp4",
      errorMessage: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    fake.queue.push(call("show_video", {}, "v1", "c2ln"), text("Here's your honey short!"));
    const res = await chat("where's my video?");
    expect(res.body).toMatchObject({ action: "soundwave_shorts", videoUrl: "/uploads/short-honey.mp4", downloadUrl: "/uploads/short-honey.mp4", topic: "honey never spoils" });
    expect(generateCalls()[1]!.body.contents[2].parts[0].functionResponse.response).toMatchObject({ shown: true, topic: "honey never spoils" });
    await store.updateJob(job.id, { status: "FAILED" });
  });

  it("keeps the PC tools (and the memory) out of hosted servers", async () => {
    const c = config as { desktopApp: boolean; memoryAvailable: boolean };
    c.desktopApp = false;
    c.memoryAvailable = false;
    try {
      fake.queue.push(text("Hi."));
      await chat("hi");
      const names = generateCalls()[0]!.body.tools[0].functionDeclarations.map((d: { name: string }) => d.name);
      // Posting is not PC control: a hosted server can hold a schedule and post
      // from it too (the clip and the channel live wherever this process does),
      // so the four post tools stay available while the PC ones don't.
      expect(names).toEqual([
        "make_youtube_short",
        "get_short_progress",
        "schedule_short",
        "list_scheduled_posts",
        "cancel_scheduled_post",
        "my_short_performance",
        "list_my_videos",
        "show_video",
        "soundwave_guide",
      ]);
      const instruction = generateCalls()[0]!.body.systemInstruction.parts[0].text;
      expect(instruction).not.toMatch(/open_website|with remember and forget|Your memory:/);
    } finally {
      c.desktopApp = true;
      c.memoryAvailable = true;
    }
  });
});

// ── Without a key ───────────────────────────────────────────────────────────

describe("Chat without a Gemini key", () => {
  it("says how to add one", async () => {
    const res = await chat("what's the weather like?");
    expect(res.body).toMatchObject({ success: true, needsBrain: true, tag: "SYS" });
    expect(res.body.reply).toMatch(/Gemini API key.*Settings → Brain/);
    expect(fake.seen).toHaveLength(0);
  });

  it("still makes shorts", async () => {
    const res = await chat("generate a yt short about psychology");
    expect(res.body).toMatchObject({ action: "soundwave_shorts", status: "PROCESSING", topic: "psychology" });
    expect(mocks.startShortJob).toHaveBeenCalledTimes(1);
  });
});

// ── Short scripts ───────────────────────────────────────────────────────────

describe("Short scripts written by Gemini", () => {
  const WRITTEN =
    '**Hook:** Did you know a teaspoon of a neutron star would weigh about a billion tons? 🤯\n\n[dramatic music]\nThese city-sized remnants of exploded stars spin up to hundreds of times a second. Their gravity is so strong that light bends around them, letting you see part of the back side. A sugar-cube sized piece would outweigh every car on Earth combined. And when two of them collide, they forge gold and platinum, then shake spacetime itself so hard that detectors on Earth can feel it. So the gold in your ring may have been born in a collision like that. #space #science';

  it("asks for a narration and cleans what comes back", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.queue.push(text(WRITTEN));
    const out = await writeShortScript("neutron stars", "keep it fun");
    expect(out?.model).toBe("gemini-3.8-flash");
    expect(out?.script).toMatch(/^Did you know a teaspoon of a neutron star/);
    expect(out?.script).not.toMatch(/\*|Hook:|🤯|\[|#space/);
    const body = generateCalls()[0]!.body;
    // The brief is the researched one (core/viral.ts): niche recipe, hook shapes, the bar.
    expect(body.systemInstruction.parts[0].text).toBe(
      viral.buildScriptInstruction({ seconds: viral.DEFAULT_SECONDS, niche: viral.detectNiche("neutron stars"), brief: "keep it fun" }),
    );
    expect(body.systemInstruction.parts[0].text).toContain("HOOK");
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Topic: neutron stars\nWhat the viewer asked for: keep it fun" }] }]);
    expect(body.tools).toBeUndefined();
  });

  it("is used by the short builder, and kept on the job", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.queue.push(text(WRITTEN));
    // The voice step fails in tests (no voice service) — the script is already saved by then.
    await expect(buildShortVideo({ topic: "neutron stars", userId: "local-user" })).rejects.toThrow();
    const store = await getStore();
    const job = (await store.listJobs("local-user")).find((j) => (j.settings as { topic?: string }).topic === "neutron stars");
    expect(job?.settings).toMatchObject({ scriptSource: "gemini" });
    expect((job?.settings as { script: string }).script).toMatch(/^Did you know a teaspoon/);
  });

  it("falls back to the built-in script without a key", async () => {
    expect(await writeShortScript("neutron stars")).toBeNull();
    expect(fake.seen).toHaveLength(0);
  });
});

// ── Pieces ──────────────────────────────────────────────────────────────────

describe("brain helpers", () => {
  it("reads Google's errors", () => {
    const daily = gemini.errorFromResponse(429, {
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }, { retryDelay: "17.2s" }] },
    });
    expect(daily).toMatchObject({ kind: "quota", daily: true, retryAfterSec: 18 });
    const minute = gemini.errorFromResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "Please retry in 6.5s.", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }] } });
    expect(minute).toMatchObject({ kind: "quota", daily: false, retryAfterSec: 7 });
    expect(gemini.describeGeminiError(minute, "gemini-3.8-flash")).toBe("Google's per-minute limit is reached for Gemini 3.8 Flash — try again in about 7 seconds.");
    expect(gemini.errorFromResponse(400, { error: { status: "FAILED_PRECONDITION", message: "User location is not supported for the API use." } }).kind).toBe("region");
    expect(gemini.errorFromResponse(403, { error: { status: "PERMISSION_DENIED", message: "Method doesn't allow unregistered callers" } }).kind).toBe("permission");
    expect(gemini.errorFromResponse(404, { error: { status: "NOT_FOUND", message: "models/gemini-9 is not found" } }).kind).toBe("model");
    expect(gemini.errorFromResponse(503, { error: { status: "UNAVAILABLE", message: "The model is overloaded." } }).kind).toBe("overloaded");
    expect(gemini.errorFromResponse(502, null).kind).toBe("overloaded");
  });

  it("names models", () => {
    expect(gemini.modelLabel("gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(gemini.modelLabel("models/gemini-3.5-flash-lite")).toBe("Gemini 3.5 Flash-Lite");
    expect(gemini.modelLabel("gemini-3.1-pro-preview")).toBe("Gemini 3.1 Pro (preview)");
    expect(gemini.modelLabel("gemini-flash-latest")).toBe("Gemini Flash (latest)");
    expect(gemini.isGemini3("gemini-3.8-flash")).toBe(true);
    expect(gemini.isGemini3("gemini-flash-lite-latest")).toBe(true);
    expect(gemini.isGemini3("gemini-2.5-flash")).toBe(false);
  });

  it("leaves thinking levels and tool mixing to Gemini 3 models", () => {
    const contents = contentsFor([], "hi");
    expect(contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    const older = buildRequest(contents, { model: "gemini-2.5-flash", thinking: "low", declarations: [], search: false, instruction: "x" });
    expect(older.generationConfig).toEqual({ maxOutputTokens: 8192 });
    expect(older.tools).toBeUndefined();
    const deep = buildRequest(contents, { model: "gemini-3.8-flash", thinking: "high", declarations: [], search: true, instruction: "x" });
    expect(deep.generationConfig).toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: "HIGH" } });
    expect(deep.tools).toEqual([{ googleSearch: {} }]);
    expect(deep.toolConfig).toBeUndefined(); // only needed next to our own functions
  });

  it("tells Gemini when a message came from the phone", () => {
    const desktop = prompt.agentInstruction({ tools: ["make_youtube_short", "open_website", "open_app"], webSearch: false, surface: "phone" });
    expect(desktop).toMatch(/sent from the Soundwave phone app/);
    expect(desktop).toMatch(/appear on the PC, not on the phone — say "on your PC"/);
    const noPcTools = prompt.agentInstruction({ tools: ["make_youtube_short"], webSearch: false, surface: "phone" });
    expect(noPcTools).toMatch(/sent from the Soundwave phone app/);
    expect(noPcTools).not.toMatch(/on your PC/);
    expect(prompt.agentInstruction({ tools: ["make_youtube_short", "open_website"], webSearch: false })).not.toMatch(/phone app, so the user/);
  });

  it("makes replies plain text", () => {
    expect(prompt.plainReply("## Title\n**Bold** and *soft* and `code`.\n* one\n* two\n> quote\n[Google](https://google.com)")).toBe(
      "Title\nBold and soft and code.\n• one\n• two\nquote\nGoogle (https://google.com)",
    );
    expect(prompt.plainReply("2*3*4 = 24")).toBe("2*3*4 = 24");
  });

  it("only opens web pages", () => {
    expect(pc.normalizeUrl("youtube.com")).toBe("https://youtube.com/");
    expect(pc.normalizeUrl("https://www.google.com/search?q=lofi beats")).toBe("https://www.google.com/search?q=lofi%20beats");
    expect(pc.normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    for (const bad of ["file:///C:/Windows", "javascript:alert(1)", "ms-settings:display", "notaurl", "", "https://a b.com"]) {
      expect(pc.normalizeUrl(bad)).toBeNull();
    }
  });

  it("finds apps the way people name them", () => {
    const apps = pc.parseStartApps(
      JSON.stringify([
        { Name: "Google Chrome", AppID: "Chrome" },
        { Name: "Spotify", AppID: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" },
        { Name: "Uninstall Spotify", AppID: "{x}\\uninstall.exe" },
        { Name: "Calculator", AppID: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
        { Name: "Notepad", AppID: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
        { Name: "Notepad++", AppID: "{6D809377-6AF0-444B-8957-A3773F02200E}\\Notepad++\\notepad++.exe" },
        { Name: "File Explorer", AppID: "Microsoft.Windows.Explorer" },
        { Name: "Visual Studio Code", AppID: "Microsoft.VisualStudioCode" },
        { Name: "Bad", AppID: 'x" & calc' },
      ]),
    );
    expect(apps.map((a) => a.name)).not.toContain("Bad");
    const pick = (q: string) => pc.findApp(apps, q).best?.name ?? null;
    expect(pick("spotify")).toBe("Spotify");
    expect(pick("Spotify app")).toBe("Spotify");
    expect(pick("chrome")).toBe("Google Chrome");
    expect(pick("calc")).toBe("Calculator");
    expect(pick("notepad")).toBe("Notepad");
    expect(pick("notepad++")).toBe("Notepad++");
    expect(pick("explorer")).toBe("File Explorer");
    expect(pick("vs code")).toBe("Visual Studio Code");
    expect(pick("photoshop")).toBeNull();
    expect(pc.parseStartApps('{"Name":"Only","AppID":"One"}')).toEqual([{ name: "Only", appId: "One" }]);
  });

  it("shows this PC's live stats to the app's own window (the System Stats card)", async () => {
    const res = await request(app).get("/api/v1/brain/pc");
    expect(res.status).toBe(200);
    expect(res.body.cpu.cores).toBeGreaterThan(0);
    expect(res.body.uptimeSeconds).toBeGreaterThan(0);
    expect((await request(app).get("/api/v1/brain/pc").set("Origin", "https://evil.example")).status).toBe(403);
    const c = config as { desktopApp: boolean };
    c.desktopApp = false;
    try {
      expect((await request(app).get("/api/v1/brain/pc")).status).toBe(404);
    } finally {
      c.desktopApp = true;
    }
  });

  it("reports real PC facts", async () => {
    const s = await pc.pcStatus(50);
    expect(s.cpu.cores).toBeGreaterThan(0);
    expect(s.memory.totalGB).toBeGreaterThan(0);
    expect(s.memory.usedPercent).toBeGreaterThanOrEqual(0);
    expect(s.computerName.length).toBeGreaterThan(0);
  });
});
