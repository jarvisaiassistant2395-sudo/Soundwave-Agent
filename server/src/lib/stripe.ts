// ── Stripe: what turns a plan into something someone paid for ───────────────
// Soundwave sells PRO and ENTERPRISE through Stripe Checkout, and people manage
// or cancel through Stripe's Billing Portal. Both happen in the person's own
// browser, so card details never touch this app (the same reason the Google
// sign-in opens a browser). What the app keeps is the consequence: the plan on
// the account, the Stripe customer/subscription ids, and the invoices.
//
// This is the small part of Stripe's REST API the app needs, written the way
// the rest of Soundwave talks to Google and Gemini — plain `fetch` with
// form-encoded parameters, no SDK. That also makes it testable: `STRIPE_API_BASE`
// points the same code at a stand-in on loopback (tests/helpers/fakeStripe.ts).
//
// No `Stripe-Version` header is sent on purpose: the account's own default
// version applies, so this keeps working when Stripe releases a new one. The
// endpoints used here are the stable ones (checkout sessions, billing portal
// sessions, subscriptions, invoices, webhook events).

import crypto from "node:crypto";
import { config } from "../config.js";
import type { Plan } from "./plans.js";

export type BillingInterval = "monthly" | "annual";

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Is there a Stripe key on this deployment? Without one, Billing says so. */
export function stripeConfigured(): boolean {
  return Boolean(config.stripeSecretKey);
}

/** The prices set in the Stripe dashboard, per plan and interval. */
export function priceIdFor(plan: Plan, interval: BillingInterval): string | null {
  const prices: Record<string, string> = {
    "PRO:monthly": config.stripePriceProMonthly,
    "PRO:annual": config.stripePriceProAnnual,
    "ENTERPRISE:monthly": config.stripePriceEnterpriseMonthly,
    "ENTERPRISE:annual": config.stripePriceEnterpriseAnnual,
  };
  return prices[`${plan}:${interval}`] || null;
}

/** Which plan a price in a webhook belongs to (a price we don't sell = null). */
export function planForPriceId(priceId: string): { plan: Plan; interval: BillingInterval } | null {
  for (const plan of ["PRO", "ENTERPRISE"] as const) {
    for (const interval of ["monthly", "annual"] as const) {
      if (priceIdFor(plan, interval) === priceId) return { plan, interval };
    }
  }
  return null;
}

/** The plans whose price id is missing from this deployment's configuration. */
export function missingPrices(): string[] {
  const missing: string[] = [];
  for (const plan of ["PRO", "ENTERPRISE"] as const) {
    for (const interval of ["monthly", "annual"] as const) {
      if (!priceIdFor(plan, interval)) missing.push(`${plan.toLowerCase()}_${interval}`);
    }
  }
  return missing;
}

/** Stripe takes flat form parameters; objects and arrays are bracketed. */
export function formEncode(params: Record<string, unknown>, prefix = ""): URLSearchParams {
  const out = new URLSearchParams();
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item && typeof item === "object") add(`${key}[${i}]`, item);
        else if (item !== undefined && item !== null) out.append(`${key}[${i}]`, String(item));
      });
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${key}[${k}]`, v);
      return;
    }
    out.append(key, typeof value === "boolean" ? String(value) : String(value));
  };
  for (const [key, value] of Object.entries(params)) add(prefix ? `${prefix}[${key}]` : key, value);
  return out;
}

/** A Stripe object, as much of one as this app reads. */
export interface StripeObject {
  id: string;
  object: string;
  [key: string]: unknown;
}

async function request<T = StripeObject>(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, unknown>): Promise<T> {
  if (!stripeConfigured()) {
    throw new StripeError(503, "BILLING_NOT_CONFIGURED", "Payments are not set up on this deployment yet.");
  }
  const query = method === "GET" && params ? `?${formEncode(params).toString()}` : "";
  const body = method === "GET" ? undefined : formEncode(params ?? {}).toString();
  let res: Response;
  try {
    res = await fetch(`${config.stripeApiBase}${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.stripeSecretKey}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(body ? { body } : {}),
      // A stuck Stripe must not hang a person's Settings page forever.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new StripeError(502, "STRIPE_UNREACHABLE", `Couldn't reach Stripe (${(err as Error).message}). Check the internet connection and try again.`);
  }
  const payload = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string; type?: string } } & Record<string, unknown>;
  if (!res.ok) {
    const message = payload.error?.message ?? `Stripe refused the request (HTTP ${res.status}).`;
    throw new StripeError(res.status, payload.error?.code ?? payload.error?.type ?? "STRIPE_ERROR", message);
  }
  return payload as T;
}

export interface StripeSubscription extends StripeObject {
  status: string;
  customer: string | { id: string };
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  items?: { data?: Array<{ price?: { id?: string; recurring?: { interval?: string } } }> };
  metadata?: Record<string, string>;
  latest_invoice?: unknown;
}

/** The price on a subscription (the first line item — we only ever sell one). */
export function subscriptionPriceId(sub: StripeSubscription): string | null {
  return sub.items?.data?.[0]?.price?.id ?? null;
}

export function customerIdOf(sub: StripeSubscription): string | null {
  if (typeof sub.customer === "string") return sub.customer;
  return sub.customer?.id ?? null;
}

/**
 * When a subscription is over, when it renews, and what to tell the person.
 * `plan` is what the account should have right now:
 *
 *  - `active` / `trialing` → the plan they're paying for
 *  - `past_due` → keep it while Stripe retries the card (the app says "payment
 *     failed, update your card" rather than silently cutting them off)
 *  - anything else (`unpaid`, `canceled`, `incomplete`, `paused`…) → FREE
 */
export function subscriptionView(sub: StripeSubscription): {
  id: string;
  plan: Plan;
  status: string;
  priceId: string | null;
  interval: BillingInterval | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  paid: boolean;
  needsAttention: boolean;
} {
  const priceId = subscriptionPriceId(sub);
  const sold = priceId ? planForPriceId(priceId) : null;
  const interval = (sub.items?.data?.[0]?.price?.recurring?.interval ?? null) === "year" ? "annual" : sold?.interval ?? null;
  const status = sub.status ?? "unknown";
  const paying = status === "active" || status === "trialing";
  const plan: Plan = paying ? sold?.plan ?? "FREE" : status === "past_due" ? sold?.plan ?? "FREE" : "FREE";
  return {
    id: sub.id,
    plan,
    status,
    priceId,
    interval: interval === "annual" ? "annual" : interval === "monthly" ? "monthly" : null,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    paid: paying,
    needsAttention: status === "past_due" || status === "unpaid" || status === "incomplete",
  };
}

// ── The calls the app makes ─────────────────────────────────────────────────

/**
 * The Stripe customer for an account. Created before the person ever pays, so
 * the app always knows which customer to ask about — the difference between a
 * plan that updates by itself after a purchase and one that waits for a webhook
 * that a home PC can never receive.
 */
export async function createCustomer(opts: { userId: string; email: string; name?: string }): Promise<{ id: string }> {
  const customer = await request<StripeObject>("POST", "/v1/customers", {
    email: opts.email,
    ...(opts.name ? { name: opts.name } : {}),
    metadata: { userId: opts.userId },
  });
  return { id: customer.id };
}

export async function createCheckoutSession(opts: {
  priceId: string;
  userId: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
  customerId?: string | null;
}): Promise<{ id: string; url: string }> {
  const session = await request<StripeObject>("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: opts.priceId, quantity: 1 }],
    client_reference_id: opts.userId,
    // Both places, so a webhook can always find whose plan this is: the session
    // itself and (once it exists) the subscription it creates.
    metadata: { userId: opts.userId },
    subscription_data: { metadata: { userId: opts.userId } },
    ...(opts.customerId ? { customer: opts.customerId } : { customer_email: opts.email }),
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    allow_promotion_codes: true,
  });
  return { id: session.id, url: String(session.url ?? "") };
}

export async function createPortalSession(opts: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
  const session = await request<StripeObject>("POST", "/v1/billing_portal/sessions", {
    customer: opts.customerId,
    return_url: opts.returnUrl,
  });
  return { url: String(session.url ?? "") };
}

export async function retrieveSubscription(id: string): Promise<StripeSubscription> {
  return request<StripeSubscription>("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
}

/** Every subscription on a customer, newest first (past ones included). */
export async function listSubscriptions(customerId: string): Promise<StripeSubscription[]> {
  const res = await request<{ data?: StripeSubscription[] }>("GET", "/v1/subscriptions", { customer: customerId, status: "all", limit: 10 });
  return res.data ?? [];
}

export interface StripeInvoice extends StripeObject {
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
  status?: string;
  invoice_pdf?: string | null;
  hosted_invoice_url?: string | null;
  created?: number;
  customer?: string;
}

export async function listInvoices(customerId: string, limit = 12): Promise<StripeInvoice[]> {
  const res = await request<{ data?: StripeInvoice[] }>("GET", "/v1/invoices", { customer: customerId, limit });
  return res.data ?? [];
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data?: { object?: Record<string, unknown> };
}

export type WebhookCheck =
  | { ok: true; event: StripeEvent }
  | { ok: false; status: number; code: string; message: string };

/**
 * Verify a webhook really came from Stripe. The header is
 * `t=<unix>,v1=<hex>[,v1=<hex>…]`; the signature covers `<t>.<raw body>` with
 * the endpoint's signing secret. An old timestamp is refused so a captured
 * request can't be replayed later.
 */
export function verifyWebhook(rawBody: string | Buffer, signatureHeader: string | undefined, secret: string, toleranceSec = 300): WebhookCheck {
  if (!secret) return { ok: false, status: 503, code: "WEBHOOK_NOT_CONFIGURED", message: "This deployment has no Stripe webhook secret." };
  if (!signatureHeader) return { ok: false, status: 400, code: "NO_SIGNATURE", message: "Missing Stripe-Signature header." };
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestamp = Number(parts.find((p) => p.startsWith("t="))?.slice(2));
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !signatures.length) {
    return { ok: false, status: 400, code: "BAD_SIGNATURE_HEADER", message: "That Stripe-Signature header isn't readable." };
  }
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const matches = signatures.some((sig) => {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!matches) return { ok: false, status: 400, code: "SIGNATURE_MISMATCH", message: "That webhook wasn't signed with this endpoint's secret." };
  const age = Math.abs(Date.now() / 1000 - timestamp);
  if (age > toleranceSec) return { ok: false, status: 400, code: "SIGNATURE_TOO_OLD", message: "That webhook is too old to trust." };
  let event: StripeEvent;
  try {
    event = JSON.parse(body) as StripeEvent;
  } catch {
    return { ok: false, status: 400, code: "BAD_PAYLOAD", message: "That webhook body isn't JSON." };
  }
  if (!event?.id || !event?.type) return { ok: false, status: 400, code: "BAD_EVENT", message: "That webhook has no event id or type." };
  return { ok: true, event };
}

/** Tests (and `stripe listen` in development): sign a body the way Stripe does. */
export function signWebhookPayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}
