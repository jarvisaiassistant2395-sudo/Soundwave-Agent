/**
 * Soundwave AI — sales site configuration.
 *
 * This is the ONE file to edit for prices, packages, download links and
 * contact details. Both the browser (index.html loads it as a module) and the
 * checkout server (server.mjs) import it, so a change here is picked up
 * everywhere at once — no rebuild step.
 *
 * Nothing secret goes in this file: it is served to the public. Stripe secret
 * keys and price IDs live in the environment (see .env.example / README.md).
 */

/* ── Brand ──────────────────────────────────────────────────────────────── */

export const BRAND = {
  name: "Soundwave AI",
  /** Short line used in the nav, footer and page titles. */
  tagline: "The AI agent that writes, narrates and renders your shorts.",
  description:
    "Soundwave AI is a desktop agent for Windows that writes, narrates and renders vertical shorts — with on-device speech, burnt-in captions and an Android app that keeps the same conversation.",
  supportEmail: "support@soundwave.ai",
  salesEmail: "sales@soundwave.ai",
  github: "https://github.com/jarvisaiassistant2395-sudo/Soundwave-Agent",
  /**
   * The hosted app's URL, if you have one deployed (the repo's `frontend/` +
   * `server/`). Set it and a "Sign in" link appears in the nav, which is where
   * a buyer goes to use an account plan. Leave it empty ("") and no link is
   * added — the Windows app needs no account.
   */
  webApp: "",
  /** Shown in the footer. */
  copyright: "Soundwave AI",
};

/* ── Downloads ──────────────────────────────────────────────────────────── */
/* CI builds the installers from this repo and attaches them to GitHub
   releases. Point these anywhere you like (your own CDN, Gumroad, an S3
   bucket) — the buttons use whatever is here. Leave a value empty ("") and
   that button hides itself instead of linking nowhere.                      */

export const DOWNLOADS = {
  releasesPage:
    "https://github.com/jarvisaiassistant2395-sudo/Soundwave-Agent/releases/latest",
  windowsInstaller:
    "https://github.com/jarvisaiassistant2395-sudo/Soundwave-Agent/releases/latest",
  windowsPortable:
    "https://github.com/jarvisaiassistant2395-sudo/Soundwave-Agent/releases/latest",
  android: "https://github.com/jarvisaiassistant2395-sudo/Soundwave-Agent/releases/latest",
  /** Shown next to the download buttons. */
  versionNote: "Windows 10/11 · 64-bit · installs in under a minute",
};

/* ── Payments ───────────────────────────────────────────────────────────── */
/*
 * Two ways to take money, and they can be mixed:
 *
 *  1. Checkout server (recommended) — run `node server.mjs` with
 *     STRIPE_SECRET_KEY and the STRIPE_PRICE_* ids set (see .env.example).
 *     The server creates a real Stripe Checkout Session per click, so prices,
 *     taxes, coupons, trials and receipts all live in Stripe where they belong.
 *
 *  2. Stripe Payment Links — paste the links from your Stripe dashboard below.
 *     They work even on plain static hosting with no server at all. Used as a
 *     fallback whenever the checkout server is not reachable.
 *
 * With both empty the Buy buttons stay honest: they open a short dialog saying
 * payments are not connected yet, and offer the free download and an email
 * address instead of pretending to charge anyone.
 */

export const PAYMENTS = {
  provider: "stripe",
  currency: "USD",
  /** "monthly" or "annual" — which the pricing toggle starts on. */
  defaultInterval: "annual",
  /** Optional: numbers shown as "Save X%" on annual billing. */
  annualSavingLabel: "Save 20%",
  /**
   * Small print under the pricing grid.
   *
   * BE PRECISE HERE — it is the difference between selling and overselling.
   * Today the plans are enforced per Soundwave *account* by the hosted service
   * (server/src/routes/tts.ts counts narration characters, projects.ts gates
   * cloud save, billing.ts publishes the numbers). The desktop app renders on
   * the user's own PC and is not plan-gated: it ships without a watermark and
   * needs no account. So the honest line is the one below — the app is free,
   * a plan raises your account's limits.
   *
   * If you later sell a licence for the desktop app itself (one-time or
   * otherwise), that needs licence keys and enforcement inside the app — see
   * README.md, "Selling the desktop app itself".
   */
  note:
    "Plans apply to your Soundwave account — the narration quota, watermark-free exports, cloud save and API access that the hosted service and phone app use. The Windows app itself is a free download that renders on your PC. Prices in USD, excluding local taxes; cancel any time.",
  /** Stripe Payment Links per plan per interval (paste from the dashboard). */
  links: {
    PRO: { monthly: "", annual: "" },
    ENTERPRISE: { monthly: "", annual: "" },
  },
  /**
   * Price IDs are read by server.mjs from the environment:
   *   STRIPE_PRICE_PRO_MONTHLY / STRIPE_PRICE_PRO_ANNUAL
   *   STRIPE_PRICE_ENTERPRISE_MONTHLY / STRIPE_PRICE_ENTERPRISE_ANNUAL
   * or set them inline here if you would rather keep them in git (they are not
   * secret — they are just references). Empty means "use the env var".
   */
  priceIds: {
    PRO: { monthly: "", annual: "" },
    ENTERPRISE: { monthly: "", annual: "" },
  },
};

/* ── Plans ──────────────────────────────────────────────────────────────── */
/*
 * The plans mirror frontend/src/lib/plans.ts in the app, so what the site
 * promises is what the product enforces. Edit freely — the cards, the compare
 * table, the toggle and the checkout all read from here.
 *
 * action: "download" → free plan, sends people to the installer
 *         "checkout" → paid plan, opens Stripe Checkout (or the fallback)
 *         "contact"  → sales conversation instead of a card form
 */

export const PLANS = [
  {
    id: "FREE",
    name: "Free",
    tagline: "The whole agent, on your PC — free to install and keep.",
    badge: null,
    highlight: false,
    action: "download",
    cta: "Download for free",
    price: { monthly: 0, annual: 0 },
    /** Shown where the price would be, under $0. */
    priceNote: "No account. No card. Renders on your machine.",
    features: [
      "The full Windows app — writes, narrates, renders",
      "All 10 Soundwave neural voices",
      "Word-by-word captions, burnt in",
      "Unused gameplay background per render",
      "Shorts from a long video · watched channels",
      "Voice input, screen reading, reminders, memory",
      "The Android app and the morning briefing",
      "10,000 account characters · 720p · 2 exports an hour",
    ],
    /** Shown greyed-out so the upgrade path is obvious. */
    missing: [
      "Watermark-free exports through the hosted service",
      "1080p and 4K account exports",
      "Cloud save and voice cloning",
    ],
  },
  {
    id: "PRO",
    name: "Pro",
    tagline: "For creators posting every day.",
    badge: "Most popular",
    highlight: true,
    action: "checkout",
    cta: "Get Pro",
    price: { monthly: 12, annual: 9.6 },
    priceNote: "Billed monthly. Cancel any time.",
    features: [
      "200,000 account narration characters a month",
      "1080p exports, no watermark",
      "20 exports an hour · 50 projects",
      "Every subtitle font and full styling",
      "Cloud save for your projects",
      "Shorts from a long video, automatically",
      "Watched channels: clip new uploads on sight",
      "Your own cloned voice (self-hosted sidecar)",
    ],
    missing: ["4K exports", "API access"],
  },
  {
    id: "ENTERPRISE",
    name: "Enterprise",
    tagline: "Volume, 4K, and an API you can build on.",
    badge: null,
    highlight: false,
    action: "checkout",
    cta: "Get Enterprise",
    price: { monthly: 39, annual: 31.2 },
    priceNote: "Billed monthly. Cancel any time.",
    features: [
      "2,000,000 account narration characters a month",
      "4K exports up to 2 GB per file",
      "100 exports an hour · unlimited projects",
      "Everything in Pro, including cloned voices",
      "API access for your own pipelines",
      "Priority renders through the hosted service",
    ],
    missing: [],
  },
];

/* ── Compare table ──────────────────────────────────────────────────────── */
/* Derived from the plans above wherever possible, so a price or limit change
   never leaves the table behind. Add your own rows here if you want more.   */

const chars = (n) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(0)}M` : `${Math.round(n / 1000)}K`;

const byId = Object.fromEntries(PLANS.map((p) => [p.id, p]));

export const COMPARISON = [
  {
    label: "Narration characters / month",
    values: {
      FREE: chars(10_000),
      PRO: chars(200_000),
      ENTERPRISE: chars(2_000_000),
    },
  },
  {
    label: "Max export resolution",
    values: { FREE: "720p", PRO: "1080p", ENTERPRISE: "4K" },
  },
  {
    label: "Exports per hour",
    values: { FREE: "2", PRO: "20", ENTERPRISE: "100" },
  },
  {
    label: "Watermark",
    values: { FREE: "Small Soundwave mark", PRO: "None", ENTERPRISE: "None" },
  },
  {
    label: "Projects",
    values: { FREE: "3", PRO: "50", ENTERPRISE: "Unlimited" },
  },
  {
    label: "Subtitle fonts",
    values: { FREE: "3", PRO: "All 20", ENTERPRISE: "All 20" },
  },
  {
    label: "Max upload size",
    values: { FREE: "100 MB", PRO: "500 MB", ENTERPRISE: "2 GB" },
  },
  {
    label: "Cloud save",
    values: { FREE: "—", PRO: "Yes", ENTERPRISE: "Yes" },
  },
  {
    label: "Cloned voices (self-hosted)",
    values: { FREE: "—", PRO: "Yes", ENTERPRISE: "Yes" },
  },
  {
    label: "API access",
    values: { FREE: "—", PRO: "—", ENTERPRISE: "Yes" },
  },
].map((row) => ({
  ...row,
  /** Guarantees every plan column has a value, even if you add a plan. */
  values: Object.fromEntries(
    PLANS.map((p) => [p.id, row.values[p.id] ?? "—"]),
  ),
}));

/** Exported for the server, which validates checkout requests against it. */
export const PLAN_IDS = PLANS.filter((p) => p.action === "checkout").map(
  (p) => p.id,
);

export const planById = (id) => byId[id] ?? null;

/* ── Money formatting shared by the page and the server ─────────────────── */

export function formatPrice(amount, currency = PAYMENTS.currency) {
  if (amount === 0) return "$0";
  const rounded = Math.round(amount * 100) / 100;
  const text = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
  return currency === "USD" ? `$${text}` : `${text} ${currency}`;
}

export function yearlyTotal(plan, currency = PAYMENTS.currency) {
  return formatPrice(plan.price.annual * 12, currency);
}

export default {
  BRAND,
  DOWNLOADS,
  PAYMENTS,
  PLANS,
  COMPARISON,
  PLAN_IDS,
  planById,
  formatPrice,
  yearlyTotal,
};
