// The owner's own build ("Soundwave AI — Dev"): a build with no payment in it
// and nothing gated. What it must prove, in the words of the request:
//
//   1. no billing anywhere — Stripe is never asked, even if keys are present;
//   2. everything unlocked — the plan in force is Enterprise, so the gates,
//      the quotas and what the API reports all agree, whatever the stored
//      record says;
//   3. the stored record is not rewritten — the build overrides what is
//      allowed, it does not forge data.
//
// SOUNDWAVE_EDITION is read when config.ts loads, so it is set before any
// import of the app (vi.hoisted runs first).
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SOUNDWAVE_EDITION = "personal";
  process.env.DESKTOP_APP = "1";
  // Keys that would normally turn billing ON: the personal build must ignore
  // them, so "no payment" cannot depend on someone forgetting to set them.
  process.env.STRIPE_SECRET_KEY = "sk_test_personal_build";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_personal_build";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_personal_pro";
  process.env.DATA_DIR = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";
});

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";

let app: ReturnType<typeof import("../src/app.js").createApp>;
let config: typeof import("../src/config.js").config;
let store: typeof import("../src/lib/store.js");

const local = (req: request.Test) => req.set("Host", "127.0.0.1:4000");

/** A signed-in account whose stored plan is the free one. */
async function account(email = "owner@example.com") {
  const user = await store.getStore().then((s) => s.createUser({ email, name: "The Owner" }));
  const { createUserSession, signAccessToken } = await import("../src/lib/auth.js");
  const bundle = await createUserSession(await store.getStore(), user.id, "127.0.0.1", "vitest");
  const cookies = `access_token=${signAccessToken(user.id)}; refresh_token=${encodeURIComponent(bundle.refreshToken)}; csrf_token=test-csrf`;
  return { user, cookies };
}

const post = (cookies: string, url: string, body: object = {}) =>
  local(request(app).post(url).set("Cookie", cookies).set("X-CSRF-Token", "test-csrf").send(body));

beforeAll(async () => {
  config = (await import("../src/config.js")).config;
  store = await import("../src/lib/store.js");
  const { createApp } = await import("../src/app.js");
  app = createApp();
});

beforeEach(async () => {
  for (const name of ["store.json", "gemini-chats.json", "notebooks.json"]) {
    fs.rmSync(path.join(DATA_DIR, name), { force: true });
  }
  const fresh = new store.JsonStore();
  await fresh.init();
  store.setStoreForTests(fresh);
});

describe("the build knows what it is", () => {
  it("is the personal edition, with billing off", () => {
    expect(config.edition).toBe("personal");
    expect(config.personalEdition).toBe(true);
  });

  it("tells the UI there is nothing to pay for, keys or no keys", async () => {
    const res = await local(request(app).get("/api/v1/billing/plans"));
    expect(res.status).toBe(200);
    expect(res.body.billing).toEqual({ configured: false, personal: true, missingPrices: [] });
    // The plans themselves are still listed: the page shows what the build gives.
    expect(res.body.plans.map((p: { id: string }) => p.id)).toEqual(["FREE", "PRO", "ENTERPRISE"]);
  });
});

describe("no billing, at all", () => {
  it("reports the plan in force without ever asking Stripe", async () => {
    const { cookies } = await account();
    const res = await local(request(app).get("/api/v1/billing/status").set("Cookie", cookies));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: "ENTERPRISE", configured: false, personal: true, customer: false, subscription: null });
  });

  it("refuses every route that would take money or talk to Stripe", async () => {
    const { cookies } = await account();
    // If any of these reached Stripe the request would hang on the dead
    // STRIPE_API_BASE of the test environment instead of answering at once.
    const responses = await Promise.all([
      post(cookies, "/api/v1/billing/create-checkout", { plan: "PRO" }),
      post(cookies, "/api/v1/billing/create-portal"),
      post(cookies, "/api/v1/billing/reconcile"),
      post(cookies, "/api/v1/billing/apply-plan", { plan: "PRO" }),
      local(request(app).get("/api/v1/billing/invoices").set("Cookie", cookies)),
      local(request(app).post("/api/v1/billing/webhook").set("stripe-signature", "t=1,v1=deadbeef").send({ id: "evt_x", type: "invoice.paid" })),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NO_BILLING");
    }
  });
});

describe("everything unlocked", () => {
  it("lets a free-stored account through the Enterprise and Pro gates", async () => {
    const { cookies } = await account();
    const keys = await local(request(app).get("/api/v1/api-keys").set("Cookie", cookies));
    expect(keys.status).toBe(200); // was 403 PLAN_REQUIRED for a FREE account

    const saved = await post(cookies, "/api/v1/projects", {
      title: "Cloud project on my own PC",
      type: "TTS",
      textContent: "hello",
      voiceId: "en-US-AriaNeural",
    });
    expect(saved.status).toBe(201); // Pro gate + the cloudSave check, both open
  });

  it("gives the whole Enterprise quota", async () => {
    const { cookies } = await account();
    const quota = await local(request(app).get("/api/v1/tts/quota").set("Cookie", cookies));
    expect(quota.status).toBe(200);
    expect(quota.body.plan).toBe("ENTERPRISE");
    expect(quota.body.limit).toBe(2_000_000);

    const usage = await local(request(app).get("/api/v1/user/usage").set("Cookie", cookies));
    expect(usage.body.quota.limit).toBe(2_000_000);
    expect(usage.body.quota.plan).toBe("ENTERPRISE");
  });

  it("says Enterprise in the session, so the whole UI follows", async () => {
    const { cookies } = await account();
    const session = await local(request(app).get("/api/v1/auth/session").set("Cookie", cookies));
    expect(session.body.plan).toBe("ENTERPRISE");
  });

  it("leaves the stored record exactly as it was", async () => {
    const { user, cookies } = await account();
    await local(request(app).get("/api/v1/api-keys").set("Cookie", cookies));
    await post(cookies, "/api/v1/projects", { title: "x", type: "TTS", textContent: "", voiceId: "v" });
    const stored = await store.getStore().then((s) => s.findUserById(user.id));
    expect(stored!.plan).toBe("FREE");
    expect(stored!.stripeCustomerId ?? null).toBeNull();
  });
});
