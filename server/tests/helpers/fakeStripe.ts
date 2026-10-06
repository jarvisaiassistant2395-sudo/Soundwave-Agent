// A stand-in for Stripe's REST API on loopback, so the billing tests never
// touch the internet: customers, Checkout sessions, the Billing Portal,
// subscriptions and invoices, plus recorded requests and failure injection.
// lib/stripe.ts talks to `STRIPE_API_BASE`, so pointing config at this server
// exercises the real client code (form encoding, error handling, webhooks).
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface StripeSeen {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The form parameters, decoded (`metadata[userId]` → the key as sent). */
  form: Record<string, string>;
  headers: http.IncomingHttpHeaders;
}

export interface FakeStripeSubscription {
  id: string;
  status: string;
  customer: string;
  priceId: string;
  interval?: "month" | "year";
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  metadata?: Record<string, string>;
}

export interface FakeStripe {
  url: string;
  seen: StripeSeen[];
  /** Customers created through the API. */
  customers: Array<{ id: string; email?: string; name?: string; metadata?: Record<string, string> }>;
  /** What `GET /v1/subscriptions` answers, per customer id. */
  subscriptions: Record<string, FakeStripeSubscription[]>;
  invoices: Record<string, Array<Record<string, unknown>>>;
  /** Refuse the next request with this (cleared once used). */
  failNext: { status: number; body: unknown } | null;
  /** The last object this fake was asked to create (checkout / portal). */
  created: Array<{ kind: "checkout" | "portal"; params: Record<string, string> }>;
  close: () => Promise<void>;
}

export async function startFakeStripe(): Promise<FakeStripe> {
  let seq = 0;
  const fake: Partial<FakeStripe> = {
    seen: [],
    customers: [],
    subscriptions: {},
    invoices: {},
    failNext: null,
    created: [],
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(raw)) form[k] = v;
      const seen: StripeSeen = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, form, headers: req.headers };
      fake.seen!.push(seen);

      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (fake.failNext) {
        const failure = fake.failNext;
        fake.failNext = null;
        return send(failure.status, failure.body);
      }
      if (!String(req.headers.authorization ?? "").startsWith("Bearer sk_")) {
        return send(401, { error: { type: "authentication_error", message: "No API key provided." } });
      }

      const path = url.pathname;
      const nextId = (prefix: string) => `${prefix}_${++seq}${Date.now().toString(36).slice(-4)}`;

      if (req.method === "POST" && path === "/v1/customers") {
        const customer = { id: nextId("cus"), email: form.email, name: form.name, metadata: { userId: form["metadata[userId]"] ?? "" } };
        fake.customers!.push(customer);
        return send(200, { object: "customer", ...customer });
      }
      if (req.method === "POST" && path === "/v1/checkout/sessions") {
        fake.created!.push({ kind: "checkout", params: form });
        const id = nextId("cs");
        return send(200, { object: "checkout.session", id, url: `${fake.url}/checkout/${id}`, mode: form.mode, customer: form.customer });
      }
      if (req.method === "POST" && path === "/v1/billing_portal/sessions") {
        fake.created!.push({ kind: "portal", params: form });
        const id = nextId("bps");
        return send(200, { object: "billing_portal.session", id, url: `${fake.url}/portal/${id}` });
      }
      if (req.method === "GET" && path === "/v1/subscriptions") {
        const customer = url.searchParams.get("customer") ?? "";
        // Stripe answers with its own shape (items → price), which is what the
        // plan mapping reads — the fixtures above are the short form.
        return send(200, { object: "list", data: (fake.subscriptions![customer] ?? []).map(stripeShape) });
      }
      const subMatch = /^\/v1\/subscriptions\/(.+)$/.exec(path);
      if (req.method === "GET" && subMatch) {
        const wanted = decodeURIComponent(subMatch[1]!);
        const all = Object.values(fake.subscriptions!).flat();
        const found = all.find((s) => s.id === wanted);
        if (!found) return send(404, { error: { type: "invalid_request_error", code: "resource_missing", message: `No such subscription: ${wanted}` } });
        return send(200, { object: "subscription", ...stripeShape(found) });
      }
      if (req.method === "GET" && path === "/v1/invoices") {
        const customer = url.searchParams.get("customer") ?? "";
        return send(200, { object: "list", data: fake.invoices![customer] ?? [] });
      }
      return send(404, { error: { type: "invalid_request_error", message: `Unhandled ${req.method} ${path}` } });
    })();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake as FakeStripe;
}

/** A subscription as Stripe returns one (items/data/price nesting and all). */
export function stripeShape(sub: FakeStripeSubscription): Record<string, unknown> {
  return {
    id: sub.id,
    status: sub.status,
    customer: sub.customer,
    cancel_at_period_end: Boolean(sub.cancelAtPeriodEnd),
    current_period_end: sub.currentPeriodEnd ?? Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    metadata: sub.metadata ?? {},
    items: { object: "list", data: [{ id: `si_${sub.id}`, price: { id: sub.priceId, recurring: { interval: sub.interval ?? "month" } } }] },
  };
}

/** Point the server's config at the stand-in, with all four prices set. */
export function useFakeStripe(config: Record<string, unknown>, fake: FakeStripe): void {
  Object.assign(config, {
    stripeApiBase: fake.url,
    stripeSecretKey: "sk_test_soundwave",
    stripeWebhookSecret: "whsec_test_soundwave",
    stripePriceProMonthly: "price_pro_monthly",
    stripePriceProAnnual: "price_pro_annual",
    stripePriceEnterpriseMonthly: "price_ent_monthly",
    stripePriceEnterpriseAnnual: "price_ent_annual",
  });
}

/** The price ids the helper above sets (tests assert against these). */
export const FAKE_PRICES = {
  proMonthly: "price_pro_monthly",
  proAnnual: "price_pro_annual",
  enterpriseMonthly: "price_ent_monthly",
  enterpriseAnnual: "price_ent_annual",
} as const;
