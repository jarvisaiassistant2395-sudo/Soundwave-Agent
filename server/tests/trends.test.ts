// The trend scout (lib/trends.ts): twice a day it reads this week's popular
// Shorts from YouTube's search (lib/shortsTrends.ts, free, no Gemini), writes a
// digest, and every script is written with it in hand. When YouTube can't be
// read and a person presses refresh, it falls back to Gemini + Google Search
// (a fake Gemini on loopback here). Checked: YouTube findings land without any
// model call, background refreshes never spend Gemini quota, junk never wipes
// a good digest, and the scriptwriter sees the notes.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const { startFakeGoogle, text, useFakeGoogle } = await import("./helpers/fakeGoogle.js");
type FakeGoogle = Awaited<ReturnType<typeof startFakeGoogle>>;
const settings = await import("../src/lib/brain/settings.js");
const trends = await import("../src/lib/trends.js");
const viral = await import("../src/lib/brain/core/viral.js");
const { writeShortScript } = await import("../src/lib/brain/script.js");
const { toolsFor } = await import("../src/lib/brain/tools.js");
const shortsTrends = await import("../src/lib/shortsTrends.js");

/** YouTube unreachable: the default here, so the Gemini fallback can be tested. */
const youtubeDown = async () => {
  throw new Error("getaddrinfo ENOTFOUND www.youtube.com");
};

const KEY = "AIzaSyTREND-test-key-000wxyz";

const FINDINGS = [
  "Shorts under 35 seconds with a spoken hook in the first two seconds are out-performing slow intros this month.",
  "First-person past-tense mini stories are being pushed hard in the psychology and true crime tags.",
  "Creators are cutting on the beat every 2-3 seconds instead of holding one clip — retention is up on those cuts.",
  "Finance Shorts with a single number in the title are getting replayed more than list-style titles.",
];

const ANSWER = JSON.stringify({ findings: FINDINGS, sources: ["tubebuddy.com", "vidIQ blog"] });

/** The same answer, but with the grounding metadata a real search comes back with. */
const answerWithSources = (): { body: unknown } => ({
  body: {
    candidates: [
      {
        content: { role: "model", parts: [{ text: ANSWER, thoughtSignature: "dGV4dA==" }] },
        finishReason: "STOP",
        groundingMetadata: {
          groundingChunks: [{ web: { title: "tubebuddy.com", uri: "https://tubebuddy.com/blog" } }, { web: { title: "vidIQ blog", uri: "https://vidiq.com/blog" } }],
        },
      },
    ],
  },
});

let fake: FakeGoogle;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  fake = await startFakeGoogle();
  useFakeGoogle(config as unknown as Record<string, unknown>, fake);
  app = createApp();
});

afterAll(async () => {
  // Don't hand a researched digest to the next test file (one DATA_DIR for all).
  trends.resetTrendsForTests();
  shortsTrends.setShortsSearchForTests(null);
  await fake.close();
});

beforeEach(() => {
  fake.reset();
  trends.resetTrendsForTests();
  shortsTrends.setShortsSearchForTests(youtubeDown);
  settings.resetBrainSettingsForTests();
});

describe("the trend scout's Gemini fallback (YouTube unreachable)", () => {
  it("searches with Google Search when a person asks, and saves what came back", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.gemini.push(answerWithSources);

    const result = await trends.refreshTrends({ reason: "manual" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.digest.findings).toEqual(FINDINGS);
    expect(result.digest.sources).toEqual(["tubebuddy.com", "vidIQ blog"]);
    expect(result.digest.via).toBe("search");

    // It really asked a search model for the current state of Shorts.
    const call = fake.generateCalls()[0]!;
    expect(call.path).toContain("gemini-2.5-flash");
    expect(JSON.stringify(call.body.tools)).toContain("googleSearch");
    expect(call.body.contents[0].parts[0].text).toMatch(/what is actually working on YouTube Shorts right now/);

    // And the digest is on disk, for the next script to read.
    const status = trends.trendsStatus();
    expect(status.available).toBe(true);
    expect(status.findings).toEqual(FINDINGS);
    expect(status.ageDays).toBe(0);
    expect(status.due).toBe(false);
  });

  it("background refreshes never spend Gemini quota", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.gemini.push(text(ANSWER));
    for (const reason of ["schedule", "startup"] as const) {
      const result = await trends.refreshTrends({ reason });
      expect(result.ok).toBe(false);
    }
    expect(fake.generateCalls()).toHaveLength(0);
  });

  it("can't be left behind: nothing yet is due, and a digest goes stale after twelve hours", () => {
    expect(trends.trendsDue()).toBe(true); // nothing researched yet
    const file = path.join(config.dataDir, "trends.json");
    const wrote = (daysAgo: number) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ researchedAt: Date.now() - daysAgo * 86_400_000, findings: FINDINGS, sources: [] }), "utf8");
    };
    wrote(0.1);
    expect(trends.trendsStatus()).toMatchObject({ available: true, due: false, ageDays: 0.1 });
    wrote(0.4);
    expect(trends.trendsStatus().due).toBe(false); // still inside the window
    wrote(0.6);
    expect(trends.trendsStatus().due).toBe(true); // the scout looks again
    expect(trends.TREND_REFRESH_DAYS).toBe(0.5);
  });

  it("keeps a good digest when the next search fails or answers junk", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.gemini.push(text(ANSWER));
    expect((await trends.refreshTrends()).ok).toBe(true);
    const good = trends.loadTrendDigest()!;

    // Both models answer with nothing usable: the old digest must survive.
    fake.gemini.push(text("Nothing new found."), text("Sorry, I couldn't search."));
    const second = await trends.refreshTrends();
    expect(second.ok).toBe(false);
    expect(trends.loadTrendDigest()).toEqual(good);
    expect(trends.trendsStatus().findings).toEqual(FINDINGS);
  });

  it("without YouTube or a Gemini key it says why and doesn't change anything", async () => {
    const result = await trends.refreshTrends();
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(String((result as { detail?: string }).detail)).toMatch(/YouTube/);
    expect(fake.generateCalls()).toHaveLength(0);
    expect(trends.trendsStatus()).toMatchObject({ available: false, needsKey: false, due: true });
  });

  it("runs one search at a time", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.gemini.push(text(ANSWER));
    const [a, b] = await Promise.all([trends.refreshTrends(), trends.refreshTrends()]);
    expect(a).toEqual(b);
    expect(fake.generateCalls()).toHaveLength(1);
  });
});

describe("what the model's answer turns into", () => {
  it("reads the JSON it asked for", () => {
    expect(trends.parseTrendAnswer(ANSWER)).toEqual(FINDINGS);
  });

  it("still reads plain lines when the model ignores the JSON", () => {
    const plain = trends.parseTrendAnswer("- 40-second talking heads are winning in the health tag.\n2. Comment-bait questions at the end are back.\n\nShort clips of podcast moments keep spiking.");
    expect(plain).toHaveLength(3);
    expect(plain[0]).toMatch(/40-second talking heads/);
  });

  it("refuses 'nothing found' instead of inventing findings", () => {
    expect(trends.parseTrendAnswer("Nothing new found.")).toEqual([]);
    expect(trends.parseTrendAnswer("")).toEqual([]);
  });
});

describe("the scripts follow the research", () => {
  it("a fresh digest goes into the writing brief", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.gemini.push(text(ANSWER));
    await trends.refreshTrends();
    fake.gemini.push(text("placeholder")); // writeShortScript's own call is checked below

    const brief = viral.buildScriptInstruction({
      seconds: 60,
      niche: viral.nicheById("psychology"),
      trends: FINDINGS,
      trendsAt: Date.now(),
    });
    expect(brief).toContain("WHAT'S WORKING RIGHT NOW");
    expect(brief).toContain("Web research, today");
    for (const f of FINDINGS) expect(brief).toContain(f);
  });

  it("the scriptwriter really hands them to the model", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.gemini.push(text(ANSWER));
    await trends.refreshTrends();
    fake.gemini.push(
      text(
        "Your brain decides who to trust before either of you speaks, and it does it in under a second. " +
          "Researchers call it thin-slicing: a face, a posture and a pace, judged before a word lands. " +
          "But here is what nobody mentions. Mirroring the other person makes them rate you as more trustworthy — forty years of studies say so. " +
          "The catch: it only works when you are actually paying attention. Fake the mirroring and people feel the mismatch immediately. " +
          "So the copying was never the trick. It was proof that you were listening. " +
          "Which means the next time someone says they had a good feeling about you, you will know exactly why.",
      ),
    );

    const written = await writeShortScript("why do people trust each other instantly");
    expect(written).not.toBeNull();
    expect(written!.trendsAt).toBeGreaterThan(0);
    const scriptCall = fake.generateCalls().at(-1)!;
    const instruction = scriptCall.body.systemInstruction.parts[0].text as string;
    expect(instruction).toContain("WHAT'S WORKING RIGHT NOW");
    expect(instruction).toContain(FINDINGS[0]!);
  });
});

describe("the agent can answer what's trending", () => {
  it("reads the digest from the tool instead of searching again", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.gemini.push(text(ANSWER));
    await trends.refreshTrends();
    const before = fake.generateCalls().length;

    const tool = toolsFor({ userId: "trend-test", voice: "en-US-GuyNeural", resolution: "1080p", seconds: 60, desktop: true, platform: "linux", effects: { log: [] } } as never).find(
      (t) => t.declaration.name === "whats_trending",
    );
    expect(tool).toBeDefined();
    const result = await tool!.run({}, {} as never);
    expect(result).toMatchObject({ ok: true });
    expect(result.findings).toEqual(FINDINGS);
    expect(fake.generateCalls()).toHaveLength(before); // no extra model call
  });

  it("is honest before the first research", async () => {
    const tool = toolsFor({ userId: "trend-test", voice: "en-US-GuyNeural", resolution: "1080p", seconds: 60, desktop: true, platform: "linux", effects: { log: [] } } as never).find(
      (t) => t.declaration.name === "whats_trending",
    );
    const result = await tool!.run({}, {} as never);
    expect(result).toMatchObject({ ok: false });
    expect(String(result.reason)).toMatch(/popular Shorts from YouTube/);
  });
});

describe("the API the app shows", () => {
  it("GET /agent/trends reports the digest and its age", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.gemini.push(text(ANSWER));
    await trends.refreshTrends();

    const res = await request(app).get("/api/v1/agent/trends");
    expect(res.status).toBe(200);
    expect(res.body.refreshDays).toBe(trends.TREND_REFRESH_DAYS);
    expect(res.body.trends).toMatchObject({ available: true, due: false, needsKey: false });
    expect(res.body.trends.findings).toEqual(FINDINGS);
  });

  it("POST /agent/trends/refresh looks again, and says why when it can't", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.gemini.push(text(ANSWER));
    const ok = await request(app).post("/api/v1/agent/trends/refresh");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true });
    expect(ok.body.trends.findings).toEqual(FINDINGS);

    settings.resetBrainSettingsForTests();
    const noKey = await request(app).post("/api/v1/agent/trends/refresh");
    expect(noKey.status).toBe(200);
    expect(noKey.body.ok).toBe(false);
    expect(String(noKey.body.reason)).toMatch(/couldn't read this week's popular Shorts/);
  });
});
