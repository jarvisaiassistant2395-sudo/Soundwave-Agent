// Billing: the plans people pay for. Stripe is a stand-in on loopback, so the
// whole path is real here — creating the customer, opening Checkout, the
// signed webhook, reconciliation when no webhook can reach a home PC, and the
// plan the account ends up with.
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeStripe, useFakeStripe, FAKE_PRICES, stripeShape, type FakeStripe } from "./helpers/fakeStripe.js";
import { setConfig } from "./helpers/config.js";

vi.hoisted(() => {
  process.env.DESKTOP_APP = "1";
  process.env.DATA_DIR = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";
});

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";

let app: ReturnType<typeof import("../src/app.js").createApp>;
let fake: FakeStripe;
let config: typeof import("../src/config.js").config;
let store: typeof import("../src/lib/store.js");

const local = (req: request.Test) => req.set("Host", "127.0.0.1:4000");

/** A signed-in account, with the cookies and CSRF header its requests need. */
async function account(email = "payer@example.com") {
  const user = await store.getStore().then((s) => s.createUser({ email, name: "Paying Person" }));
  const bundle = await (await import("../src/lib/auth.js")).createUserSession(await store.getStore(), user.id, "127.0.0.1", "vitest");
  const { signAccessToken } = await import("../src/lib/auth.js");
  const cookies = `access_token=${signAccessToken(user.id)}; refresh_token=${encodeURIComponent(bundle.refreshToken)}; csrf_token=test-csrf`;
  return { user, cookies, csrf: "test-csrf" };
}

const auth = (cookies: string) => ({ cookie: cookies, csrf: "test-csrf" });

beforeAll(async () => {
  fake = await startFakeStripe();
  config = (await import("../src/config.js")).config;
  store = await import("../src/lib/store.js");
  useFakeStripe(config, fake);
  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await fake.close();
});

const { resetBillingEventsForTests } = await import("../src/lib/billingEvents.js");
const { signWebhookPayload } = await import("../src/lib/stripe.js");

beforeEach(async () => {
  fake.seen.length = 0;
  fake.customers.length = 0;
  fake.subscriptions = {};
  fake.invoices = {};
  fake.created.length = 0;
  fake.failNext = null;
  useFakeStripe(config, fake);
  resetBillingEventsForTests();
  for (const name of ["store.json", "gemini-chats.json", "notebooks.json"]) {
    fs.rmSync(path.join(DATA_DIR, name), { force: true });
  }
  const fresh = new store.JsonStore();
  await fresh.init();
  store.setStoreForTests(fresh);
});

describe("what the plans are", () => {
  it("lists them and says whether billing works here", async () => {
    const res = await local(request(app).get("/api/v1/billing/plans"));
    expect(res.status).toBe(200);
    expect(res.body.plans.map((p: { id: string }) => p.id)).toEqual(["FREE", "PRO", "ENTERPRISE"]);
    expect(res.body.billing).toEqual({ configured: true, personal: false, missingPrices: [] });
  });

  it("says so plainly when this deployment has no Stripe keys", async () => {
    const restore = setConfig("stripeSecretKey", "");
    try {
      const res = await local(request(app).get("/api/v1/billing/plans"));
      expect(res.body.billing.configured).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("upgrading", () => {
  it("needs a signed-in account", async () => {
    // Reading needs the session; asking to pay without one is refused earlier
    // still, by the CSRF check every cookie-authenticated write goes through.
    expect((await local(request(app).get("/api/v1/billing/status"))).status).toBe(401);
    const post = await local(request(app).post("/api/v1/billing/create-checkout").send({ plan: "PRO" }));
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe("CSRF_FAILED");
  });

  it("needs the CSRF token a cookie-authenticated request must carry", async () => {
    const { cookies } = await account();
    const res = await local(request(app).post("/api/v1/billing/create-checkout").set("Cookie", cookies).send({ plan: "PRO" }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_FAILED");
  });

  it("creates the Stripe customer, then a checkout page for the right price", async () => {
    const { user, cookies } = await account();
    const res = await local(
      request(app).post("/api/v1/billing/create-checkout").set("Cookie", cookies).set("X-CSRF-Token", auth(cookies).csrf).send({ plan: "PRO", billing: "monthly" }),
    );
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/checkout\/cs_/);

    // The customer exists on Stripe and on the account, before any payment.
    expect(fake.customers).toHaveLength(1);
    expect(fake.customers[0]!.email).toBe("payer@example.com");
    const stored = await store.getStore().then((s) => s.findUserById(user.id));
    expect(stored!.stripeCustomerId).toBe(fake.customers[0]!.id);

    // …and the session is for that customer, that price, and that account.
    const session = fake.created.find((c) => c.kind === "checkout")!.params;
    expect(session.mode).toBe("subscription");
    expect(session["line_items[0][price]"]).toBe(FAKE_PRICES.proMonthly);
    expect(session["line_items[0][quantity]"]).toBe("1");
    expect(session.customer).toBe(fake.customers[0]!.id);
    expect(session.client_reference_id).toBe(user.id);
    expect(session["metadata[userId]"]).toBe(user.id);
    expect(session["subscription_data[metadata][userId]"]).toBe(user.id);
    expect(session.success_url).toBe("http://127.0.0.1:4000/settings/billing?billing=success");
    expect(session.cancel_url).toBe("http://127.0.0.1:4000/settings/billing?billing=cancelled");
  });

  it("sends the browser back to the app's own origin, not the API's", async () => {
    // A dev proxy rewrites Host to the API port and sends its own Origin; the
    // person must land on a page the app actually serves, cookies included.
    const { cookies } = await account();
    await local(
      request(app)
        .post("/api/v1/billing/create-checkout")
        .set("Cookie", cookies)
        .set("X-CSRF-Token", auth(cookies).csrf)
        .set("Origin", "http://localhost:5173")
        .send({ plan: "PRO" }),
    );
    const session = fake.created.find((c) => c.kind === "checkout")!.params;
    expect(session.success_url).toBe("http://localhost:5173/settings/billing?billing=success");
    expect(session.cancel_url).toBe("http://localhost:5173/settings/billing?billing=cancelled");
  });

  it("sells the annual and the higher plan when asked", async () => {
    const { cookies } = await account();
    const headers = { Cookie: cookies, "X-CSRF-Token": auth(cookies).csrf };
    await local(request(app).post("/api/v1/billing/create-checkout").set(headers).send({ plan: "PRO", billing: "annual" }));
    await local(request(app).post("/api/v1/billing/create-checkout").set(headers).send({ plan: "ENTERPRISE", billing: "monthly" }));
    const prices = fake.created.filter((c) => c.kind === "checkout").map((c) => c.params["line_items[0][price]"]);
    expect(prices).toEqual([FAKE_PRICES.proAnnual, FAKE_PRICES.enterpriseMonthly]);
  });

  it("explains a plan this deployment has no price for", async () => {
    const { cookies } = await account();
    const restore = setConfig("stripePriceEnterpriseAnnual", "");
    try {
      const res = await local(
        request(app).post("/api/v1/billing/create-checkout").set("Cookie", cookies).set("X-CSRF-Token", "test-csrf").send({ plan: "ENTERPRISE", billing: "annual" }),
      );
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("PRICE_NOT_CONFIGURED");
      expect(res.body.error.message).toContain("STRIPE_PRICE_ENTERPRISE_ANNUAL");
    } finally {
      restore();
    }
  });

  it("passes Stripe's own refusal through instead of pretending", async () => {
    const { cookies } = await account();
    fake.failNext = { status: 402, body: { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } } };
    const res = await local(
      request(app).post("/api/v1/billing/create-checkout").set("Cookie", cookies).set("X-CSRF-Token", "test-csrf").send({ plan: "PRO" }),
    );
    expect(res.status).toBe(402);
    expect(res.body.error.message).toBe("Your card was declined.");
  });

  it("will not grant a plan for free once Stripe is set up", async () => {
    const { cookies } = await account();
    const res = await local(request(app).post("/api/v1/billing/apply-plan").set("Cookie", cookies).set("X-CSRF-Token", "test-csrf").send({ plan: "ENTERPRISE" }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BILLING_CONFIGURED");
  });

  it("still lets a development build switch plans locally", async () => {
    const { user, cookies } = await account();
    const restore = setConfig("stripeSecretKey", "");
    try {
      const res = await local(request(app).post("/api/v1/billing/apply-plan").set("Cookie", cookies).set("X-CSRF-Token", "test-csrf").send({ plan: "PRO" }));
      expect(res.status).toBe(200);
      expect(res.body.user.plan).toBe("PRO");
      const stored = await store.getStore().then((s) => s.findUserById(user.id));
      expect(stored!.plan).toBe("PRO");
    } finally {
      restore();
    }
  });
});

describe("managing the subscription", () => {
  it("opens the billing portal once there is something to manage", async () => {
    const { user, cookies } = await account();
    const s = await store.getStore();
    const bare = await local(request(app).post("/api/v1/billing/create-portal").set("Cookie", cookies).set("X-CSRF-Token", "test-csrf"));
    expect(bare.status).toBe(409);
    expect(bare.body.error.code).toBe("NO_CUSTOMER");

    await s.updateUser(user.id, { stripeCustomerId: "cus_existing" });
    const res = await local(request(app).post("/api/v1/billing/create-portal").set("Cookie", cookies).set("X-CSRF-Token", "test-csrf"));
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\/portal\/bps_/);
    const portal = fake.created.find((c) => c.kind === "portal")!.params;
    expect(portal.customer).toBe("cus_existing");
    expect(portal.return_url).toBe("http://127.0.0.1:4000/settings/billing");
  });

  it("reports what Stripe says about this account", async () => {
    const { user, cookies } = await account();
    const s = await store.getStore();
    const renews = Math.floor(Date.now() / 1000) + 20 * 24 * 3600;
    fake.subscriptions["cus_live"] = [{ id: "sub_live", status: "active", customer: "cus_live", priceId: FAKE_PRICES.proMonthly, currentPeriodEnd: renews }];
    await s.updateUser(user.id, { stripeCustomerId: "cus_live", plan: "FREE" });

    const res = await local(request(app).get("/api/v1/billing/status").set("Cookie", cookies));
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("PRO");
    expect(res.body.subscription).toMatchObject({ status: "active", interval: "monthly", cancelAtPeriodEnd: false, needsAttention: false });
    expect(new Date(res.body.subscription.currentPeriodEnd).getTime()).toBe(renews * 1000);
  });

  it("keeps the plan while Stripe retries a failed card, and says so", async () => {
    const { user, cookies } = await account();
    const s = await store.getStore();
    fake.subscriptions["cus_past_due"] = [{ id: "sub_pd", status: "past_due", customer: "cus_past_due", priceId: FAKE_PRICES.proMonthly }];
    await s.updateUser(user.id, { stripeCustomerId: "cus_past_due" });

    const res = await local(request(app).get("/api/v1/billing/status").set("Cookie", cookies));
    expect(res.body.plan).toBe("PRO");
    expect(res.body.subscription.needsAttention).toBe(true);
  });

  it("lets the plan go when the subscription ends", async () => {
    const { user, cookies } = await account();
    const s = await store.getStore();
    fake.subscriptions["cus_ended"] = [{ id: "sub_ended", status: "canceled", customer: "cus_ended", priceId: FAKE_PRICES.proAnnual }];
    await s.updateUser(user.id, { stripeCustomerId: "cus_ended", plan: "PRO" });

    const res = await local(request(app).get("/api/v1/billing/status").set("Cookie", cookies));
    expect(res.body.plan).toBe("FREE");
  });

  it("says nothing is wrong when Stripe can't be reached", async () => {
    const { user, cookies } = await account();
    await store.getStore().then((s) => s.updateUser(user.id, { stripeCustomerId: "cus_live", plan: "PRO" }));
    fake.failNext = { status: 500, body: { error: { type: "api_error", message: "Stripe is having a moment." } } };
    const res = await local(request(app).get("/api/v1/billing/status").set("Cookie", cookies));
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("PRO"); // what the app already knew
    expect(res.body.problem).toContain("moment");
  });
});

describe("coming back from Checkout", () => {
  it("picks up the subscription even when no webhook can reach this PC", async () => {
    const { user, cookies } = await account();
    const s = await store.getStore();
    // The person paid in their browser; Stripe has an active subscription, but
    // nothing called our webhook (a home PC has no public address).
    fake.subscriptions["cus_home"] = [{ id: "sub_home", status: "active", customer: "cus_home", priceId: FAKE_PRICES.enterpriseMonthly, metadata: { userId: user.id } }];
    await s.updateUser(user.id, { stripeCustomerId: "cus_home", plan: "FREE" });

    const res = await local(request(app).post("/api/v1/billing/reconcile").set("Cookie", cookies).set("X-CSRF-Token", "test-csrf"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: "ENTERPRISE", changed: true });
    const stored = await store.getStore().then((x) => x.findUserById(user.id));
    expect(stored!.plan).toBe("ENTERPRISE");
    expect(stored!.stripeSubscriptionId).toBe("sub_home");

    // Asking again is not a change.
    const again = await local(request(app).post("/api/v1/billing/reconcile").set("Cookie", cookies).set("X-CSRF-Token", "test-csrf"));
    expect(again.body.changed).toBe(false);
  });

  it("does nothing for an account that has never paid", async () => {
    const { cookies } = await account();
    const res = await local(request(app).post("/api/v1/billing/reconcile").set("Cookie", cookies).set("X-CSRF-Token", "test-csrf"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: "FREE", changed: false, subscription: null });
  });
});

describe("what Stripe tells us", () => {
  async function deliver(event: Record<string, unknown>, opts: { secret?: string; timestamp?: number } = {}) {
    const raw = JSON.stringify(event);
    const header = signWebhookPayload(raw, opts.secret ?? config.stripeWebhookSecret, opts.timestamp);
    return local(request(app).post("/api/v1/billing/webhook").set("Content-Type", "application/json").set("Stripe-Signature", header).send(raw));
  }

  it("refuses anything that isn't signed by Stripe", async () => {
    const { user } = await account();
    const s = await store.getStore();
    await s.updateUser(user.id, { plan: "PRO", stripeCustomerId: "cus_x" });
    const event = { id: "evt_unsigned", type: "customer.subscription.deleted", data: { object: stripeShape({ id: "sub_x", status: "canceled", customer: "cus_x", priceId: FAKE_PRICES.proMonthly }) } };

    // No header at all.
    const none = await local(request(app).post("/api/v1/billing/webhook").set("Content-Type", "application/json").send(JSON.stringify(event)));
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("NO_SIGNATURE");

    // Signed with someone else's secret.
    const wrong = await deliver(event, { secret: "whsec_someone_else" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("SIGNATURE_MISMATCH");

    // A real signature, but from an hour ago (a captured request replayed).
    const old = await deliver(event, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(old.status).toBe(400);
    expect(old.body.error.code).toBe("SIGNATURE_TOO_OLD");

    // …and through all of that the plan never moved.
    const stored = await store.getStore().then((x) => x.findUserById(user.id));
    expect(stored!.plan).toBe("PRO");
  });

  it("records the customer from a finished checkout and applies the plan", async () => {
    const { user } = await account();
    fake.subscriptions["cus_new"] = [{ id: "sub_new", status: "active", customer: "cus_new", priceId: FAKE_PRICES.proMonthly }];
    const res = await deliver({
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", object: "checkout.session", customer: "cus_new", subscription: "sub_new", client_reference_id: user.id, metadata: { userId: user.id } } },
    });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    const stored = await store.getStore().then((x) => x.findUserById(user.id));
    expect(stored!.stripeCustomerId).toBe("cus_new");
    expect(stored!.stripeSubscriptionId).toBe("sub_new");
    expect(stored!.plan).toBe("PRO");
  });

  it("ignores a redelivery of the same event", async () => {
    const { user } = await account();
    fake.subscriptions["cus_inv"] = [{ id: "sub_inv", status: "active", customer: "cus_inv", priceId: FAKE_PRICES.proMonthly }];
    await store.getStore().then((s) => s.updateUser(user.id, { stripeCustomerId: "cus_inv" }));
    const invoice = { id: "in_1", customer: "cus_inv", amount_paid: 1200, currency: "usd", status: "paid", invoice_pdf: "https://stripe.test/in_1.pdf" };

    const first = await deliver({ id: "evt_invoice", type: "invoice.paid", data: { object: invoice } });
    expect(first.status).toBe(200);
    const again = await deliver({ id: "evt_invoice", type: "invoice.paid", data: { object: invoice } });
    expect(again.body.duplicate).toBe(true);

    const invoices = await store.getStore().then((s) => s.listInvoices(user.id));
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ stripeInvoiceId: "in_1", amount: 1200, status: "paid", pdfUrl: "https://stripe.test/in_1.pdf" });
  });

  it("moves the plan when a subscription is upgraded, and back when it ends", async () => {
    const { user } = await account();
    await store.getStore().then((s) => s.updateUser(user.id, { stripeCustomerId: "cus_up", plan: "PRO" }));

    const upgraded = await deliver({
      id: "evt_up",
      type: "customer.subscription.updated",
      data: { object: stripeShape({ id: "sub_up", status: "active", customer: "cus_up", priceId: FAKE_PRICES.enterpriseAnnual, interval: "year" }) },
    });
    expect(upgraded.status).toBe(200);
    let stored = await store.getStore().then((x) => x.findUserById(user.id));
    expect(stored!.plan).toBe("ENTERPRISE");
    expect(stored!.stripeSubscriptionId).toBe("sub_up");

    const ended = await deliver({
      id: "evt_del",
      type: "customer.subscription.deleted",
      data: { object: stripeShape({ id: "sub_up", status: "canceled", customer: "cus_up", priceId: FAKE_PRICES.enterpriseAnnual }) },
    });
    expect(ended.status).toBe(200);
    stored = await store.getStore().then((x) => x.findUserById(user.id));
    expect(stored!.plan).toBe("FREE");
    expect(stored!.stripeSubscriptionId).toBeNull();
  });

  it("finds the account from the subscription's own metadata when it must", async () => {
    const { user } = await account();
    fake.subscriptions["cus_meta"] = [{ id: "sub_meta", status: "active", customer: "cus_meta", priceId: FAKE_PRICES.proAnnual, metadata: { userId: user.id } }];
    const res = await deliver({
      id: "evt_meta",
      type: "customer.subscription.created",
      data: { object: stripeShape({ id: "sub_meta", status: "active", customer: "cus_meta", priceId: FAKE_PRICES.proAnnual, metadata: { userId: user.id } }) },
    });
    expect(res.status).toBe(200);
    const stored = await store.getStore().then((x) => x.findUserById(user.id));
    expect(stored!.plan).toBe("PRO");
    expect(stored!.stripeCustomerId).toBe("cus_meta");
  });

  it("ignores an event about nobody it knows", async () => {
    const res = await deliver({ id: "evt_stranger", type: "customer.subscription.deleted", data: { object: stripeShape({ id: "sub_n", status: "canceled", customer: "cus_stranger", priceId: FAKE_PRICES.proMonthly }) } });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});

describe("receipts", () => {
  it("shows Stripe's invoices when it can, the local record otherwise", async () => {
    const { user, cookies } = await account();
    const s = await store.getStore();
    fake.invoices["cus_bill"] = [{ id: "in_42", amount_paid: 960, currency: "usd", status: "paid", invoice_pdf: "https://stripe.test/in_42.pdf", hosted_invoice_url: "https://stripe.test/i/in_42", created: 1_760_000_000 }];
    await s.updateUser(user.id, { stripeCustomerId: "cus_bill" });

    const live = await local(request(app).get("/api/v1/billing/invoices").set("Cookie", cookies));
    expect(live.body.source).toBe("stripe");
    expect(live.body.invoices[0]).toMatchObject({ id: "in_42", amount: 960, status: "paid", pdfUrl: "https://stripe.test/in_42.pdf", hostedUrl: "https://stripe.test/i/in_42" });

    // Without Stripe (or with no customer), the stored invoices answer.
    await s.createInvoice({ userId: user.id, stripeInvoiceId: "in_local", amount: 1200, currency: "usd", status: "paid", pdfUrl: null });
    fake.failNext = { status: 500, body: { error: { type: "api_error", message: "down" } } };
    const fallback = await local(request(app).get("/api/v1/billing/invoices").set("Cookie", cookies));
    expect(fallback.body.source).toBe("local");
    expect(fallback.body.invoices.map((i: { id: string; stripeInvoiceId?: string }) => i.stripeInvoiceId)).toEqual(["in_local"]);
  });
});

// ── The Founder lifetime ─────────────────────────────────────────────────────
// One payment, everything Enterprise gives, no renewal — the offer only a
// local-first app can make, because a user's marginal cost is their own key and
// their own CPU. What matters here is that it is bought (never switched on),
// that it is honoured without a subscription, and that "first 100" is true.
describe("the Founder lifetime", () => {
  const price = () => setConfig("stripePriceLifetime", FAKE_PRICES.lifetime);

  it("is offered with the seats that are actually left", async () => {
    const restore = price();
    try {
      const res = await local(request(app).get("/api/v1/billing/plans"));
      expect(res.status).toBe(200);
      expect(res.body.lifetime).toMatchObject({ available: true, priceUsd: 199, seats: 100, sold: 0, priceConfigured: true });
      // Monthly and annual prices are still the only plans on the page.
      expect(res.body.plans.map((p: { id: string }) => p.id)).toEqual(["FREE", "PRO", "ENTERPRISE"]);
    } finally {
      restore();
    }
  });

  it("is not offered when this deployment has no lifetime price", async () => {
    const restore = setConfig("stripePriceLifetime", "");
    try {
      const res = await local(request(app).get("/api/v1/billing/plans"));
      expect(res.body.lifetime).toMatchObject({ available: false, reason: "no_price" });
    } finally {
      restore();
    }
  });

  it("opens a one-payment Checkout, not a subscription", async () => {
    const restore = price();
    try {
      const { cookies } = await account("founder@example.com");
      const res = await local(
        request(app).post("/api/v1/billing/create-checkout").set("Cookie", cookies).set("X-CSRF-Token", auth(cookies).csrf).send({ plan: "LIFETIME" }),
      );
      expect(res.status).toBe(200);
      const created = fake.created.find((c) => c.kind === "checkout")!;
      expect(created.params["mode"]).toBe("payment");
      expect(created.params["line_items[0][price]"]).toBe(FAKE_PRICES.lifetime);
      expect(created.params["metadata[kind]"]).toBe("lifetime");
      // No subscription is created by a one-time payment.
      expect(created.params["subscription_data[metadata][userId]"]).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("gives Enterprise for good when the payment lands, with no subscription", async () => {
    const restore = price();
    try {
      const { user } = await account("buyer@example.com");
      const event = {
        id: "evt_lifetime_1",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_lifetime",
            mode: "payment",
            created: 1_760_000_000,
            client_reference_id: user.id,
            customer: "cus_founder",
            metadata: { userId: user.id, kind: "lifetime" },
          },
        },
      };
      const res = await local(
        request(app)
          .post("/api/v1/billing/webhook")
          .set("Content-Type", "application/json")
          .set("Stripe-Signature", signWebhookPayload(JSON.stringify(event), config.stripeWebhookSecret))
          .send(JSON.stringify(event)),
      );
      expect(res.status).toBe(200);

      const stored = await (await store.getStore()).findUserById(user.id);
      expect(stored!.plan).toBe("ENTERPRISE");
      expect(stored!.lifetimeSince).toBeTruthy();
      // Still no subscription id: there is nothing to renew, ever.
      expect(stored!.stripeSubscriptionId ?? null).toBeNull();
    } finally {
      restore();
    }
  });

  it("stops offering seats once they are gone, and refuses the checkout", async () => {
    const restore = setConfig("stripePriceLifetime", FAKE_PRICES.lifetime);
    const restoreSeats = setConfig("founderSeats", 1);
    try {
      const s = await store.getStore();
      const holder = await s.createUser({ email: "first@example.com", name: "First" });
      await s.updateUser(holder.id, { lifetimeSince: new Date().toISOString(), plan: "ENTERPRISE" });

      const plans = await local(request(app).get("/api/v1/billing/plans"));
      expect(plans.body.lifetime).toMatchObject({ available: false, sold: 1, seats: 1, reason: "sold_out" });

      const { cookies } = await account("late@example.com");
      const res = await local(
        request(app).post("/api/v1/billing/create-checkout").set("Cookie", cookies).set("X-CSRF-Token", auth(cookies).csrf).send({ plan: "LIFETIME" }),
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("LIFETIME_SOLD_OUT");
    } finally {
      restoreSeats();
      restore();
    }
  });

  it("says on the Billing tab that this account bought one", async () => {
    const { user, cookies } = await account("founder2@example.com");
    const s = await store.getStore();
    await s.updateUser(user.id, { plan: "ENTERPRISE", lifetimeSince: "2026-10-06T09:00:00.000Z" });

    const res = await local(request(app).get("/api/v1/billing/status").set("Cookie", cookies));
    expect(res.body.plan).toBe("ENTERPRISE");
    expect(res.body.lifetime).toBe(true);
  });

  it("tells the browser when an account keeps its old price", async () => {
    const { user, cookies } = await account("old@example.com");
    // A subscription from before the repricing: no start date was recorded then.
    await (await store.getStore()).updateUser(user.id, { plan: "PRO", stripeSubscriptionId: "sub_old" });

    const held = await local(request(app).get("/api/v1/billing/status").set("Cookie", cookies));
    expect(held.body.grandfathered).toBe(true);

    // A subscription bought today is dated, and pays today's price.
    await (await store.getStore()).updateUser(user.id, { subscriptionStartedAt: new Date().toISOString() });
    const fresh = await local(request(app).get("/api/v1/billing/status").set("Cookie", cookies));
    expect(fresh.body.grandfathered).toBe(false);
  });

  it("can't be switched on through the development route", async () => {
    const { cookies } = await account("devroute@example.com");
    const res = await local(
      request(app).post("/api/v1/billing/apply-plan").set("Cookie", cookies).set("X-CSRF-Token", auth(cookies).csrf).send({ plan: "LIFETIME" }),
    );
    // Either "billing is configured here, pay for it" or "that isn't a plan" —
    // never a free lifetime.
    expect([400, 409]).toContain(res.status);
    expect(res.body.error.code).not.toBe("OK");
  });
});
