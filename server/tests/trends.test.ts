// The trend scout (lib/trends.ts): the agent searches what is actually going
// viral on Shorts every few days, writes a digest, and every script is written
// with it in hand. The search is a fake Gemini on loopback (the real one is
// Gemini 2.5 Flash + Google Search — the models with free grounding), so what
// is checked here is the behaviour: fresh findings land, junk never wipes a
// good digest, no key means no pretending, and the scriptwriter sees the notes.
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
  await fake.close();
});

beforeEach(() => {
  fake.reset();
  trends.resetTrendsForTests();
  settings.resetBrainSettingsForTests();
});

describe("the trend scout", () => {
  it("searches with Google Search and saves what came back", async () => {
    settings.saveBrainSettings({ apiKey: KEY });
    fake.gemini.push(answerWithSources);

    const result = await trends.refreshTrends({ reason: "schedule" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.digest.findings).toEqual(FINDINGS);
    expect(result.digest.sources).toEqual(["tubebuddy.com", "vidIQ blog"]);

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

  it("can't be left behind: nothing yet is due, and a digest goes stale after three days", () => {
    expect(trends.trendsDue()).toBe(true); // nothing researched yet
    const file = path.join(config.dataDir, "trends.json");
    const wrote = (daysAgo: number) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ researchedAt: Date.now() - daysAgo * 86_400_000, findings: FINDINGS, sources: [] }), "utf8");
    };
    wrote(1);
    expect(trends.trendsStatus()).toMatchObject({ available: true, due: false, ageDays: 1 });
    wrote(2);
    expect(trends.trendsStatus().due).toBe(false); // still inside the window
    wrote(4);
    expect(trends.trendsStatus().due).toBe(true); // the scout looks again
    expect(trends.TREND_REFRESH_DAYS).toBe(3);
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

  it("without a Gemini key it says so and doesn't change anything", async () => {
    const result = await trends.refreshTrends();
    expect(result).toMatchObject({ ok: false, reason: "no-key" });
    expect(fake.generateCalls()).toHaveLength(0);
    expect(trends.trendsStatus()).toMatchObject({ available: false, needsKey: true, due: true });
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
    expect(String(result.reason)).toMatch(/Gemini API key/);
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
    expect(String(noKey.body.reason)).toMatch(/Settings → Brain/);
  });
});
