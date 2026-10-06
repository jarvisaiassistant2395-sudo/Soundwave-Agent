// The two pickers the app reads over HTTP: the agent's modes (GET/PUT
// /api/v1/agent/modes) and the Generate tab's niches (GET/POST/DELETE
// /api/v1/agent/niches). Both are this PC's settings, so both are validated
// strictly — the app must never be told it saved something it didn't.
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";

let app: ReturnType<typeof import("../src/app.js").createApp>;
const DATA_DIR = process.env.DATA_DIR;

beforeAll(async () => {
  // Desktop app: these settings belong to this machine, and the routes are the
  // app's own window talking to it.
  process.env.DESKTOP_APP = "";
  const { createApp } = await import("../src/app.js");
  app = createApp();
});

const modes = await import("../src/lib/brain/persona.js");
const niches = await import("../src/lib/brain/niches.js");
const viral = await import("../src/lib/brain/core/viral.js");

const local = (req: request.Test) => req.set("Host", "127.0.0.1");

beforeEach(() => {
  modes.resetPersonaSettingsForTests();
  niches.resetAddedNichesForTests();
  try {
    fs.rmSync(path.join(DATA_DIR, "trends.json"), { force: true });
  } catch {
    /* nothing saved */
  }
});

describe("GET/PUT /agent/modes", () => {
  it("serves the five modes and the one in use", async () => {
    const res = await local(request(app).get("/api/v1/agent/modes"));
    expect(res.status).toBe(200);
    expect(res.body.personas.map((p: { id: string }) => p.id)).toEqual(["professional", "friendly", "coach", "analyst", "calm"]);
    expect(res.body.current).toMatchObject({ persona: "friendly", address: null, addressSet: false, addresses: false });
    const executive = res.body.personas.find((p: { id: string }) => p.id === "professional");
    expect(executive).toMatchObject({ name: "Executive Assistant", addresses: true, defaultAddress: "sir" });
    // The rules stay on the server: the app never needs them.
    expect(executive.rules).toBeUndefined();
  });

  it("saves a mode and the form of address, and explains a bad one", async () => {
    const saved = await local(request(app).put("/api/v1/agent/modes").send({ persona: "professional", address: "sir" }));
    expect(saved.status).toBe(200);
    expect(saved.body.current).toMatchObject({ persona: "professional", name: "Executive Assistant", address: "sir", addressSet: true, addresses: true });
    expect(modes.loadPersonaSettings()).toMatchObject({ persona: "professional", address: "sir" });

    const bad = await local(request(app).put("/api/v1/agent/modes").send({ persona: "boss" }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/no mode called/i);
    const nothing = await local(request(app).put("/api/v1/agent/modes").send({}));
    expect(nothing.status).toBe(400);

    // An empty address clears the one they set; the mode stays, and the
    // mode's own default (“sir”) is what it calls them again.
    const cleared = await local(request(app).put("/api/v1/agent/modes").send({ address: "" }));
    expect(cleared.body.current).toMatchObject({ persona: "professional", address: "sir", addressSet: false });
  });
});

describe("/agent/niches", () => {
  it("serves the researched nine, badged additions and what's climbing", async () => {
    const res = await local(request(app).get("/api/v1/agent/niches"));
    expect(res.status).toBe(200);
    expect(res.body.niches.filter((n: { added?: boolean }) => !n.added)).toHaveLength(9);
    expect(res.body.added).toEqual([]);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.maxAdded).toBeGreaterThan(0);
  });

  it("adds a niche the person typed, and refuses a duplicate", async () => {
    const created = await local(request(app).post("/api/v1/agent/niches").send({ name: "Weather Explained", description: "Why the forecast changes", why: "asked for it" }));
    expect(created.status).toBe(201);
    expect(created.body.niche).toMatchObject({ id: "weather-explained", source: "user" });
    expect(created.body.added[0]).toMatchObject({ id: "weather-explained", source: "user", fresh: true });
    // The script engine knows it straight away.
    expect(viral.detectNiche("weather-explained").name).toBe("Weather Explained");

    const again = await local(request(app).post("/api/v1/agent/niches").send({ name: "Weather Explained" }));
    expect(again.status).toBe(400);
    expect(again.body.error.message).toMatch(/already a niche/i);
  });

  it("adds a subject the trend scan suggested, with one press", async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, "trends.json"),
      JSON.stringify({
        researchedAt: Date.now(),
        via: "youtube",
        sources: ["YouTube search"],
        findings: ["Fastest climber: something — 2.1M views in 9 hours.", "Hook shape landing now: question titles.", "Typical length of this week's top Shorts: 42 seconds."],
        top: [
          { id: "aaaaaaaaaaa", title: "ocean trench mystery", url: "https://www.youtube.com/shorts/aaaaaaaaaaa", views: 3_000_000, channel: "A", query: "shorts" },
          { id: "bbbbbbbbbbb", title: "ocean trench explained", url: "https://www.youtube.com/shorts/bbbbbbbbbbb", views: 2_000_000, channel: "B", query: "shorts" },
          { id: "ccccccccccc", title: "ocean trench footage", url: "https://www.youtube.com/shorts/ccccccccccc", views: 1_000_000, channel: "C", query: "shorts" },
        ],
      }),
      "utf8",
    );

    const listed = await local(request(app).get("/api/v1/agent/niches"));
    const suggestion = listed.body.suggestions[0];
    expect(suggestion).toBeTruthy();
    expect(suggestion.name.toLowerCase()).toContain("ocean trench");

    const added = await local(request(app).post("/api/v1/agent/niches").send({ suggestion: suggestion.name }));
    expect(added.status).toBe(201);
    expect(added.body.niche.name).toBe(suggestion.name);
    // The suggestion is gone from the answer now that it is in the picker.
    expect(added.body.suggestions.map((s: { name: string }) => s.name)).not.toContain(suggestion.name);

    const missing = await local(request(app).post("/api/v1/agent/niches").send({ suggestion: "not a suggestion" }));
    expect(missing.status).toBe(404);
  });

  it("removes an added niche but never a researched one", async () => {
    await local(request(app).post("/api/v1/agent/niches").send({ name: "Deep Sea Sounds" }));
    const removed = await local(request(app).delete("/api/v1/agent/niches/deep-sea-sounds"));
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toMatchObject({ id: "deep-sea-sounds" });
    expect(removed.body.added).toEqual([]);

    const researched = await local(request(app).delete("/api/v1/agent/niches/psychology"));
    expect(researched.status).toBe(400);
    expect(researched.body.error.message).toMatch(/researched set/i);
    const unknown = await local(request(app).delete("/api/v1/agent/niches/nope"));
    expect(unknown.status).toBe(404);
  });

  it("never lets the console noise from a bad spec sheet crash a request", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const oversized = await local(request(app).post("/api/v1/agent/niches").send({ name: "x".repeat(300) }));
    expect(oversized.status).toBe(400);
    spy.mockRestore();
  });
});
