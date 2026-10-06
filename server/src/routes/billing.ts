// ── Billing: the plans people pay for ───────────────────────────────────────
// Soundwave's plans are Stripe subscriptions. Paying happens in the person's
// own browser (lib/stripe.ts → Stripe Checkout), so no card touches this app;
// what this file does is start that, listen to what Stripe says afterwards, and
// keep the account's plan in step.
//
//   GET    /api/v1/billing/plans          what the plans are, and whether billing works here
//   GET    /api/v1/billing/status         this account's plan + its subscription
//   POST   /api/v1/billing/create-checkout  → { url } to open in a browser
//   POST   /api/v1/billing/create-portal    → { url } to manage/cancel the card
//   POST   /api/v1/billing/reconcile      ask Stripe directly what this account has paid for
//   GET    /api/v1/billing/invoices       receipts (Stripe's, with PDF links)
//   POST   /api/v1/billing/webhook        Stripe tells us what happened (signed)
//   POST   /api/v1/billing/apply-plan     development only: set a plan without paying
//
// Two things keep the plan honest: the webhook (instant, needs a reachable
// URL) and `reconcile` (the app asks Stripe when someone comes back from
// Checkout or opens the Billing tab). A desktop app on a home PC usually has no
// public URL for Stripe to call, so reconcile is not a nicety — it is how the
// plan updates for most people.

import { Router } from "express";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/error.js";
import { getStore } from "../lib/store.js";
import type { StoredUser } from "../lib/store.js";
import { PLANS, type Plan } from "../lib/plans.js";
import { config } from "../config.js";
import {
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  customerIdOf,
  listInvoices as listStripeInvoices,
  listSubscriptions,
  missingPrices,
  priceIdFor,
  retrieveSubscription,
  StripeError,
  stripeConfigured,
  subscriptionView,
  verifyWebhook,
  type BillingInterval,
  type StripeEvent,
  type StripeSubscription,
} from "../lib/stripe.js";
import { alreadyHandled, rememberHandled } from "../lib/billingEvents.js";
import { billingEnabled, effectivePlan, personalEdition } from "../lib/edition.js";

const router = Router();

/**
 * The owner's own build has no payment in it (lib/edition.ts). Everything that
 * would take money or ask Stripe about it refuses here, in one place, so no
 * half-working path can exist: /plans and /status answer (the UI needs them to
 * know what this build is), the rest say plainly that there is nothing to pay.
 */
const requireBilling: RequestHandler = (_req, _res, next) => {
  if (!billingEnabled) return next(new ApiError(404, "NO_BILLING", "This build has no billing — there is nothing to pay for."));
  next();
};

/** A refusal from Stripe, said in the app's own error shape. */
function stripeProblem(err: unknown): ApiError | null {
  if (!(err instanceof StripeError)) return null;
  return new ApiError(err.status >= 500 ? 502 : err.status, err.code, err.message);
}

function planPayload() {
  return {
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      monthlyPrice: p.monthlyPrice,
      annualPricePerMonth: p.annualPricePerMonth,
      characterLimit: p.characterLimit,
      maxResolution: p.maxResolution,
      watermark: p.watermark,
      cloudSave: p.cloudSave,
      apiAccess: p.apiAccess,
    })),
    // The UI shows "billing isn't set up on this deployment" instead of a
    // button that leads nowhere — and in the owner's own build it says there is
    // nothing to pay at all.
    billing: {
      configured: billingEnabled && stripeConfigured(),
      personal: personalEdition,
      missingPrices: billingEnabled ? missingPrices() : [],
    },
  };
}

router.get("/plans", (_req, res) => {
  res.json(planPayload());
});

// ── This account's subscription ─────────────────────────────────────────────

/**
 * The account's Stripe customer, made on the spot if it doesn't have one yet.
 * Storing it *before* Checkout is what lets `reconcile` find the subscription
 * afterwards even when no webhook can reach this machine.
 */
async function ensureStripeCustomer(user: StoredUser): Promise<string> {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await createCustomer({ userId: user.id, email: user.email, name: user.name });
  await (await getStore()).updateUser(user.id, { stripeCustomerId: customer.id });
  return customer.id;
}

/** What Stripe says about an account right now (null when it has never paid). */
async function liveSubscription(user: StoredUser): Promise<{ view: ReturnType<typeof subscriptionView>; customerId: string } | null> {
  const customerId = user.stripeCustomerId;
  if (!stripeConfigured() || !customerId) return null;
  const subscriptions = await listSubscriptions(customerId);
  if (!subscriptions.length) return null;
  // The one that matters: anything still alive first (active/trialing/past_due),
  // else the most recent finished one (so the UI can say "ended on …").
  const alive = subscriptions.find((s) => ["active", "trialing", "past_due"].includes(s.status));
  const chosen: StripeSubscription = alive ?? subscriptions[0]!;
  return { view: subscriptionView(chosen), customerId };
}

/**
 * Bring the account's plan in line with what Stripe has — the safety net for
 * when a webhook can't reach a home PC, and what someone comes back to after
 * Checkout. Also records the customer/subscription ids the first time.
 */
async function reconcileUser(user: StoredUser): Promise<{ plan: Plan; changed: boolean; view: ReturnType<typeof subscriptionView> | null }> {
  // Read what the account had before touching it: the JSON store hands out the
  // live record, so comparing after the update would always say "no change".
  const was = { plan: user.plan, customerId: user.stripeCustomerId, subscriptionId: user.stripeSubscriptionId };
  const live = await liveSubscription(user);
  if (!live) return { plan: was.plan, changed: false, view: null };
  const plan = live.view.plan;
  const patch: Partial<StoredUser> = {};
  if (was.customerId !== live.customerId) patch.stripeCustomerId = live.customerId;
  if (was.subscriptionId !== live.view.id) patch.stripeSubscriptionId = live.view.id || null;
  if (was.plan !== plan) patch.plan = plan;
  if (Object.keys(patch).length) await (await getStore()).updateUser(user.id, patch);
  return { plan, changed: was.plan !== plan, view: live.view };
}

router.get("/status", requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    if (personalEdition) {
      // Nothing to sell and nothing to check: this is the owner's own PC.
      return res.json({ plan: effectivePlan(user.plan), configured: false, personal: true, customer: false, subscription: null });
    }
    if (!stripeConfigured()) {
      return res.json({ plan: user.plan, configured: false, subscription: null, customer: Boolean(user.stripeCustomerId) });
    }
    let view: ReturnType<typeof subscriptionView> | null = null;
    try {
      view = (await liveSubscription(user))?.view ?? null;
    } catch (err) {
      // Stripe being unreachable must not hide the app's own state.
      return res.json({
        plan: user.plan,
        configured: true,
        subscription: null,
        customer: Boolean(user.stripeCustomerId),
        problem: (err as Error).message,
      });
    }
    res.json({
      plan: view?.plan ?? user.plan,
      configured: true,
      customer: Boolean(user.stripeCustomerId),
      subscription: view
        ? {
            status: view.status,
            interval: view.interval,
            currentPeriodEnd: view.currentPeriodEnd,
            cancelAtPeriodEnd: view.cancelAtPeriodEnd,
            needsAttention: view.needsAttention,
          }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

router.post("/reconcile", requireBilling, requireAuth, async (req, res, next) => {
  try {
    if (!stripeConfigured()) throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Payments are not set up on this deployment yet.");
    const { plan, changed, view } = await reconcileUser(req.user!);
    res.json({
      plan,
      changed,
      subscription: view
        ? { status: view.status, interval: view.interval, currentPeriodEnd: view.currentPeriodEnd, cancelAtPeriodEnd: view.cancelAtPeriodEnd, needsAttention: view.needsAttention }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

// ── Paying ──────────────────────────────────────────────────────────────────

const checkoutSchema = z.object({ plan: z.enum(["PRO", "ENTERPRISE"]), billing: z.enum(["monthly", "annual"]).default("monthly") });

/** Where the browser should come back to (this app's own page, same origin). */
function appOriginFor(req: Request): string {
  // The browser's own Origin is the truthful answer: a dev proxy rewrites Host
  // (so it would send people to the API port, where the app isn't served), and
  // in the desktop build the window's origin is 127.0.0.1 while Host may say
  // localhost — a different host for cookies. Only a loopback origin is taken.
  const origin = String(req.headers.origin ?? "");
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return origin.replace(/\/$/, "");
  const host = String(req.headers.host ?? "");
  if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return `http://${host}`;
  return config.appUrl.replace(/\/$/, "");
}

router.post("/create-checkout", requireBilling, requireAuth, validate({ body: checkoutSchema }), async (req, res, next) => {
  try {
    if (!stripeConfigured()) throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Payments are not set up on this deployment yet — the plan can be switched locally instead.");
    const { plan, billing } = req.body as z.infer<typeof checkoutSchema>;
    const priceId = priceIdFor(plan, billing as BillingInterval);
    if (!priceId) {
      throw new ApiError(503, "PRICE_NOT_CONFIGURED", `This deployment has no Stripe price for ${PLANS[plan].name} (${billing}). Add STRIPE_PRICE_${plan}_${billing.toUpperCase()}.`);
    }
    const origin = appOriginFor(req);
    const customerId = await ensureStripeCustomer(req.user!);
    const session = await createCheckoutSession({
      priceId,
      userId: req.user!.id,
      email: req.user!.email,
      customerId,
      // Back to Billing, where the page notices the purchase and reconciles.
      successUrl: `${origin}/settings/billing?billing=success`,
      cancelUrl: `${origin}/settings/billing?billing=cancelled`,
    });
    if (!session.url) throw new ApiError(502, "STRIPE_NO_URL", "Stripe didn't return a checkout page. Try again in a moment.");
    res.json({ url: session.url, sessionId: session.id });
  } catch (e) {
    next(stripeProblem(e) ?? e);
  }
});

router.post("/create-portal", requireBilling, requireAuth, async (req, res, next) => {
  try {
    if (!stripeConfigured()) throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Billing isn't set up on this deployment yet.");
    const user = req.user!;
    if (!user.stripeCustomerId) {
      throw new ApiError(409, "NO_CUSTOMER", "There's no subscription to manage yet — upgrade first, then come back here to change your card or cancel.");
    }
    const session = await createPortalSession({ customerId: user.stripeCustomerId, returnUrl: `${appOriginFor(req)}/settings/billing` });
    if (!session.url) throw new ApiError(502, "STRIPE_NO_URL", "Stripe didn't return a billing page. Try again in a moment.");
    res.json({ url: session.url });
  } catch (e) {
    next(stripeProblem(e) ?? e);
  }
});

router.get("/invoices", requireBilling, requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    // Live receipts from Stripe when it's set up; otherwise whatever the local
    // store recorded (development, or a deployment without keys).
    if (stripeConfigured() && user.stripeCustomerId) {
      try {
        const invoices = await listStripeInvoices(user.stripeCustomerId);
        return res.json({
          source: "stripe",
          invoices: invoices.map((i) => ({
            id: i.id,
            amount: i.amount_paid ?? i.amount_due ?? 0,
            currency: i.currency ?? "usd",
            status: i.status ?? "unknown",
            pdfUrl: i.invoice_pdf ?? null,
            hostedUrl: i.hosted_invoice_url ?? null,
            createdAt: i.created ? new Date(i.created * 1000).toISOString() : null,
          })),
        });
      } catch (err) {
        console.warn("[billing] could not list Stripe invoices:", (err as Error).message);
      }
    }
    const store = await getStore();
    const invoices = await store.listInvoices(user.id);
    res.json({
      source: "local",
      invoices: invoices.map((i) => ({
        id: i.id,
        stripeInvoiceId: i.stripeInvoiceId,
        amount: i.amount,
        currency: i.currency,
        status: i.status,
        pdfUrl: i.pdfUrl,
        hostedUrl: null,
        createdAt: i.createdAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// ── Development: change the plan without paying ─────────────────────────────

/**
 * A local affordance so the whole quota path can be tried without a card. It
 * only exists where billing isn't set up: a deployment with Stripe keys must
 * never let a plan be granted for free.
 */
router.post("/apply-plan", requireBilling, requireAuth, validate({ body: checkoutSchema }), async (req, res, next) => {
  try {
    if (stripeConfigured()) {
      throw new ApiError(409, "BILLING_CONFIGURED", "This deployment takes payments through Stripe — upgrade from the Billing tab instead.");
    }
    const { plan } = req.body as z.infer<typeof checkoutSchema>;
    const store = await getStore();
    const user = await store.updateUser(req.user!.id, { plan });
    res.json({ user: { id: user!.id, plan: user!.plan, name: user!.name, email: user!.email } });
  } catch (e) {
    next(e);
  }
});

// ── Stripe telling us what happened ─────────────────────────────────────────

/** Which account an event is about: by id it carries, else by its customer. */
async function userForEvent(event: StripeEvent): Promise<{ user: StoredUser; from: string } | null> {
  const object = (event.data?.object ?? {}) as Record<string, unknown>;
  const store = await getStore();
  const byId =
    (typeof object.client_reference_id === "string" && object.client_reference_id) ||
    (typeof (object.metadata as Record<string, string> | undefined)?.userId === "string" ? (object.metadata as Record<string, string>).userId : "") ||
    null;
  if (byId) {
    const user = await store.findUserById(byId);
    if (user) return { user, from: "id" };
  }
  const customerId = typeof object.customer === "string" ? object.customer : typeof (object.customer as { id?: string } | undefined)?.id === "string" ? (object.customer as { id: string }).id : null;
  if (customerId) {
    const user = await store.findUserByStripeCustomerId(customerId);
    if (user) return { user, from: "customer" };
  }
  return null;
}

/**
 * The subscription an event is about. Stripe sends the whole object with
 * `customer.subscription.*`, so the id is only fetched when it doesn't.
 */
async function subscriptionForEvent(event: StripeEvent): Promise<StripeSubscription | null> {
  const object = (event.data?.object ?? {}) as Record<string, unknown>;
  const id = typeof object.id === "string" ? object.id : "";
  if (id.startsWith("sub_")) {
    const inline = object as unknown as StripeSubscription;
    if (inline.status) return inline;
    try {
      return await retrieveSubscription(id);
    } catch {
      return null;
    }
  }
  const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
  if (!subscriptionId) return null;
  try {
    return await retrieveSubscription(subscriptionId);
  } catch {
    return null;
  }
}

/** Apply what Stripe says to the account (the one place a plan is set by it). */
async function applyEvent(event: StripeEvent): Promise<string> {
  const store = await getStore();
  const found = await userForEvent(event);
  const object = (event.data?.object ?? {}) as Record<string, unknown>;

  if (event.type === "checkout.session.completed") {
    const userId = (typeof object.client_reference_id === "string" && object.client_reference_id) || (object.metadata as Record<string, string> | undefined)?.userId || "";
    const user = userId ? await store.findUserById(userId) : found?.user ?? null;
    if (!user) return "no account for that checkout";
    const customerId = typeof object.customer === "string" ? object.customer : null;
    const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
    const had = { customerId: user.stripeCustomerId, subscriptionId: user.stripeSubscriptionId };
    const patch: Partial<StoredUser> = {};
    if (customerId && had.customerId !== customerId) patch.stripeCustomerId = customerId;
    if (subscriptionId && had.subscriptionId !== subscriptionId) patch.stripeSubscriptionId = subscriptionId;
    if (Object.keys(patch).length) await store.updateUser(user.id, patch);
    // The plan itself comes from the subscription (its price says which plan) —
    // read it now rather than guessing from the session.
    const fresh = await store.findUserById(user.id);
    if (fresh) await reconcileUser(fresh);
    return "customer recorded";
  }

  if (event.type.startsWith("customer.subscription.")) {
    const sub = await subscriptionForEvent(event);
    if (!found) return "no account for that subscription";
    const user = found.user;
    if (!sub) {
      // Deleted subscriptions arrive whole, so this is rare — treat as ended.
      if (event.type === "customer.subscription.deleted") {
        await store.updateUser(user.id, { plan: "FREE", stripeSubscriptionId: null });
        return "subscription ended";
      }
      return "no subscription in that event";
    }
    const view = subscriptionView(sub);
    const customerId = customerIdOf(sub);
    const patch: Partial<StoredUser> = { plan: view.plan, stripeSubscriptionId: view.plan === "FREE" ? null : sub.id };
    if (customerId && user.stripeCustomerId !== customerId) patch.stripeCustomerId = customerId;
    await store.updateUser(user.id, patch);
    return `subscription ${view.status} → ${view.plan}`;
  }

  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed" || event.type === "invoice.payment_succeeded") {
    if (!found) return "no account for that invoice";
    const user = found.user;
    const customerId = typeof object.customer === "string" ? object.customer : null;
    if (customerId && user.stripeCustomerId !== customerId) await store.updateUser(user.id, { stripeCustomerId: customerId });
    // (The live record changes with the update above — nothing below compares
    // it against its old value.)
    const existing = await store.listInvoices(user.id);
    const stripeInvoiceId = String(object.id ?? "");
    if (stripeInvoiceId && !existing.some((i) => i.stripeInvoiceId === stripeInvoiceId)) {
      await store.createInvoice({
        userId: user.id,
        stripeInvoiceId,
        amount: Number(object.amount_paid ?? object.amount_due ?? 0),
        currency: String(object.currency ?? "usd"),
        status: String(object.status ?? (event.type === "invoice.payment_failed" ? "failed" : "paid")),
        pdfUrl: typeof object.invoice_pdf === "string" ? object.invoice_pdf : null,
      });
    }
    // A failed payment is Stripe's problem to retry; the subscription events
    // will tell us if it gives up (that is what sets the plan back to FREE).
    return `invoice ${String(object.status ?? event.type)}`;
  }

  return "ignored";
}

/**
 * Stripe → this server. The body must be the raw bytes (the signature covers
 * them), which app.ts arranges for this one path; it is public by design but
 * useless without the signing secret.
 */
export const billingWebhook: RequestHandler = async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
  const check = verifyWebhook(raw, req.headers["stripe-signature"] as string | undefined, config.stripeWebhookSecret);
  if (!check.ok) {
    console.warn(`[billing] webhook refused (${check.code}): ${check.message}`);
    return res.status(check.status).json({ error: { code: check.code, message: check.message } });
  }
  const event = check.event;
  if (alreadyHandled(event.id)) return res.json({ received: true, duplicate: true });
  try {
    const outcome = await applyEvent(event);
    rememberHandled(event.id);
    console.log(`[billing] ${event.type}: ${outcome}`);
    res.json({ received: true });
  } catch (err) {
    // 500 asks Stripe to retry — which is right for a transient failure (a
    // locked data file, Stripe briefly unreachable).
    console.error(`[billing] ${event.type} failed:`, (err as Error).message);
    res.status(500).json({ error: { code: "WEBHOOK_FAILED", message: (err as Error).message } });
  }
};

router.post("/webhook", requireBilling, billingWebhook);

export default router;
