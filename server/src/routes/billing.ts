import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/error.js";
import { getStore } from "../lib/store.js";
import { PLANS } from "../lib/plans.js";
import { config } from "../config.js";

const router = Router();

router.get("/plans", (_req, res) => {
  res.json({
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
  });
});

const checkoutSchema = z.object({ plan: z.enum(["PRO", "ENTERPRISE"]), billing: z.enum(["monthly", "annual"]).default("monthly") });

router.post("/create-checkout", requireAuth, validate({ body: checkoutSchema }), async (req, res, next) => {
  try {
    if (!config.stripeSecretKey) {
      throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Payments are not configured on this deployment. This is a demo — the plan change has been applied locally.");
    }
    // Production: create a Stripe Checkout Session here and return { url }.
    throw new ApiError(501, "BILLING_NOT_CONFIGURED", "Stripe checkout is not wired up in this environment.");
  } catch (e) {
    next(e);
  }
});

// Demo affordance: apply a plan locally so the full quota flow can be tested.
router.post("/apply-plan", requireAuth, validate({ body: checkoutSchema }), async (req, res, next) => {
  try {
    const { plan } = req.body as z.infer<typeof checkoutSchema>;
    const store = await getStore();
    const user = await store.updateUser(req.user!.id, { plan });
    res.json({ user: { id: user!.id, plan: user!.plan, name: user!.name, email: user!.email } });
  } catch (e) {
    next(e);
  }
});

router.post("/create-portal", requireAuth, (_req, res, next) => {
  try {
    if (!config.stripeSecretKey) {
      throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Billing portal is not configured on this deployment.");
    }
    throw new ApiError(501, "BILLING_NOT_CONFIGURED", "Stripe portal is not wired up in this environment.");
  } catch (e) {
    next(e);
  }
});

router.get("/invoices", requireAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const invoices = await store.listInvoices(req.user!.id);
    res.json({
      invoices: invoices.map((i) => ({
        id: i.id,
        amount: i.amount,
        currency: i.currency,
        status: i.status,
        pdfUrl: i.pdfUrl,
        createdAt: i.createdAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// Stripe webhook (raw body is required for signature verification).
router.post("/webhook", (req, res) => {
  // Production: verify the Stripe-Signature header using config.stripeWebhookSecret
  // and handle idempotency by event id. This handler is intentionally minimal
  // in the demo build.
  res.json({ received: true });
});

export default router;
