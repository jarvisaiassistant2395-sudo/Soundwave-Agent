// The phone's own brain (PC off): chat, memory, Morning Setup and voice input
// through the shared agent core, against a stand-in Gemini + Open-Meteo.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { effectiveMemory, offlineMorning, offlineReply, phoneMessageId, transcribeOffline, type MemoryOp, type MemorySnapshot, type PhoneKit } from "./offline";

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
const seen: Seen[] = [];
const queue: Array<(s: Seen) => { status?: number; body: unknown }> = [];
let base = "";

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url ?? "/", "http://x");
    const s: Seen = { path: u.pathname + u.search, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    seen.push(s);
    let out: { status?: number; body: unknown };
    if (u.pathname === "/geocode") out = { body: { results: [{ name: "Kruševac", latitude: 43.58, longitude: 21.33, country: "Serbia" }] } };
    else if (u.pathname === "/forecast")
      out = { body: { current: { temperature_2m: 11.6, weather_code: 61 }, daily: { temperature_2m_max: [15], temperature_2m_min: [7], precipitation_probability_max: [80], weather_code: [61] } } };
    else out = queue.shift()?.(s) ?? { status: 500, body: { error: { code: 500, message: "nothing queued" } } };
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
});

const text = (t: string) => () => ({ body: { candidates: [{ content: { role: "model", parts: [{ text: t }] }, finishReason: "STOP" }] } });
const call = (name: string, args: Record<string, unknown>, id: string) => () => ({
  body: { candidates: [{ content: { role: "model", parts: [{ functionCall: { id, name, args }, thoughtSignature: "c2ln" }] }, finishReason: "STOP" }] },
});
const generateCalls = () => seen.filter((s) => s.path.includes(":generateContent"));

let kit: PhoneKit;
const memory: MemorySnapshot = {
  rev: "r1",
  notes: [{ id: "n_aaaaaaaaaa", text: "The user's channel is about space facts", at: Date.now() - 86_400_000, from: "pc" }],
  briefing: { topics: ["the latest news about open-source, free AI tools"], time: "07:30", auto: true, updatedAt: 1 },
  summary: { text: "Yesterday the user made a short about black holes and planned one about Saturn.", updatedAt: Date.now() - 3_600_000 },
  shorts: {
    total: 5,
    completed: 4,
    recent: [
      { id: "j2", topic: "Saturn's rings", status: "COMPLETED", when: new Date(Date.now() - 2 * 3_600_000).toISOString(), youtubeUrl: "https://youtube.com/shorts/sat" },
      { id: "j1", topic: "black holes", status: "COMPLETED", when: new Date(Date.now() - 30 * 3_600_000).toISOString(), youtubeUrl: null },
    ],
  },
  youtube: { linked: true, channelTitle: "Orbit Facts" },
  lastMorningAt: Date.now() - 20 * 3_600_000,
  takenAt: Date.now() - 600_000,
};

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  kit = {
    enabled: true,
    apiKey: "AIzaSyPhoneKit-0123456789-abcdwxyz",
    model: "gemini-3.8-flash",
    modelLabel: "Gemini 3.8 Flash",
    fallbackModel: "gemini-3.5-flash-lite",
    thinking: "low",
    apiBase: base,
    weather: { city: "Kruševac", geocodingUrl: `${base}/geocode`, forecastUrl: `${base}/forecast` },
    ideas: true,
    rev: "k1",
  };
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  seen.length = 0;
  queue.length = 0;
});

describe("chatting on the phone while the PC is off", () => {
  it("asks Gemini directly, with the conversation, the memory and what it can do from the phone", async () => {
    queue.push(text("We made a short about Saturn's rings two hours ago — want ideas for the next one?"));
    const ops: MemoryOp[] = [];
    const reply = await offlineReply({
      kit,
      memory: effectiveMemory(memory, []),
      history: [
        { sender: "user", text: "make a short about saturn" },
        { sender: "assistant", text: "On it!" },
      ],
      message: "what did we do last time?",
      record: (op) => ops.push(op),
    });
    expect(reply).toEqual({ text: "We made a short about Saturn's rings two hours ago — want ideas for the next one?", model: "gemini-3.8-flash" });
    const [req] = generateCalls();
    expect(req!.path).toBe("/v1beta/models/gemini-3.8-flash:generateContent");
    expect(req!.headers["x-goog-api-key"]).toBe(kit.apiKey);
    expect(req!.body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    const instruction = req!.body.systemInstruction.parts[0].text as string;
    expect(instruction).toMatch(/the user's PC is off or out of reach, so you are answering from the Soundwave phone app on your own/);
    expect(instruction).toMatch(/\[n_aaaaaaaaaa\] The user's channel is about space facts/);
    expect(instruction).toMatch(/Summary of earlier conversations .*\nYesterday the user made a short about black holes/);
    expect(instruction).toMatch(/“Saturn's rings” — finished 2 hours ago, on YouTube/);
    expect(instruction).toMatch(/You can't \(yet\): make shorts, show or download videos, open anything on the PC/);
    const tools = req!.body.tools[0].functionDeclarations.map((d: { name: string }) => d.name);
    expect(tools).toEqual(["soundwave_guide", "remember", "forget", "update_morning_briefing", "set_phone_alarm"]);
    expect(ops).toEqual([]);
  });

  it("explains Soundwave from the guide, and remembers things for the PC", async () => {
    queue.push(call("soundwave_guide", { section: "youtube-link" }, "g1"), call("remember", { note: "The user wants to link YouTube this weekend." }, "r1"), text("Here's how… and I'll remember you want to do it this weekend."));
    const ops: MemoryOp[] = [];
    const reply = await offlineReply({ kit, memory: effectiveMemory(memory, []), history: [], message: "how do I link youtube? I'll do it this weekend", record: (op) => ops.push(op) });
    expect(reply.text).toMatch(/this weekend/);
    expect(generateCalls()[1]!.body.contents.at(-1).parts[0].functionResponse.response.sections[0].text).toMatch(/Connect YouTube account/);
    expect(ops).toEqual([{ op: "add", note: expect.objectContaining({ text: "The user wants to link YouTube this weekend.", from: "phone" }) }]);
    // The next turn sees the note before the PC has it.
    expect(effectiveMemory(memory, ops)!.notes.map((n) => n.text)).toEqual(["The user's channel is about space facts", "The user wants to link YouTube this weekend."]);
  });

  it("says plainly when Google refuses, in words for a phone", async () => {
    queue.push(() => ({ status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } } }));
    const reply = await offlineReply({ kit, memory: null, history: [], message: "hi", record: () => undefined });
    expect(reply).toMatchObject({ failed: true, model: null });
    expect(reply.text).toMatch(/Gemini API key isn't valid/);
  });
});

describe("Morning Setup on the phone (PC off)", () => {
  it("researches the briefing topics with Google Search, then briefs — nothing opened on the PC", async () => {
    queue.push(
      (req) => {
        expect(req.path).toBe("/v1beta/models/gemini-2.5-flash:generateContent");
        expect(req.body.tools).toEqual([{ googleSearch: {} }]);
        return { body: { candidates: [{ content: { role: "model", parts: [{ text: "Ollama 1.0 shipped." }] }, finishReason: "STOP", groundingMetadata: { groundingChunks: [{ web: { title: "example.com" } }] } }] } };
      },
      text("Good morning! Rainy in Kruševac today. Your Saturn short is on YouTube. On open-source AI tools: Ollama 1.0 shipped. Idea 1: … Idea 2: … Idea 3: …"),
    );
    const r = await offlineMorning({ kit, memory: effectiveMemory(memory, []) });
    expect(r.text).toMatch(/^Good morning! Rainy in Kruševac/);
    expect(r.briefingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.research).toBe("the latest news about open-source, free AI tools: Google Search");
    const prompt = generateCalls()[1]!.body.contents[0].parts[0].text as string;
    expect(prompt).toMatch(/1\. “the latest news about open-source, free AI tools” — researched with Google Search:\nOllama 1\.0 shipped\.\nSources: example\.com/);
    expect(prompt).toMatch(/Weather: In Kruševac it's 12°C and light rain, today between 7 and 15°C, 80% chance of rain\./);
    expect(prompt).toMatch(/Shorts since your last Morning Setup \(as of .+\):\n- finished: “Saturn's rings” \(on YouTube\)/);
    expect(prompt).not.toMatch(/black holes” \(on/); // older than the last Morning Setup
    expect(prompt).toMatch(/YouTube channel “Orbit Facts”/);
    expect(prompt).toMatch(/Ideas: yes — three new ones\. Already made \(don't repeat\): “Saturn's rings”, “black holes”/);
    expect(prompt).toMatch(/\(The PC is off: this briefing comes from the phone, so nothing was opened on the PC\.\)/);
  });

  it("falls back to a plain briefing when Gemini can't answer", async () => {
    queue.push(() => ({ status: 503, body: { error: { code: 503, message: "overloaded" } } }));
    const r = await offlineMorning({ kit: { ...kit, weather: { city: null } }, memory: { ...effectiveMemory(memory, [])!, briefing: { topics: [], time: "07:30", auto: true, updatedAt: 1 } } });
    expect(r.model).toBeNull();
    expect(r.text).toMatch(/^Good morning! It's \w+day \d+ \w+ \d{4}\. Since your last Morning Setup: your short about “Saturn's rings” finished \(on YouTube\)\./);
    expect(r.weatherNote).toMatch(/no city set/);
  });
});

describe("voice input on the phone (PC off)", () => {
  it("sends the recording to Gemini and returns what was said", async () => {
    queue.push(text("“Make a short about octopuses”"));
    const wav = new Uint8Array([82, 73, 70, 70, 9, 8, 7, 6]);
    const heard = await transcribeOffline({ kit, wav });
    expect(heard).toEqual({ text: "Make a short about octopuses", noSpeech: false });
    const part = generateCalls()[0]!.body.contents[0].parts[0];
    expect(part.inlineData.mimeType).toBe("audio/wav");
    expect(Buffer.from(part.inlineData.data, "base64").equals(Buffer.from(wav))).toBe(true);

    queue.push(text(""));
    expect(await transcribeOffline({ kit, wav })).toEqual({ text: "", noSpeech: true });
  });
});

describe("helpers", () => {
  it("makes message ids like the PC's", () => {
    expect(phoneMessageId(1_790_000_000_000)).toMatch(/^1790000000000-[0-9a-f]{6}$/);
  });

  it("changes the briefing plan from the phone (it goes back to the PC as a memory op)", async () => {
    queue.push(call("update_morning_briefing", { add_topics: ["new trending GitHub repositories"], time: "06:45" }, "u1"), text("Done — 06:45 with GitHub repos."));
    const ops: MemoryOp[] = [];
    await offlineReply({ kit, memory: effectiveMemory(memory, []), history: [], message: "add trending github repos, at 6:45", record: (op) => ops.push(op) });
    expect(ops).toEqual([{ op: "briefing", plan: expect.objectContaining({ topics: ["the latest news about open-source, free AI tools", "new trending GitHub repositories"], time: "06:45", auto: true }) }]);
    expect(effectiveMemory(memory, ops)!.briefing).toMatchObject({ time: "06:45" });
  });
});
