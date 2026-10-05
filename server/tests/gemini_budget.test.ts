// The Gemini budget wrapper (lib/brain/gemini.ts + cache.ts + usage.ts): the
// app promises to spend as little Gemini as possible, so this checks the three
// things that make that true — identical requests are answered once, cached
// answers cost nothing, and a configured daily ceiling turns into the free
// path (GeminiError("quota")) instead of spending the person's Google quota.
// No internet: a fake Gemini on loopback.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { config } = await import("../src/config.js");
const { startFakeGoogle, text, useFakeGoogle } = await import("./helpers/fakeGoogle.js");
type FakeGoogle = Awaited<ReturnType<typeof startFakeGoogle>>;
const gemini = await import("../src/lib/brain/gemini.js");
const cache = await import("../src/lib/brain/cache.js");
const usage = await import("../src/lib/brain/usage.js");

const KEY = "AIzaSyBUDGET-test-key-000wxyz";

let fake: FakeGoogle;

beforeAll(async () => {
  fake = await startFakeGoogle();
  useFakeGoogle(config as unknown as Record<string, unknown>, fake);
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.reset();
  cache.resetGeminiCacheForTests();
  usage.resetGeminiUsageForTests();
  delete process.env.GEMINI_DAILY_LIMIT;
  delete process.env.GEMINI_DAILY_LIMITS;
});

const ask = (purpose: string, prompt: string, opts: Record<string, unknown> = {}) =>
  gemini.generateContent({
    apiKey: KEY,
    model: "gemini-2.5-flash",
    purpose,
    request: { contents: [{ role: "user", parts: [{ text: prompt }] }] },
    ...opts,
  });

describe("Gemini budget: one answer per question", () => {
  it("answers the identical question from the cache the second time", async () => {
    fake.gemini.push(text("first answer"));
    const one = await ask("script", "Write a hook about the ocean", { cache: true });
    const two = await ask("script", "Write a hook about the ocean", { cache: true });
    expect(fake.generateCalls()).toHaveLength(1);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(usage.geminiUsageReport()).toMatchObject({ calls: 1, cached: 1 });
  });

  it("shares one call between requests issued at the same time", async () => {
    fake.gemini.push(text("one in flight"));
    const [a, b] = await Promise.all([ask("script", "same question", { cache: true }), ask("script", "same question", { cache: true })]);
    expect(fake.generateCalls()).toHaveLength(1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(usage.geminiUsageReport().calls).toBe(1);
  });

  it("refuses to cache unless the caller says the answer is reusable", async () => {
    // The same request twice, without `cache: true`: both reach Google,
    // because only the caller knows whether "the same question" is really the
    // same (a briefing researched just now must not be last week's).
    fake.gemini.push(text("fresh one"), text("fresh two"));
    await ask("morning", "what happened today");
    await ask("morning", "what happened today");
    expect(fake.generateCalls()).toHaveLength(2);
    expect(usage.geminiUsageReport().cached).toBe(0);
  });

  it("never caches an answer that used a tool, and never answers a fresh question from one", async () => {
    fake.gemini.push(text("searched"), text("searched"), text("ping"), text("ping"));
    const withTool = { tools: [{ googleSearch: {} }] };
    await ask("trends", "what is working", { cache: true, request: { contents: [{ role: "user", parts: [{ text: "what is working" }] }], ...withTool } });
    await ask("trends", "what is working", { cache: true, request: { contents: [{ role: "user", parts: [{ text: "what is working" }] }], ...withTool } });
    await ask("test", "ping");
    await ask("test", "ping");
    expect(fake.generateCalls()).toHaveLength(4);
    expect(usage.geminiUsageReport().cached).toBe(0);
  });

  it("keeps answers apart when only the model differs", async () => {
    fake.gemini.push(text("flash"), text("pro"));
    await ask("script", "same prompt", { cache: true });
    await ask("script", "same prompt", { cache: true, model: "gemini-2.5-pro" });
    expect(fake.generateCalls()).toHaveLength(2);
    expect(fake.generateCalls()[1]!.path).toContain("gemini-2.5-pro");
    expect(usage.geminiUsageReport().cached).toBe(0);
  });
});

describe("Gemini budget: the daily ceiling", () => {
  it("stops calling Google once the purpose's limit is reached, and says so", async () => {
    process.env.GEMINI_DAILY_LIMITS = "script=2";
    fake.gemini.push(text("one"), text("two"));
    await ask("script", "first");
    await ask("script", "second");
    expect(usage.remainingCalls("script")).toBe(0);

    const blocked = await ask("script", "third").catch((err: unknown) => err);
    expect(blocked).toBeInstanceOf(gemini.GeminiError);
    expect((blocked as InstanceType<typeof gemini.GeminiError>).kind).toBe("quota");
    expect((blocked as Error).message).toMatch(/free local path/);
    // The third question never left the machine.
    expect(fake.generateCalls()).toHaveLength(2);
    expect(usage.geminiUsageReport()).toMatchObject({ calls: 2, blocked: 1 });
  });

  it("lets other purposes keep working and honours GEMINI_DAILY_LIMIT for all of them", async () => {
    process.env.GEMINI_DAILY_LIMITS = "script=1";
    process.env.GEMINI_DAILY_LIMIT = "2";
    fake.gemini.push(text("script"), text("chat"));
    await ask("script", "a script");
    await ask("chat", "a question");
    expect(usage.remainingCalls("script")).toBe(0);
    expect(usage.remainingCalls("chat")).toBe(0); // the total is used up

    const blocked = await ask("memory", "remember this").catch((err: unknown) => err);
    expect((blocked as InstanceType<typeof gemini.GeminiError>).kind).toBe("quota");
    expect(fake.generateCalls()).toHaveLength(2);
  });

  it("still answers from the cache when the ceiling is reached (cached answers are free)", async () => {
    process.env.GEMINI_DAILY_LIMITS = "script=1";
    fake.gemini.push(text("the only call"));
    await ask("script", "one question", { cache: true });
    // The ceiling is used up, but the answer to the same question is here.
    const again = await ask("script", "one question", { cache: true });
    expect(JSON.stringify(again)).toContain("the only call");
    expect(fake.generateCalls()).toHaveLength(1);
    expect(usage.geminiUsageReport().blocked).toBe(0);
  });

  it("never blocks a call marked bypassBudget (Settings → Test key)", async () => {
    process.env.GEMINI_DAILY_LIMIT = "1";
    fake.gemini.push(text("one"), text("two"));
    await ask("chat", "counted");
    const stillAnswered = await ask("test", "ping", { bypassBudget: true });
    expect(JSON.stringify(stillAnswered)).toContain("two");
    expect(fake.generateCalls()).toHaveLength(2);
  });

  it("reports the day's numbers per purpose, and counts a cache hit", async () => {
    fake.gemini.push(text("ok"), text("ok again"));
    await ask("script", "one question", { cache: true });
    await ask("script", "one question", { cache: true });
    await ask("morning", "a different question");
    const report = usage.geminiUsageReport();
    expect(report.calls).toBe(2);
    expect(report.cached).toBe(1);
    expect(report.byPurpose).toEqual({ script: 1, morning: 1 });
    expect(report.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
