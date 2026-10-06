// ── The app must not rate-limit itself ──────────────────────────────────────
// The desktop window polls the PC's stats, the jobs and the conversation, and a
// hosted server's 120 requests a minute is small enough that a normal flow can
// trip it: the packaged end-to-end run got "Too many requests. Please slow
// down." when it saved a memory note. The desktop build therefore has its own,
// much higher ceiling — asserted here by really making the requests.

// Before anything imports the config (it reads DESKTOP_APP once, at load).
process.env.DESKTOP_APP = "1";

import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

const { generalLimitPerMinute } = await import("../src/lib/security.js");
const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const store = new JsonStore();
  await store.init();
  setStoreForTests(store);
  app = createApp();
});

describe("the general rate limit", () => {
  it("keeps the tight ceiling for a hosted server and lifts it for the desktop app", () => {
    expect(generalLimitPerMinute(false)).toBe(120);
    expect(generalLimitPerMinute(true)).toBe(2000);
  });

  it("lets the desktop window work — 150 calls in a row, none refused", async () => {
    const statuses = new Set<number>();
    for (let i = 0; i < 150; i++) {
      const res = await request(app).get("/api/v1/voices");
      statuses.add(res.status);
    }
    expect([...statuses]).toEqual([200]);
  });
});
