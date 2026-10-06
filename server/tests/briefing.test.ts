// The daily morning briefing: the plan in the agent's memory (Settings → Morning
// Setup and the update_morning_briefing tool), Gemini researching the topics
// (Google Search on Gemini 2.5 Flash; the public feeds when search isn't
// available), the briefing the PC writes when it's due, and "heard" across
// the PC and the phone.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { call, startFakeGoogle, text, useFakeGoogle, type FakeGoogle, type Seen } from "./helpers/fakeGoogle.js";
import { minutesAgo, minutesFromNow } from "./helpers/clock.js";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
});

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const settings = await import("../src/lib/brain/settings.js");
const memory = await import("../src/lib/memory.js");
const morning = await import("../src/lib/morning.js");
const briefing = await import("../src/lib/briefing.js");
const conversation = await import("../src/lib/conversation.js");
const research = await import("../src/lib/brain/core/research.js");
const coreMorning = await import("../src/lib/brain/core/morning.js");
const coreMemory = await import("../src/lib/brain/core/memory.js");
const { generateContent } = await import("../src/lib/brain/gemini.js");

const KEY = "AIzaSyBriefingTest-0123456789-abcdwxyz";
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
  delete (globalThis as { __soundwaveDesktopHost?: unknown }).__soundwaveDesktopHost;
});

beforeEach(() => {
  fake.reset();
  settings.resetBrainSettingsForTests();
  memory.resetMemoryForTests();
  briefing.resetBriefingForTests();
  for (const f of ["morning.json", "agent-conversation.json"]) fs.rmSync(path.join(config.dataDir, f), { force: true });
  conversation.resetConversationForTests();
  morning.saveMorningSettings({ items: [], city: "Kruševac" });
  (globalThis as { __soundwaveDesktopHost?: unknown }).__soundwaveDesktopHost = { openExternal: async () => undefined, openPath: async () => "" };
});

const local = (req: request.Test) => req.set("Host", "127.0.0.1");
const isSearch = (req: Seen) => Array.isArray(req.body?.tools) && req.body.tools.some((t: Record<string, unknown>) => "googleSearch" in t);
const promptOf = (req: Seen) => (req.body?.contents?.[0]?.parts?.[0]?.text ?? "") as string;
// The briefing request: the morning instruction, plus the agent's mode block
// (brain/core/persona.ts) — the mode is part of how the briefing is worded.
const isBriefingWriter = (req: Seen) =>
  String(req.body?.systemInstruction?.parts?.[0]?.text ?? "").startsWith(coreMorning.MORNING_INSTRUCTION);

/** Gemini answering searches about the topic in its prompt, and writing the briefing. */
function routeGemini(opts: { briefing?: string; searchFails?: boolean } = {}) {
  fake.router = (req) => {
    if (isSearch(req)) {
      if (opts.searchFails) return { status: 429, body: { error: { code: 429, message: "Quota exceeded for Google Search grounding.", status: "RESOURCE_EXHAUSTED" } } };
      const topic = /about: “([^”]+)”/.exec(promptOf(req))?.[1] ?? "";
      return {
        body: {
          candidates: [
            {
              content: { role: "model", parts: [{ text: /github/i.test(topic) ? "1. microsoft/agent-lab gained 9,400 stars this week.\n2. tiny-llm hit 5,000 stars." : "- Ollama 1.0 shipped with a new model library.\n- Mistral released open weights for Mistral Small 4." }] },
              finishReason: "STOP",
              groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/a", title: "example.com" } }, { web: { uri: "https://news.example/b", title: "news.example" } }] },
            },
          ],
        },
      };
    }
    if (isBriefingWriter(req)) return text(opts.briefing ?? "Good morning! On open-source AI tools: Ollama 1.0 shipped.")();
    return null;
  };
}

// The plan times these tests use ("a couple of minutes ago") come from
// helpers/clock.ts: subtracting minutes from Date.now() crosses midnight, and
// at 00:01 "2 minutes ago" is yesterday's 23:59 — a time later today, so the
// briefing is neither due nor in its window. That is exactly how this suite
// failed in CI once, at 00:00 UTC, for a reason unrelated to the change.

describe("the briefing plan (in the agent's memory)", () => {
  it("is set in Settings → Morning Setup and shown to the agent and the phone", async () => {
    const first = await local(request(app).get("/api/v1/morning"));
    expect(first.body.briefing).toMatchObject({ topics: [], time: "08:00", auto: true });

    const bad = await local(request(app).put("/api/v1/morning")).send({ briefing: { time: "8am" } });
    expect(bad.status).toBe(400);

    const saved = await local(request(app).put("/api/v1/morning")).send({
      briefing: { topics: ["The latest news about open-source, free AI tools", "New trending GitHub repositories", "the latest news about open-source, free AI tools"], time: "07:30", auto: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.briefing).toMatchObject({ topics: ["The latest news about open-source, free AI tools", "New trending GitHub repositories"], time: "07:30", auto: true });
    expect(memory.briefingPlan().topics).toHaveLength(2);

    const snap = await memory.memorySnapshot();
    expect(snap.briefing.topics).toEqual(["The latest news about open-source, free AI tools", "New trending GitHub repositories"]);
    expect(coreMemory.memoryPromptSection(snap)).toMatch(/Morning briefing: prepared every day at 07:30 .* Topics: 1\) The latest news about open-source, free AI tools; 2\) New trending GitHub repositories\./);
    expect((await local(request(app).get("/api/v1/memory"))).body.briefing.time).toBe("07:30");
  });

  it("changes when you tell the agent (update_morning_briefing), and a phone's offline change wins only if newer", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    memory.setBriefingPlan({ topics: ["Football results from Serbia"], time: "08:00", auto: true });
    fake.gemini.push(
      call("update_morning_briefing", { add_topics: ["new trending GitHub repositories"], remove_topics: ["football"], time: "07:15" }, "b1"),
      text("Done — I'll brief you on trending GitHub repos every morning at 07:15."),
    );
    const res = await request(app).post("/api/v1/agent/chat").send({ message: "brief me on trending github repos at 7:15 instead of football" });
    expect(res.body.reply).toMatch(/07:15/);
    expect(memory.briefingPlan()).toMatchObject({ topics: ["new trending GitHub repositories"], time: "07:15", auto: true });
    const decl = (fake.generateCalls()[0]!.body.tools as Array<{ functionDeclarations?: Array<{ name: string }> }>).flatMap((t) => t.functionDeclarations ?? []).map((d) => d.name);
    expect(decl).toContain("update_morning_briefing");
    expect(fake.generateCalls()[0]!.body.systemInstruction.parts[0].text).toMatch(/Change the user's morning briefing with update_morning_briefing/);

    const old = memory.briefingPlan().updatedAt - 1000;
    memory.applyPhoneMemoryOps([{ op: "briefing", plan: { topics: ["stale"], time: "06:00", auto: false, updatedAt: old } }]);
    expect(memory.briefingPlan().time).toBe("07:15");
    memory.applyPhoneMemoryOps([{ op: "briefing", plan: { topics: ["Space news"], time: "06:45", auto: true, updatedAt: Date.now() + 1000 } }]);
    expect(memory.briefingPlan()).toMatchObject({ topics: ["Space news"], time: "06:45" });
  });
});

describe("researching the topics", () => {
  it("asks Gemini 2.5 Flash to search Google for each topic (free on the free tier)", async () => {
    routeGemini();
    const out = await research.researchTopics(["the latest news about open-source, free AI tools", "new trending GitHub repositories"], {
      apiKey: KEY,
      model: "gemini-3.8-flash",
      generate: generateContent,
      now: new Date("2026-10-02T08:00:00Z"),
    });
    expect(out.map((t) => t.via)).toEqual(["search", "search"]);
    expect(out[0]!.summary).toBe("Ollama 1.0 shipped with a new model library.\nMistral released open weights for Mistral Small 4.");
    expect(out[1]!.summary).toMatch(/^microsoft\/agent-lab gained 9,400 stars this week\./);
    expect(out[0]!.sources).toEqual([
      { title: "example.com", url: "https://example.com/a" },
      { title: "news.example", url: "https://news.example/b" },
    ]);
    const searches = fake.generateCalls().filter(isSearch);
    expect(searches.map((r) => r.path)).toEqual(["/v1beta/models/gemini-2.5-flash:generateContent", "/v1beta/models/gemini-2.5-flash:generateContent"]);
    expect(searches[0]!.body.tools).toEqual([{ googleSearch: {} }]);
    expect(promptOf(searches[0]!)).toMatch(/^Today is Friday,? 2 October 2026\. Search the web for the latest news/);
  });

  it("falls back to GitHub, Hacker News and Google News when Google Search isn't available", async () => {
    routeGemini({ searchFails: true });
    fake.router = ((route) => (req: Seen) => {
      if (!isSearch(req) && /fresh items from the last few days/.test(promptOf(req))) return text("microsoft/agent-lab is the week's most-starred new repo (9,400 stars).")();
      return route(req);
    })(fake.router!);
    const fetched: string[] = [];
    const fetchText = async (url: string) => {
      fetched.push(url);
      if (url.startsWith("https://api.github.com/search/repositories")) {
        return JSON.stringify({ items: [{ full_name: "microsoft/agent-lab", description: "Agents, locally", stargazers_count: 9400, html_url: "https://github.com/microsoft/agent-lab", language: "Python" }] });
      }
      if (url.startsWith("https://hn.algolia.com/")) return JSON.stringify({ hits: [{ title: "Show HN: agent-lab", url: "https://x", points: 512 }] });
      if (url.startsWith("https://news.google.com/rss/search")) {
        return "<rss><channel><item><title><![CDATA[Open-source AI agents trend on GitHub &amp; beyond]]></title><link>https://n.example/1</link><source url='https://n.example'>Example News</source></item></channel></rss>";
      }
      return null;
    };
    const [brief] = await research.researchTopics(["new trending GitHub repositories about AI agents"], {
      apiKey: KEY,
      model: "gemini-3.8-flash",
      generate: generateContent,
      now: new Date("2026-10-02T08:00:00Z"),
      fetchText,
    });
    expect(brief).toMatchObject({ via: "feeds", summary: "microsoft/agent-lab is the week's most-starred new repo (9,400 stars)." });
    expect(brief!.sources.map((s) => s.title)).toEqual(["GitHub", "Hacker News", "Google News"]);
    // Both free-search models were tried first.
    expect(fake.generateCalls().filter(isSearch).map((r) => r.path.split("/")[3])).toEqual(["gemini-2.5-flash:generateContent", "gemini-2.5-flash-lite:generateContent"]);
    expect(decodeURIComponent(fetched.find((u) => u.includes("api.github.com"))!)).toMatch(/q=AI agents created:>2026-09-25&sort=stars/);
    const summing = fake.generateCalls().find((r) => /fresh items/.test(promptOf(r)))!;
    expect(summing.path).toBe("/v1beta/models/gemini-3.8-flash:generateContent");
    expect(promptOf(summing)).toMatch(/\[GitHub\] microsoft\/agent-lab — Agents, locally — 9400 stars this week, Python/);
    expect(promptOf(summing)).toMatch(/\[Google News\] Open-source AI agents trend on GitHub & beyond — Example News/);
  });

  it("reads keywords out of a topic and parses RSS", () => {
    expect(research.topicKeywords("the latest news about open-source, free AI tools")).toBe("open source AI tools");
    expect(research.topicKeywords("New trending GitHub repositories")).toBe("");
    expect(research.parseRss("<item><title>A &amp; B</title><link>https://l</link></item>")).toEqual([{ title: "A & B", url: "https://l", detail: undefined, from: "Google News" }]);
  });
});

describe("the clock the briefing window is measured with", () => {
  it("never names a time later today, even a minute after midnight", () => {
    // 00:01 local: "3 minutes ago" would be 23:58 — yesterday. The helper
    // clamps to 00:00, which is in the past and inside the 10-hour window.
    const justAfterMidnight = new Date(2026, 9, 6, 0, 1, 0, 0);
    expect(minutesAgo(3, justAfterMidnight)).toBe("00:00");
    expect(coreMorning.briefingDue("00:00", justAfterMidnight)).toBe(true);
    expect(coreMorning.inBriefingWindow("00:00", justAfterMidnight)).toBe(true);
    // Away from midnight it is the plain subtraction it looks like.
    const afternoon = new Date(2026, 9, 6, 14, 30, 0, 0);
    expect(minutesAgo(20, afternoon)).toBe("14:10");
    expect(coreMorning.briefingDue("14:10", afternoon)).toBe(true);
    // A plan time that hasn't arrived yet is not due, and "later today" stays today.
    expect(coreMorning.briefingDue("23:00", afternoon)).toBe(false);
    expect(minutesFromNow(30, new Date(2026, 9, 6, 23, 45, 0, 0))).toBe("23:59");
    expect(minutesFromNow(30, afternoon)).toBe("15:00");
  });
});

describe("the daily briefing", () => {
  it("is written when it's due — research included — and spoken once, wherever it's heard first", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    memory.setBriefingPlan({ topics: ["the latest news about open-source, free AI tools"], time: minutesAgo(2), auto: true });
    routeGemini({ briefing: "Good morning! On open-source AI tools: Ollama 1.0 shipped, and Mistral opened Small 4's weights." });

    const before = await local(request(app).get("/api/v1/morning/briefing"));
    expect(before.body).toMatchObject({ due: true, inWindow: true, message: null, heard: null });

    const prepared = await local(request(app).post("/api/v1/morning/briefing/prepare"));
    const day = coreMorning.localDay(new Date());
    expect(prepared.body.message).toMatchObject({ sender: "assistant", briefingDate: day, tag: "SYS", text: "Good morning! On open-source AI tools: Ollama 1.0 shipped, and Mistral opened Small 4's weights." });
    expect(prepared.body.message.actionOutput).toMatch(/the latest news about open-source, free AI tools: Google Search — example\.com, news\.example/);
    // In the shared conversation (the phone and the Command Center both see it).
    expect(conversation.getConversation().messages.at(-1)).toMatchObject({ briefingDate: day });

    const writer = fake.generateCalls().find(isBriefingWriter)!;
    const facts = promptOf(writer);
    expect(facts).toMatch(/Briefing topics \(cover each, in this order, using only its research\):\n1\. “the latest news about open-source, free AI tools” — researched with Google Search:\nOllama 1\.0 shipped with a new model library\.\nMistral released open weights for Mistral Small 4\.\nSources: example\.com, news\.example/);
    expect(writer.body.systemInstruction.parts[0].text).toMatch(/Then the user's own briefing topics, each in turn/);
    // The automatic briefing doesn't open things on the PC.
    expect(facts).not.toMatch(/Opened on the PC/);

    // A second request doesn't write another one.
    await local(request(app).post("/api/v1/morning/briefing/prepare"));
    expect(conversation.getConversation().messages.filter((m) => m.briefingDate === day)).toHaveLength(1);

    const heard = await local(request(app).post("/api/v1/morning/briefing/heard")).send({ day });
    expect(heard.body.heard).toMatchObject({ on: "pc" });
  });

  it("isn't due before its time or long after it", () => {
    const at = (h: number, m: number) => new Date(2026, 9, 2, h, m);
    expect(coreMorning.inBriefingWindow("08:00", at(7, 59))).toBe(false);
    expect(coreMorning.inBriefingWindow("08:00", at(8, 0))).toBe(true);
    expect(coreMorning.inBriefingWindow("08:00", at(17, 59))).toBe(true);
    expect(coreMorning.inBriefingWindow("08:00", at(18, 0))).toBe(false);
    expect(coreMorning.localDay(at(23, 30))).toBe("2026-10-02");
  });

  it("doesn't consume the day when there's nothing to prepare from (no key, or no topics)", async () => {
    // Nothing prepared at 10:00 by a fresh install that has no key yet: the
    // placeholder would block the real briefing for the whole 10-hour window,
    // so someone who adds their key later that morning would never get one.
    settings.saveBrainSettings({ apiKey: null });
    memory.setBriefingPlan({ topics: ["the latest news about open-source, free AI tools"], time: minutesAgo(2), auto: true });
    conversation.resetConversationForTests?.();
    briefing.resetBriefingForTests();
    const noKey = await local(request(app).post("/api/v1/morning/briefing/prepare"));
    expect(noKey.body.message).toBe(null);

    // With a key but still no topics there is nothing to research either.
    settings.saveBrainSettings({ apiKey: KEY });
    memory.setBriefingPlan({ topics: [], time: minutesAgo(2), auto: true });
    briefing.resetBriefingForTests();
    const noTopics = await local(request(app).post("/api/v1/morning/briefing/prepare"));
    expect(noTopics.body.message).toBe(null);

    // …and the moment there are both, it prepares — so the refusal above is the
    // missing input, not a broken scheduler.
    memory.setBriefingPlan({ topics: ["the latest news about open-source, free AI tools"], time: minutesAgo(2), auto: true });
    routeGemini({ briefing: "Good morning! Ollama 1.0 shipped." });
    briefing.resetBriefingForTests();
    const ready = await local(request(app).post("/api/v1/morning/briefing/prepare"));
    expect(ready.body.message).toMatchObject({ briefingDate: coreMorning.localDay(new Date()) });

    // The chip is a person asking, so it still answers without a key — with the
    // sentence that says what to do. (It isn't the automatic path, so the guard
    // above doesn't apply to it.)
    settings.saveBrainSettings({ apiKey: null });
    const chip = await local(request(app).post("/api/v1/morning/run"));
    expect(chip.status).toBe(200);
    expect(JSON.stringify(chip.body)).toMatch(/Add a Gemini key in Settings → Brain/);
  });

  it("isn't prepared without a plan that's due, and the chip counts as today's briefing", async () => {
    memory.setBriefingPlan({ topics: [], time: "23:59", auto: true });
    const st = briefing.briefingStatus(new Date(2026, 9, 2, 12, 0));
    expect(st).toMatchObject({ due: false, inWindow: false });

    // The 🌅 Morning Setup chip (no key: the plain briefing) is today's briefing, heard on the PC.
    const res = await local(request(app).post("/api/v1/morning/run"));
    expect(res.body.briefingDate).toBe(coreMorning.localDay(new Date()));
    // The Command Center adds it to the conversation itself; the PC marked it heard.
    expect((await local(request(app).get("/api/v1/morning/briefing"))).body.heard).toMatchObject({ on: "pc" });
  });
});
