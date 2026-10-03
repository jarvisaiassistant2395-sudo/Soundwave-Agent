// The agent's memory (lib/memory.ts) and the Soundwave guide (brain/core/guide.ts):
// notes from the Memory tab and from Gemini's remember / forget, the running
// summary (long conversations and Clear), what the agent sees, the snapshot
// paired phones get, and the guide tool Gemini explains the app from.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { call, startFakeGoogle, text, useFakeGoogle, type FakeGoogle } from "./helpers/fakeGoogle.js";

vi.hoisted(() => {
  // The desktop app: memory, Settings → Brain and the PC tools.
  process.env.DESKTOP_APP = "1";
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests, getStore } = await import("../src/lib/store.js");
const settings = await import("../src/lib/brain/settings.js");
const memory = await import("../src/lib/memory.js");
const conversation = await import("../src/lib/conversation.js");
const guide = await import("../src/lib/brain/core/guide.js");
const coreMemory = await import("../src/lib/brain/core/memory.js");

const KEY = "AIzaSyMemoryTest-0123456789-abcdwxyz";
let fake: FakeGoogle;
let app: ReturnType<typeof createApp>;

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
});

beforeEach(() => {
  fake.reset();
  settings.resetBrainSettingsForTests();
  memory.resetMemoryForTests();
  fs.rmSync(path.join(config.dataDir, "agent-conversation.json"), { force: true });
  conversation.resetConversationForTests();
});

const saveKey = () => settings.saveBrainSettings({ apiKey: KEY });
const chat = (message: string) => request(app).post("/api/v1/agent/chat").send({ message });
const instructionOf = (i: number) => fake.generateCalls()[i]!.body.systemInstruction.parts[0].text as string;
const toolNames = (i: number) =>
  (fake.generateCalls()[i]!.body.tools as Array<{ functionDeclarations?: Array<{ name: string }> }>).flatMap((t) => (t.functionDeclarations ?? []).map((d) => d.name));
const lastResponse = (i: number) => fake.generateCalls()[i]!.body.contents.at(-1).parts[0].functionResponse;

async function addShort(topic: string, status: "COMPLETED" | "FAILED", extra: Record<string, unknown> = {}) {
  const store = await getStore();
  return store.createJob({
    projectId: null,
    userId: "local-user",
    status,
    progress: status === "COMPLETED" ? 100 : 40,
    settings: { topic, ...extra } as never,
    outputUrl: null,
    errorMessage: status === "FAILED" ? "The voice service didn't answer" : null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
}

describe("the Memory tab (Command Center → gear → Memory)", () => {
  it("adds, edits and forgets notes, never keeps secrets, and can forget everything", async () => {
    const empty = await request(app).get("/api/v1/memory").set("Host", "127.0.0.1");
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ notes: [], summary: null, maxNotes: 60 });

    const added = await request(app).post("/api/v1/memory/notes").set("Host", "127.0.0.1").send({ text: "  My channel is about   space facts " });
    expect(added.status).toBe(201);
    expect(added.body.note).toMatchObject({ text: "My channel is about space facts", from: "app" });
    expect(added.body.note.id).toMatch(/^n_[0-9a-f]{10}$/);

    const again = await request(app).post("/api/v1/memory/notes").set("Host", "127.0.0.1").send({ text: "my channel is about space facts!" });
    expect(again.body.note.id).toBe(added.body.note.id); // same words: no duplicate
    expect(again.body.notes).toHaveLength(1);

    const secret = await request(app).post("/api/v1/memory/notes").set("Host", "127.0.0.1").send({ text: "my key is AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
    expect(secret.status).toBe(400);
    expect(secret.body.error.message).toMatch(/never kept in memory/);

    const edited = await request(app).patch(`/api/v1/memory/notes/${added.body.note.id}`).set("Host", "127.0.0.1").send({ text: "My channel is about space facts for teens" });
    expect(edited.body.note.text).toBe("My channel is about space facts for teens");

    expect((await request(app).delete("/api/v1/memory/notes/n_nothere00").set("Host", "127.0.0.1")).status).toBe(404);
    const forgotten = await request(app).delete(`/api/v1/memory/notes/${added.body.note.id}`).set("Host", "127.0.0.1");
    expect(forgotten.body.notes).toEqual([]);

    memory.addNote("The user's name is Strahinja");
    const cleared = await request(app).delete("/api/v1/memory").set("Host", "127.0.0.1");
    expect(cleared.body).toMatchObject({ notes: [], summary: null });

    // Other sites can't read or change it.
    const evil = await request(app).get("/api/v1/memory").set("Host", "127.0.0.1").set("Origin", "https://evil.example");
    expect(evil.status).toBe(403);
  });
});

describe("what Gemini remembers", () => {
  it("sees the notes and the shorts made, and saves and forgets notes itself", async () => {
    saveKey();
    memory.addNote("The user's name is Strahinja");
    const job = await addShort("black holes", "COMPLETED", { youtubeUrl: "https://youtube.com/shorts/abc123" });

    fake.gemini.push(call("remember", { note: "The user posts a new short every day at 6 pm." }, "r1"), text("Got it — I'll remember that."));
    const res = await chat("remember that I post every day at 6 pm");
    expect(res.body.reply).toBe("Got it — I'll remember that.");

    const instruction = instructionOf(0);
    expect(instruction).toMatch(/Your memory:/);
    expect(instruction).toMatch(/\[n_[0-9a-f]{10}\] The user's name is Strahinja/);
    expect(instruction).toMatch(/“black holes” — finished .*on YouTube: https:\/\/youtube\.com\/shorts\/abc123/);
    expect(instruction).toMatch(/save it with remember/);
    expect(toolNames(0)).toEqual(expect.arrayContaining(["remember", "forget", "soundwave_guide", "run_morning_setup", "make_youtube_short"]));
    expect(lastResponse(1).response).toMatchObject({ saved: true, alreadyKnown: false, notes: 2 });
    expect(memory.memoryNotes().map((n) => n.text)).toContain("The user posts a new short every day at 6 pm.");
    expect(memory.memoryNotes().at(-1)!.from).toBe("pc");

    fake.gemini.push(call("forget", { note: "posts every day 6 pm" }, "f1"), text("Done, I've forgotten that."));
    await chat("forget the thing about 6 pm");
    expect(lastResponse(3).response).toMatchObject({ forgotten: true });
    expect(memory.memoryNotes().map((n) => n.text)).toEqual(["The user's name is Strahinja"]);

    fake.gemini.push(call("remember", { note: "Their Gemini key is AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345" }, "r2"), text("I won't store keys."));
    await chat("remember my key");
    expect(lastResponse(5).response).toMatchObject({ saved: false });
    expect(memory.memoryNotes()).toHaveLength(1);
    await (await getStore()).updateJob(job.id, { status: "FAILED" });
  });

  it("folds a long conversation into a summary, and keeps the old one when the chat is cleared", async () => {
    saveKey();
    const start = Date.now() - 3_600_000;
    for (let i = 0; i < 40; i++) {
      conversation.appendToConversation({ id: `${start + i * 1000}-m${String(i).padStart(4, "0")}`, sender: i % 2 ? "assistant" : "user", text: `message ${i} about octopuses`, time: "", at: start + i * 1000 });
    }
    fake.gemini.push(text("The user asked about octopuses many times; Soundwave answered each question."));
    expect(await memory.summarizeOlderMessages()).toBe(true);
    const [req] = fake.generateCalls();
    expect(req!.path).toBe("/v1beta/models/gemini-3.5-flash-lite:generateContent"); // the light model: saves the chat model's quota
    expect(req!.body.systemInstruction.parts[0].text).toBe(coreMemory.SUMMARY_INSTRUCTION);
    const prompt = req!.body.contents[0].parts[0].text as string;
    expect(prompt).toMatch(/^Previous summary:\n\(none yet\)/);
    expect(prompt).toMatch(/User: message 0 about octopuses/);
    expect(prompt).toMatch(/message 15 about octopuses/); // 40 - 24 = the 16 oldest
    expect(prompt).not.toMatch(/message 16 about/); // still sent with every question
    expect(memory.memoryState().summary?.text).toBe("The user asked about octopuses many times; Soundwave answered each question.");
    expect(await memory.summarizeOlderMessages()).toBe(false); // nothing new to fold yet

    // Clear in the Command Center: the rest of the old conversation goes into the summary first.
    const stop = memory.initMemory();
    try {
      fake.gemini.push(text("The user asked about octopuses; Soundwave answered. Then the chat was cleared."));
      conversation.resetConversation([{ id: `${Date.now()}-clear`, sender: "assistant", text: "Conversation cleared.", time: "", at: Date.now() }]);
      await vi.waitFor(() => expect(memory.memoryState().summary?.text).toMatch(/cleared/), { timeout: 3000 });
      const clearPrompt = fake.generateCalls()[1]!.body.contents[0].parts[0].text as string;
      expect(clearPrompt).toMatch(/Previous summary:\nThe user asked about octopuses many times/);
      expect(clearPrompt).toMatch(/message 39 about octopuses/);
      expect(clearPrompt).not.toMatch(/message 3 about/); // already in the summary
    } finally {
      stop();
    }

    // Gemini sees it next time.
    fake.gemini.push(text("Welcome back!"));
    await chat("hi again");
    expect(instructionOf(2)).toMatch(/Summary of earlier conversations \(updated just now\):\nThe user asked about octopuses; Soundwave answered\. Then the chat was cleared\./);
  });

  it("gives paired phones a snapshot that changes when the memory does", async () => {
    memory.addNote("Likes Ryan's voice");
    const a = await memory.memorySnapshot();
    expect(a).toMatchObject({ notes: [expect.objectContaining({ text: "Likes Ryan's voice" })], youtube: { linked: false }, lastMorningAt: null });
    expect(a.shorts).toMatchObject({ total: expect.any(Number) });
    memory.noteMorningRun(1_790_000_000_000);
    const b = await memory.memorySnapshot();
    expect(b.rev).not.toBe(a.rev);
    expect(b.lastMorningAt).toBe(1_790_000_000_000);
    expect((await memory.memorySnapshot()).rev).toBe(b.rev); // same memory, same rev

    // A phone's offline changes replay on the PC.
    memory.applyPhoneMemoryOps([
      { op: "add", note: { id: "n_phone00001", text: "Wants a short about volcanoes tomorrow", at: Date.now() } },
      { op: "add", note: { id: "n_phone00002", text: "likes ryan's voice", at: Date.now() } }, // already known
      { op: "forget", id: memory.memoryNotes()[0]!.id },
    ]);
    expect(memory.memoryNotes().map((n) => [n.text, n.from])).toEqual([["Wants a short about volcanoes tomorrow", "phone"]]);
  });
});

describe("the Soundwave guide", () => {
  it("is offered to Gemini, which reads the YouTube linking walkthrough from it", async () => {
    saveKey();
    fake.gemini.push(call("soundwave_guide", { section: "youtube-link" }, "g1"), text("Here's how to link YouTube, step by step…"));
    const res = await chat("how do I link my YouTube channel?");
    expect(res.body.reply).toMatch(/step by step/);

    const decl = (fake.generateCalls()[0]!.body.tools as Array<{ functionDeclarations?: Array<{ name: string; parameters?: any }> }>)
      .flatMap((t) => t.functionDeclarations ?? [])
      .find((d) => d.name === "soundwave_guide")!;
    expect(decl.parameters.properties.section.enum).toEqual(guide.GUIDE_IDS);
    expect(instructionOf(0)).toMatch(/call soundwave_guide for the right section first/);
    expect(instructionOf(0)).toMatch(/- youtube-link: one press when the app ships/);

    const section = lastResponse(1).response.sections[0];
    expect(section.id).toBe("youtube-link");
    for (const fact of ["YouTube Data API v3", "Google Auth platform", "Test users", "Desktop app", "Connect YouTube", "audit", "7 days", "10,000 YouTube API units", "six shorts a day", "redirect_uri_mismatch"]) {
      expect(section.text).toContain(fact);
    }
  });

  it("covers every feature with the real names, and finds sections from plain words", async () => {
    const ids = guide.GUIDE_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of guide.GUIDE_SECTIONS) expect(s.summary.length).toBeLessThan(170);
    const textOf = (id: string) => guide.guideSection(id)!.text;
    expect(textOf("brain")).toMatch(/aistudio\.google\.com\/apikey[\s\S]*Save & test/);
    expect(textOf("phone")).toMatch(/Chat from the phone when this PC is off/);
    expect(textOf("morning-setup")).toMatch(/Settings → Morning Setup/);
    expect(textOf("morning-setup")).toMatch(/starts talking as soon as you open the Soundwave app/);
    expect(textOf("morning-setup")).toMatch(/Gemini 2\.5 Flash searches Google \(free with a free Gemini key/);
    expect(textOf("morning-setup")).toMatch(/With the PC off: the phone does everything itself/);
    expect(textOf("memory")).toMatch(/gear → Memory tab/);
    expect(textOf("reading")).toMatch(/read_video|reads the uploader's subtitles/);
    expect(textOf("reading")).toMatch(/r\.jina\.ai/);
    expect(textOf("reading")).toMatch(/can't read Twitter, Instagram, TikTok, Reddit/);
    expect(textOf("command-center")).toMatch(/🌅 Morning Setup/);
    expect(guide.GUIDE_SECTIONS.map((s) => s.text).join("\n")).not.toMatch(/Deep Focus|Pomodoro/);
    expect(guide.searchGuide("my phone can't connect to the pc").map((s) => s.id)).toContain("phone");
    expect(guide.searchGuide("how to get a gemini api key")[0]!.id).toBe("brain");

    const tool = guide.guideTool<unknown>();
    expect(await tool.run({ section: "zzqx-wuv" }, {})).toMatchObject({ found: false, sections: guide.GUIDE_IDS });
    expect(await tool.run({ section: "upload youtube private" }, {})).toMatchObject({ found: true });
  });
});

describe("memory helpers", () => {
  it("finds notes by id or words, and spots secrets", () => {
    const notes = [
      { id: "n_aaaaaaaaaa", text: "The user's channel is about space facts", at: 1 },
      { id: "n_bbbbbbbbbb", text: "Prefers Sonia's voice", at: 2 },
    ];
    expect(coreMemory.findNote(notes, "[n_bbbbbbbbbb]")?.id).toBe("n_bbbbbbbbbb");
    expect(coreMemory.findNote(notes, "space facts channel")?.id).toBe("n_aaaaaaaaaa");
    expect(coreMemory.findNote(notes, "pizza")).toBeUndefined();
    expect(coreMemory.looksSecret("GOCSPX-abcdefghijk")).toBe(true);
    expect(coreMemory.looksSecret("refresh 1//0abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(coreMemory.looksSecret("I like the sea")).toBe(false);
  });
});
