// ── The things a person can see when something goes wrong ───────────────────
// Three pieces of the request path that were quietly broken and are easy to
// break again:
//
//   1. every response carries a request id, and the error body repeats it —
//      `requestIdMiddleware` existed but was never mounted, so the id a person
//      could read off the app was always `undefined`;
//   2. `/api/ready` answers 503 when the store could not be read and there was
//      no usable backup, but stays 200 for a first run (no file yet is not a
//      fault);
//   3. a forged `X-Forwarded-For` cannot hand a caller a fresh rate-limit
//      bucket, because with no proxy configured the socket's own address is
//      what counts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

const { createApp } = await import("../src/app.js");
const { JsonStore, setStoreForTests } = await import("../src/lib/store.js");
const { setConfig } = await import("./helpers/config.js");

let dir: string;
let undoDataDir: (() => void) | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-http-"));
  undoDataDir = setConfig("dataDir", dir);
});

afterEach(async () => {
  undoDataDir?.();
  undoDataDir = null;
  fs.rmSync(dir, { recursive: true, force: true });
  // Leave the shared singleton on a healthy store for the next test file.
  const clean = new JsonStore();
  await clean.init();
  setStoreForTests(clean);
});

// The dynamic import above yields the class as a value; this is its instance type.
type Store = InstanceType<typeof JsonStore>;

async function appWith(store: Store) {
  setStoreForTests(store);
  return createApp();
}

describe("request ids", () => {
  it("puts an id on every response and in the error body", async () => {
    const store = new JsonStore();
    await store.init();
    const app = await appWith(store);

    const ok = await request(app).get("/api/health");
    expect(ok.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const missing = await request(app).get("/api/v1/definitely-not-a-route");
    expect(missing.status).toBe(404);
    expect(missing.body.error.requestId).toBe(missing.headers["x-request-id"]);
    expect(missing.body.error.requestId).toBeTruthy();
  });

  it("echoes a caller's own id (so a retry can be correlated) but not a dangerous one", async () => {
    const store = new JsonStore();
    await store.init();
    const app = await appWith(store);

    const mine = await request(app).get("/api/health").set("X-Request-Id", "phone-attempt-42");
    expect(mine.headers["x-request-id"]).toBe("phone-attempt-42");

    // Anything that is not a plain id is replaced rather than reflected.
    const hostile = await request(app).get("/api/health").set("X-Request-Id", "<script>alert(1)</script>");
    expect(hostile.headers["x-request-id"]).not.toContain("<script>");
    expect(hostile.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("the readiness probe", () => {
  it("is ready on a first run — no store file yet is not a fault", async () => {
    const store = new JsonStore();
    await store.init();
    const app = await appWith(store);
    const res = await request(app).get("/api/ready");
    expect(res.status).toBe(200);
    expect(res.body.store).toBe("json");
    expect(res.body.storeRecovery.status).toBe("fresh");
  });

  it("is NOT ready when the store could not be read and nothing could rescue it", async () => {
    // A broken file and no backup: the app runs, but something is genuinely
    // wrong — this is the deploy that must not be handed traffic.
    fs.writeFileSync(path.join(dir, "store.json"), "]] not json [[");
    const store = new JsonStore();
    await store.init();
    expect(store.describe().status).toBe("lost");

    const app = await appWith(store);
    const res = await request(app).get("/api/ready");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.storeRecovery.status).toBe("lost");
    // The unreadable file is named, so it can be recovered by hand.
    expect(res.body.quarantine).toContain(".corrupt-");
    expect(fs.existsSync(res.body.quarantine)).toBe(true);
  });

  it("says which store is live, so a degraded deploy is visible", async () => {
    const store = new JsonStore();
    await store.init();
    const app = await appWith(store);
    const health = await request(app).get("/api/health");
    const ready = await request(app).get("/api/ready");
    // /api/health answers "is this process alive"; /api/ready answers "can it
    // serve". They are different questions and both are needed.
    expect(health.body).not.toHaveProperty("store");
    expect(ready.body).toHaveProperty("ffmpeg");
  });
});

describe("what the rate limiter counts", () => {
  /** The draft-7 header express-rate-limit sets: "limit=120, remaining=119, reset=60". */
  function remaining(res: { headers: Record<string, string> }): number {
    const m = /remaining=(\d+)/.exec(res.headers["ratelimit"] ?? "");
    if (!m) throw new Error(`no RateLimit header on the response: ${JSON.stringify(res.headers["ratelimit"])}`);
    return Number(m[1]);
  }

  it("ignores a forged X-Forwarded-For when no proxy is configured", async () => {
    // The default: TRUST_PROXY unset, so Express reports the socket's own
    // address (app.ts). Rotating the header must NOT buy a fresh bucket — this
    // is what made every limit in lib/security.ts, including the sign-in
    // throttle, decorative before.
    const store = new JsonStore();
    await store.init();
    const app = await appWith(store);

    const a = await request(app).get("/api/v1/voices").set("X-Forwarded-For", "203.0.113.7");
    const b = await request(app).get("/api/v1/voices").set("X-Forwarded-For", "198.51.100.9");
    const c = await request(app).get("/api/v1/voices").set("X-Forwarded-For", "203.0.113.7");
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);

    // One bucket, counted once per request: 119 → 118 → 117.
    expect(remaining(b)).toBe(remaining(a) - 1);
    expect(remaining(c)).toBe(remaining(a) - 2);
  });

  it("does honour it when the deployment says a proxy is really there", async () => {
    // …because that is what "trust proxy" means, and the docker-compose
    // deployment sets TRUST_PROXY=1 (Caddy is in front, so the header is the
    // only place the real client address exists). Two forged addresses then
    // legitimately get their own buckets — which is why the value must be set
    // deliberately and never defaulted to "trust everything".
    const store = new JsonStore();
    await store.init();
    const undo = setConfig("trustProxy", 1);
    try {
      const app = await appWith(store);
      const a = await request(app).get("/api/v1/voices").set("X-Forwarded-For", "203.0.113.7");
      const b = await request(app).get("/api/v1/voices").set("X-Forwarded-For", "198.51.100.9");
      expect(remaining(b)).toBe(remaining(a));
    } finally {
      undo();
    }
  });
});
