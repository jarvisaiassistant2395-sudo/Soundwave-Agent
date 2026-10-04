// The phone companion with the agent's brain on: the phone app's own client
// code (mobile/src/lib) → the PC's listener (lib/companion) → the agent →
// Gemini (a fake one on loopback). The path a message typed or spoken on the
// phone takes on a real PC once a key is saved in Settings → Brain.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => {
  // As in the desktop app: the phone companion, Settings → Brain and the PC tools.
  process.env.COMPANION = "1";
  process.env.DESKTOP_APP = "1";
  return {
    startShortJob: vi.fn(async (_p: Record<string, unknown>) => ({ jobId: "job-from-phone" })),
    getActiveShortJobs: vi.fn((): Array<{ jobId: string; topic: string; startedAt: number }> => []),
  };
});

vi.mock("../src/routes/agentShort.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/agentShort.js")>();
  return { ...actual, startShortJob: mocks.startShortJob, getActiveShortJobs: mocks.getActiveShortJobs };
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests, getStore } = await import("../src/lib/store.js");
const settings = await import("../src/lib/brain/settings.js");
const service = await import("../src/lib/companion/service.js");
const listener = await import("../src/lib/companion/listener.js");
const conversation = await import("../src/lib/conversation.js");
const phone = await import("../../mobile/src/lib/protocol.js");
const { CompanionClient, pairWithPc } = await import("../../mobile/src/lib/client.js");
const offline = await import("../../mobile/src/lib/offline.js");
const memory = await import("../src/lib/memory.js");
const morning = await import("../src/lib/morning.js");
const briefing = await import("../src/lib/briefing.js");
const coreMorning = await import("../src/lib/brain/core/morning.js");

// ── A fake Gemini API ───────────────────────────────────────────────────────

interface Seen {
  url: string;
  key: string | undefined;
  body: any;
}
type Reply = { status?: number; body: unknown };

const fake = { seen: [] as Seen[], queue: [] as Array<(req: Seen) => Reply>, url: "" };

const gemini = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const seen: Seen = { url: req.url ?? "", key: req.headers["x-goog-api-key"] as string | undefined, body: raw ? JSON.parse(raw) : null };
    fake.seen.push(seen);
    const next = fake.queue.shift();
    const out = next ? next(seen) : { status: 500, body: { error: { code: 500, message: "test: nothing queued", status: "INTERNAL" } } };
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
});

const text = (t: string) => (): Reply => ({
  body: { candidates: [{ content: { role: "model", parts: [{ text: t, thoughtSignature: "dGV4dA==" }] }, finishReason: "STOP" }] },
});
const call = (name: string, args: Record<string, unknown>, id: string) => (): Reply => ({
  body: { candidates: [{ content: { role: "model", parts: [{ functionCall: { id, name, args }, thoughtSignature: "Y2FsbA==" }] }, finishReason: "STOP" }] },
});
const generateCalls = () => fake.seen.filter((s) => s.url.includes(":generateContent"));
const lastTurn = (s: Seen): string => (s.body.contents.at(-1).parts as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
const instructionOf = (s: Seen): string => s.body.systemInstruction.parts[0].text;
const toolNames = (s: Seen): string[] =>
  (s.body.tools as Array<{ functionDeclarations?: Array<{ name: string }> }>).flatMap((t) => (t.functionDeclarations ?? []).map((d) => d.name));

// ── The PC and a paired phone ───────────────────────────────────────────────

const KEY = "AIzaSyPhoneTest-0123456789-abcdwxyz";
const DATA = config.dataDir;
let app: ReturnType<typeof createApp>;

/** What Settings → Brain → Save does in the PC app. */
async function saveKeyOnPc() {
  const res = await request(app).put("/api/v1/brain").set("Host", "127.0.0.1").send({ apiKey: KEY });
  expect(res.status).toBe(200);
  expect(res.body.configured).toBe(true);
}

async function pairedClient() {
  service.setEnabledFlag(true);
  await listener.startListener({ host: "127.0.0.1", port: 0 });
  const port = listener.listenerState().port!;
  const session = service.activePairing() ?? service.startPairing();
  const link = phone.parsePairingLink(service.pairingLink(session, port, [{ address: "127.0.0.1", name: "lo", kind: "lan" }]))!;
  const record = await pairWithPc(link, { name: "Test Phone", platform: "android", model: "Pixel Test", appVersion: "1.0.0" });
  const client = new CompanionClient(record);
  expect(await client.connect()).toBe(true);
  return client;
}

beforeAll(async () => {
  await new Promise<void>((r) => gemini.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(gemini.address() as AddressInfo).port}`;
  (config as { geminiApiBase: string }).geminiApiBase = fake.url;
  fs.rmSync(DATA, { recursive: true, force: true });
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
});

beforeEach(() => {
  for (const f of ["companion.json", "agent-conversation.json", "morning.json", "briefing.json"]) fs.rmSync(path.join(DATA, f), { force: true });
  service.resetCompanionStateForTests();
  conversation.resetConversationForTests();
  settings.resetBrainSettingsForTests();
  memory.resetMemoryForTests();
  fake.seen.length = 0;
  fake.queue.length = 0;
  mocks.startShortJob.mockClear();
  mocks.getActiveShortJobs.mockReset();
  mocks.getActiveShortJobs.mockReturnValue([]);
});

afterEach(async () => {
  await listener.stopListener();
});

afterAll(async () => {
  await listener.stopListener();
  gemini.close();
});

// ── The tests ───────────────────────────────────────────────────────────────

describe("the phone app, with Gemini as the agent's brain", () => {
  it("is answered by Gemini as soon as the PC has a key — no phone update, no restart", async () => {
    const client = await pairedClient();

    // No key on the PC yet: the agent says where to add one.
    const before = await client.send("are you there?");
    expect(before.text).toMatch(/Gemini API key/);
    expect(generateCalls()).toHaveLength(0);

    await saveKeyOnPc();
    fake.queue.push(text("I'm here! Want me to make a short?"));
    const reply = await client.send("hello from my phone", { viaVoice: true });
    expect(reply).toMatchObject({ sender: "assistant", text: "I'm here! Want me to make a short?" });

    const [asked] = generateCalls();
    expect(asked!.key).toBe(KEY);
    expect(asked!.url).toBe("/v1beta/models/gemini-3.8-flash:generateContent");
    expect(lastTurn(asked!)).toBe("hello from my phone");
    // The conversation so far goes along (the earlier no-key exchange included).
    expect(asked!.body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(asked!.body.contents[0].parts[0].text).toBe("are you there?");
    // Gemini knows this came from the phone — and that its tools act on the PC.
    expect(instructionOf(asked!)).toMatch(/sent from the Soundwave phone app/);
    expect(instructionOf(asked!)).toMatch(/appear on the PC, not on the phone/);
    expect(toolNames(asked!)).toEqual(expect.arrayContaining(["make_youtube_short", "get_short_progress", "list_my_videos", "show_video", "get_pc_status", "open_website"]));

    // One conversation: the PC has it, the phone's copy matches.
    const shared = conversation.getConversation().messages;
    expect(shared.at(-1)!.id).toBe(reply.id);
    expect(shared.at(-2)).toMatchObject({ sender: "user", text: "hello from my phone", via: "phone", viaVoice: true });
    expect(client.conversation!.messages.map((m) => m.id)).toEqual(shared.map((m) => m.id));
  });

  it("checks the PC when asked from the phone (a tool round trip)", async () => {
    await saveKeyOnPc();
    const client = await pairedClient();
    fake.queue.push(call("get_pc_status", {}, "pc-1"), (req) => {
      const r = req.body.contents.at(-1).parts[0].functionResponse.response;
      return text(`Your PC (${r.os}) is doing fine: ${r.memory.usedPercent}% of memory in use.`)();
    });

    const reply = await client.send("how's my PC doing?");
    expect(reply.text).toMatch(/^Your PC \(.+\) is doing fine: \d+% of memory in use\.$/);

    const second = generateCalls()[1]!;
    // The model's turn went back exactly as received (thought signature), then the result under the call's id.
    expect(second.body.contents.at(-2)).toEqual({ role: "model", parts: [{ functionCall: { id: "pc-1", name: "get_pc_status", args: {} }, thoughtSignature: "Y2FsbA==" }] });
    expect(second.body.contents.at(-1).parts[0].functionResponse).toMatchObject({ id: "pc-1", name: "get_pc_status" });
  });

  it("makes a short from the phone in the phone's chosen voice, and the phone follows its progress", async () => {
    await saveKeyOnPc();
    const client = await pairedClient();
    const store = await getStore();
    mocks.startShortJob.mockImplementationOnce(async (p: Record<string, unknown>) => {
      const job = await store.createJob({
        projectId: null,
        userId: "local-user",
        status: "PROCESSING",
        progress: 35,
        settings: { topic: p.topic, step: "Recording the voiceover" } as never,
        outputUrl: null,
        errorMessage: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      });
      return { jobId: job.id };
    });
    fake.queue.push(
      call("make_youtube_short", { topic: "octopuses", details: "they have three hearts" }, "s-1"),
      text("On it! Your octopus short is rendering — it'll show up here in a few minutes."),
    );

    const reply = await client.send("make a short about octopuses and mention their three hearts", { viaVoice: true, voice: "en-GB-RyanNeural" });
    expect(reply).toMatchObject({ text: "On it! Your octopus short is rendering — it'll show up here in a few minutes.", jobState: "started", topic: "octopuses" });
    expect(mocks.startShortJob).toHaveBeenCalledTimes(1);
    expect(mocks.startShortJob.mock.calls[0]![0]).toMatchObject({ topic: "octopuses", scriptBrief: "they have three hearts", voice: "en-GB-RyanNeural", userId: "local-user" });

    // The phone's live view: the rendering short and how far along it is.
    await client.sync();
    expect(client.jobs).toEqual([expect.objectContaining({ id: reply.jobId, status: "PROCESSING", progress: 35, topic: "octopuses", step: "Recording the voiceover" })]);
    await store.updateJob(reply.jobId!, { status: "FAILED", errorMessage: "test over" });
  });

  it("shows a finished short that the phone can play", async () => {
    await saveKeyOnPc();
    const client = await pairedClient();
    const store = await getStore();
    const job = await store.createJob({
      projectId: null,
      userId: "local-user",
      status: "COMPLETED",
      progress: 100,
      settings: { topic: "honey never spoils" } as never,
      outputUrl: null,
      errorMessage: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await store.updateJob(job.id, { outputUrl: `/api/v1/export/jobs/${job.id}/download` });
    const bytes = Buffer.from("not really an mp4 ".repeat(5000));
    fs.mkdirSync(path.join(config.uploadsDir, "jobs"), { recursive: true });
    const file = path.join(config.uploadsDir, "jobs", `${job.id}.mp4`);
    fs.writeFileSync(file, bytes);
    try {
      fake.queue.push(call("show_video", {}, "v-1"), text("Here's your honey short."));
      const reply = await client.send("show me my latest short");
      // The player's title on the phone is the short's topic.
      expect(reply).toMatchObject({ text: "Here's your honey short.", topic: "honey never spoils", videoUrl: `/api/v1/export/jobs/${job.id}/download` });

      // The phone's Watch button reads the short from the link (watchableJob in
      // mobile/src/components/Message.tsx) and plays the file it fetches from the PC.
      const watch = /\/export\/jobs\/([\w-]+)\/download/.exec(reply.videoUrl ?? "")?.[1];
      expect(watch).toBe(job.id);
      const blob = await client.video(watch!);
      expect(Buffer.from(await blob.arrayBuffer()).equals(bytes)).toBe(true);
    } finally {
      fs.rmSync(file, { force: true });
      await store.updateJob(job.id, { status: "FAILED" });
    }
  });

  it("tells the phone what's wrong when Google refuses the key", async () => {
    await saveKeyOnPc();
    const client = await pairedClient();
    fake.queue.push(() => ({
      status: 400,
      body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } },
    }));
    const reply = await client.send("hi");
    expect(reply.text).toMatch(/Gemini API key isn't valid.*Settings → Brain/);
  });

  it("only marks the phone's messages as from the phone", async () => {
    await saveKeyOnPc();
    fake.queue.push(text("Hi from the PC chat."));
    const res = await request(app).post("/api/v1/agent/chat").send({ message: "typed in the Command Center" });
    expect(res.body.reply).toBe("Hi from the PC chat.");
    expect(instructionOf(generateCalls()[0]!)).not.toMatch(/phone app, so the user/);
  });
});

describe("when the PC is off, the phone chats on its own", () => {
  it("gets the brain kit and the memory while it's connected — and loses the key when sharing is turned off", async () => {
    await saveKeyOnPc();
    memory.addNote("The user's channel is about space facts");
    const client = await pairedClient();
    expect(client.pc!.brain).toMatchObject({ phoneChat: true, modelLabel: "Gemini 3.8 Flash" });

    const kit = await client.fetchKit();
    expect(kit).toMatchObject({ enabled: true, apiKey: KEY, model: "gemini-3.8-flash", fallbackModel: "gemini-3.5-flash-lite", thinking: "low", apiBase: fake.url });

    const snapshots: Array<{ notes: Array<{ text: string }> }> = [];
    client.on("memory", (m) => snapshots.push(m));
    await client.sync();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.notes.map((n) => n.text)).toEqual(["The user's channel is about space facts"]);
    await client.sync();
    expect(snapshots).toHaveLength(1); // unchanged memory isn't sent again

    const off = await request(app).post("/api/v1/companion/share-brain").set("Host", "127.0.0.1").send({ enabled: false });
    expect(off.body.shareBrain).toBe(false);
    const revs: string[] = [];
    client.on("kitRev", (r) => revs.push(r));
    await client.sync();
    expect(revs).toEqual(["sharing_off"]);
    expect(await client.fetchKit()).toEqual({ enabled: false, reason: "sharing_off", rev: "sharing_off" });
  });

  it("answers on the phone with the PC off, and it all goes back to the PC's conversation and memory", async () => {
    await saveKeyOnPc();
    memory.addNote("The user's channel is about space facts");
    const client = await pairedClient();
    const kit = await client.fetchKit();
    if (!kit.enabled) throw new Error("no kit");
    let snapshot: Parameters<typeof offline.effectiveMemory>[0] = null;
    client.on("memory", (m) => (snapshot = m));
    await client.sync();
    const port = listener.listenerState().port!;

    // The PC goes away.
    await listener.stopListener();
    await expect(client.send("are you there?")).rejects.toMatchObject({ code: "OFFLINE" });

    // The phone answers by itself (Gemini directly, with the PC's memory).
    fake.queue.push(call("remember", { note: "The user wants a short about volcanoes tomorrow." }, "r1"), text("Noted! Volcanoes tomorrow — I'll remember."));
    const ops: Parameters<typeof offline.effectiveMemory>[1] = [];
    const now = Date.now();
    const reply = await offline.offlineReply({
      kit,
      memory: offline.effectiveMemory(snapshot, []),
      history: conversation.getConversation().messages.map((m) => ({ sender: m.sender, text: m.text })),
      message: "remind me tomorrow: volcanoes short",
      record: (op) => ops.push(op),
    });
    expect(reply.text).toBe("Noted! Volcanoes tomorrow — I'll remember.");
    const asked = generateCalls()[0]!;
    expect(asked.key).toBe(KEY);
    expect(instructionOf(asked)).toMatch(/your PC is off or out of reach|PC is off or out of reach/);
    expect(instructionOf(asked)).toMatch(/The user's channel is about space facts/);

    const outbox = {
      messages: [
        { id: `${now}-ph0001`, sender: "user" as const, text: "remind me tomorrow: volcanoes short", time: "", at: now, via: "phone" as const },
        { id: `${now + 1}-ph0002`, sender: "assistant" as const, text: reply.text, time: "", at: now + 1, tag: "VOICE" as const, answeredBy: "phone" as const },
      ],
      memoryOps: ops,
    };

    // The PC is back: the phone hands over what was said, before syncing.
    service.setEnabledFlag(true);
    await listener.startListener({ host: "127.0.0.1", port });
    client.setOutbox(() => outbox);
    const flushed: unknown[] = [];
    client.on("flushed", (b) => flushed.push(b));
    expect(await client.connect()).toBe(true);
    const { merged } = await client.merge(outbox);
    expect(merged).toBe(2);
    expect(flushed).toHaveLength(1);

    const shared = conversation.getConversation().messages;
    expect(shared.find((m) => m.id === `${now}-ph0001`)).toMatchObject({ via: "phone", text: "remind me tomorrow: volcanoes short" });
    expect(shared.find((m) => m.id === `${now + 1}-ph0002`)).toMatchObject({ answeredBy: "phone", text: "Noted! Volcanoes tomorrow — I'll remember." });
    expect(memory.memoryNotes().map((n) => [n.text, n.from])).toContainEqual(["The user wants a short about volcanoes tomorrow.", "phone"]);

    // The PC's agent knows it next time.
    fake.queue.push(text("Yes — volcanoes today, as you asked from your phone."));
    await request(app).post("/api/v1/agent/chat").send({ message: "what was I going to make today?", history: shared.map((m) => ({ sender: m.sender, text: m.text })) });
    const pcAsked = generateCalls().at(-1)!;
    expect(JSON.stringify(pcAsked.body.contents)).toMatch(/remind me tomorrow: volcanoes short/);
    expect(instructionOf(pcAsked)).toMatch(/The user wants a short about volcanoes tomorrow\./);
  });

  it("runs Morning Setup on the PC when the phone asks while it's on", async () => {
    await saveKeyOnPc();
    morning.saveMorningSettings({ items: [] }); // nothing to open in tests
    const client = await pairedClient();
    fake.queue.push(text("Good morning! Here's your day…"));
    const reply = await client.morning();
    expect(reply).toMatchObject({ sender: "assistant", text: "Good morning! Here's your day…", tag: "SYS" });
    const shared = conversation.getConversation().messages;
    expect(shared.at(-2)).toMatchObject({ sender: "user", text: "🌅 Morning Setup", via: "phone" });
    expect(generateCalls()[0]!.body.contents[0].parts[0].text).toMatch(/^Now: \w+day/);
    expect(memory.lastMorningAt()).toBeGreaterThan(Date.now() - 5000);
  });
});

describe("the morning briefing on the phone", () => {
  const minutesAgo = (n: number) => {
    const d = new Date(Date.now() - n * 60_000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const searchAnswer = () => ({
    body: {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Ollama 1.0 shipped with a new model library." }] },
          finishReason: "STOP",
          groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com", title: "example.com" } }] },
        },
      ],
    },
  });

  it("opened after the briefing time with the PC on: the PC writes it (researching the topics) and the phone marks it heard", async () => {
    briefing.resetBriefingForTests();
    await saveKeyOnPc();
    morning.saveMorningSettings({ items: [] });
    memory.setBriefingPlan({ topics: ["the latest news about open-source, free AI tools"], time: minutesAgo(3), auto: true });
    const client = await pairedClient();

    let status = await client.briefingToday();
    expect(status).toMatchObject({ due: true, inWindow: true, message: null, heard: null });

    fake.queue.push(searchAnswer, text("Good morning! On open-source AI tools: Ollama 1.0 is out."));
    status = await client.briefingToday({ prepare: true });
    const day = coreMorning.localDay(new Date());
    expect(status.message).toMatchObject({ briefingDate: day, text: "Good morning! On open-source AI tools: Ollama 1.0 is out." });
    const [search, writer] = generateCalls();
    expect(search!.url).toMatch(/gemini-2\.5-flash:generateContent$/);
    expect(search!.body.tools).toEqual([{ googleSearch: {} }]);
    expect(writer!.body.contents[0].parts[0].text).toMatch(/1\. “the latest news about open-source, free AI tools” — researched with Google Search:\nOllama 1\.0 shipped/);
    expect(client.conversation!.messages.some((m) => m.briefingDate === day)).toBe(true);

    await client.briefingHeard(day);
    expect(briefing.briefingStatus().heard).toMatchObject({ on: "phone" });
  });

  it("asked to prepare before its time (an alarm was turned off at 06:30, the briefing planned for 07:00): the PC writes it anyway", async () => {
    briefing.resetBriefingForTests();
    await saveKeyOnPc();
    morning.saveMorningSettings({ items: [] });
    // A time later today: the window (and `due`) are false, so the automatic
    // path rightly hands nothing over — but the phone asking is the person
    // asking, so `prepare` must still write it. This is the CI failure that
    // said "your PC has no briefing to read out yet" while the PC had topics
    // and a key and wrote it minutes later, on its own schedule.
    const later = new Date(Date.now() + 30 * 60_000);
    const time = `${String(later.getHours()).padStart(2, "0")}:${String(later.getMinutes()).padStart(2, "0")}`;
    memory.setBriefingPlan({ topics: ["new trending GitHub repositories"], time, auto: true });
    const client = await pairedClient();

    const before = await client.briefingToday();
    expect(before).toMatchObject({ inWindow: false, message: null });

    fake.queue.push(searchAnswer, text("Good morning early! On GitHub: agent-lab is trending."));
    const after = await client.briefingToday({ prepare: true });
    const day = coreMorning.localDay(new Date());
    expect(after.message).toMatchObject({ briefingDate: day, text: "Good morning early! On GitHub: agent-lab is trending." });
    expect(briefing.briefingStatus().message).toMatchObject({ briefingDate: day });
  });

  it("when the PC can't write one, it names the missing ingredient instead of staying silent", async () => {
    briefing.resetBriefingForTests();
    memory.setBriefingPlan({ topics: [], time: minutesAgo(3), auto: true });
    const client = await pairedClient();
    // No key on the PC and nothing to research: the phone must hear which one
    // it is, so it can write its own briefing and say the truth about why.
    // Nothing at all: the key is the first thing missing.
    let status = await client.briefingToday({ prepare: true });
    expect(status.message).toBeNull();
    expect(status.prepareRefused).toBe("no-key");

    await saveKeyOnPc();
    status = await client.briefingToday({ prepare: true });
    expect(status.message).toBeNull();
    expect(status.prepareRefused).toBe("no-topics");

    // And when it can, there is no refusal to report — it just writes it.
    memory.setBriefingPlan({ topics: ["new trending GitHub repositories"], time: minutesAgo(3), auto: true });
    fake.queue.push(searchAnswer, text("Good morning! Ollama 1.0 is out."));
    status = await client.briefingToday({ prepare: true });
    expect(status.prepareRefused).toBeNull();
    expect(status.message).toMatchObject({ text: "Good morning! Ollama 1.0 is out." });
  });

  it("with the PC off the phone writes its own briefing; back online it counts as heard on the PC too", async () => {
    briefing.resetBriefingForTests();
    await saveKeyOnPc();
    memory.setBriefingPlan({ topics: ["new trending GitHub repositories"], time: minutesAgo(3), auto: true });
    const client = await pairedClient();
    const kit = await client.fetchKit();
    if (!kit.enabled) throw new Error("no kit");
    let snapshot: Parameters<typeof offline.effectiveMemory>[0] = null;
    client.on("memory", (m) => (snapshot = m));
    await client.sync();
    expect(snapshot!.briefing.topics).toEqual(["new trending GitHub repositories"]);
    const port = listener.listenerState().port!;
    await listener.stopListener();

    fake.queue.push(searchAnswer, text("Good morning from your phone! On GitHub: agent-lab is trending."));
    const r = await offline.offlineMorning({ kit, memory: offline.effectiveMemory(snapshot, []) });
    const day = coreMorning.localDay(new Date());
    expect(r).toMatchObject({ text: "Good morning from your phone! On GitHub: agent-lab is trending.", briefingDate: day, research: "new trending GitHub repositories: Google Search" });
    expect(generateCalls()[0]!.key).toBe(KEY);

    service.setEnabledFlag(true);
    await listener.startListener({ host: "127.0.0.1", port });
    expect(await client.connect()).toBe(true);
    const at = Date.now();
    await client.merge({
      messages: [{ id: `${at}-brief1`, sender: "assistant", text: r.text, time: "", at, tag: "SYS", answeredBy: "phone", briefingDate: day }],
      memoryOps: [],
      heard: [],
    });
    expect(briefing.todaysBriefingMessage(day)).toMatchObject({ answeredBy: "phone", briefingDate: day });
    expect(briefing.briefingStatus().heard).toMatchObject({ on: "phone" });
  });
});
