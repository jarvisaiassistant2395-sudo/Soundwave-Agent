import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { JsonStore, setStoreForTests } from "../src/lib/store.js";
import { resetBrainSettingsForTests } from "../src/lib/brain/settings.js";

// Without a Gemini key (Settings → Brain) the agent doesn't pretend: it makes
// shorts, finds videos, and says how to add a key. Chat answered by Gemini is
// tested in tests/brain.test.ts.

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  resetBrainSettingsForTests();
  app = createApp();
});

describe("Agent Chat API (/api/v1/agent/chat) without a Gemini key", () => {
  it("rejects request without prompt", async () => {
    const res = await request(app).post("/api/v1/agent/chat").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("asks for a Gemini key instead of making something up", async () => {
    for (const prompt of ["Hello Soundwave AI, what can you do?", "What's the weather in Belgrade?", "Show me my CPU stats", "Start deep focus mode now"]) {
      const res = await request(app).post("/api/v1/agent/chat").send({ prompt });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, needsBrain: true, tag: "SYS" });
      expect(res.body.reply).toMatch(/Gemini API key/);
      expect(res.body.reply).toMatch(/Settings → Brain/);
      expect(res.body.reply).not.toMatch(/°C|CPU load|windows minimized/i);
      expect(res.body.executionReport).toBeUndefined();
    }
  });

  it("says there's no video yet when asked for one", async () => {
    const res = await request(app).post("/api/v1/agent/chat").send({ message: "where is my video?" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, action: "soundwave_shorts" });
    expect(res.body.reply).toMatch(/no finished short yet/);
    expect(res.body.videoUrl).toBeUndefined();
  });

  it("caps the history it accepts", async () => {
    const history = Array.from({ length: 101 }, (_, i) => ({ sender: "user", text: `m${i}` }));
    const res = await request(app).post("/api/v1/agent/chat").send({ message: "hi", history });
    expect(res.status).toBe(400);
  });
});
