# Soundwave AI — sales site

The marketing and checkout site for Soundwave AI: hero, features, the real voice
samples, pricing, FAQ and the legal pages. Static HTML/CSS/JS — **no build step,
no dependencies** — plus one small Node file that exists solely to create Stripe
Checkout Sessions.

```
site/
├── index.html            the site (hero, features, tools, voices, pricing, FAQ)
├── styles.css            the design system — same palette as the app
├── app.js                nav, hero animation, voices, pricing, checkout
├── config.js             ◀ EDIT THIS: plans, prices, links, emails
├── server.mjs            static server + Stripe Checkout (Node 18+, no deps)
├── success.html/.js      real payment confirmation (asks Stripe what happened)
├── cancel.html           404.html   terms.html   privacy.html   refunds.html
├── assets/               logo, favicon, og-image.jpg, the six voice MP3s
├── tools/
│   ├── make-og-image.sh  rebuilds assets/og-image.jpg (needs ImageMagick)
│   └── csp-hash.mjs      hash for the JSON-LD block, used by server.mjs' CSP
├── Dockerfile            node:22-alpine, no dependencies to install
├── robots.txt  sitemap.xml
└── .env.example          ◀ the Stripe keys live here
```

## Run it

```bash
cd site
node server.mjs            # → http://localhost:4173
```

That's the whole install. Server env (optional):

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `4173` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `SITE_URL` | request origin | Absolute base for Stripe success/cancel URLs. Set it in production. |
| `STRIPE_SECRET_KEY` | — | Enables checkout. Without it the Buy buttons explain instead of failing. |
| `STRIPE_PRICE_*` | — | Price IDs (see below) |
| `STRIPE_MODE` | `subscription` | Set to `payment` if you sell one-time licences |
| `STRIPE_API_BASE` | Stripe | Only for testing against a stand-in |

## Edit prices, plans and links — one file

Everything commercial lives in **`config.js`**, and both the browser and the
server read it, so a change is live after a refresh:

- `PLANS` — name, tagline, badge, price (monthly + annual), the feature list and
  the greyed-out "missing" list per plan. Mark one plan `highlight: true` for the
  featured card.
- `COMPARISON` — the compare table. Limits shown there are the same numbers the
  app enforces in `server/src/lib/plans.ts`; keep them in step when you change
  what a plan includes.
- `PAYMENTS.links` — Stripe Payment Links per plan per interval (see the
  no-server route below).
- `PAYMENTS.note`, `PAYMENTS.annualSavingLabel` — small print and the "Save X%"
  pill.
- `DOWNLOADS` — where the installer, portable build, Android app and the
  releases page point. Empty a value and that button hides itself.
- `BRAND` — support/sales emails, GitHub link, footer line.

The pricing grid and the compare table are rendered from this file, so you can
never end up with a stale table next to a new price.

## What the plans apply to (read this before you sell)

The plans on this site are **account** plans, because that is what the code actually
enforces: `server/src/routes/tts.ts` counts narration characters against
`PLANS[user.plan].characterLimit`, `server/src/routes/projects.ts` gates cloud save
on the plan, and `server/src/routes/billing.ts` publishes the numbers. Users get
`config.defaultSignupPlan` when they sign up.

The **desktop app is not plan-gated**. It renders on the user's own PC, needs no
account and ships without a watermark (`watermark: false` in
`server/src/routes/agentShort.ts`). That's why the site says "the app is free — a
plan raises your account's limits" rather than implying the download stops working
after 10,000 characters. Keep it that way unless you change the code.

### Selling the desktop app itself

If you'd rather sell the app as a one-time purchase, the honest way to do it is:

1. **Issue licence keys** — Stripe Checkout in `payment` mode
   (`STRIPE_MODE=payment`, one-time prices), then a webhook that mints a key and
   emails it (`checkout.session.completed`). Nothing in this repo does that yet.
2. **Verify the key inside the app** — offline-verifiable (a signed key, or a
   licence file signed with your private key) so the app works without a server
   call. Otherwise every launch depends on your uptime.
3. **Enforce it where it matters** in `server/src/lib/plans.ts` for local runs.
4. **Update this site**: switch the cards to one-time prices, change `action` to
   `"checkout"` with `STRIPE_MODE=payment`, and rewrite the two FAQ answers that
   currently describe account limits.

Until that exists, promising a paid desktop licence on this page would be selling
something the software doesn't enforce — the one thing this site is written not
to do.

## Take payments with Stripe (checkout server)

1. **Create the products.** In the Stripe dashboard make one product per paid
   plan with **two recurring prices** each — monthly and annual. (Annual prices
   are billed once a year; the site shows the per-month equivalent.)
2. **Copy the six price IDs** (`price_…`) into `.env`:

   ```bash
   cp .env.example .env
   # STRIPE_SECRET_KEY=sk_test_…
   # STRIPE_PRICE_PRO_MONTHLY=price_…      STRIPE_PRICE_PRO_ANNUAL=price_…
   # STRIPE_PRICE_ENTERPRISE_MONTHLY=…     STRIPE_PRICE_ENTERPRISE_ANNUAL=…
   SITE_URL=http://localhost:4173
   ```

   (`server.mjs` reads these via `node --env-file=.env server.mjs`, or export
   them however your host does. Docker: `--env-file .env`.)
3. **Test it** with Stripe's test card `4242 4242 4242 4242`, any future expiry.
   The confirmation page asks Stripe what really happened — no guessing.
4. **Go live**: swap in the `sk_live_…` key and the live price IDs, set
   `SITE_URL` to your domain, and add that domain's `/success` and `/cancel`
   URLs to your Stripe settings.

The server sends `allow_promotion_codes`, collects billing addresses and stamps
the plan and interval into the session metadata, so your Stripe dashboard and the
thank-you page both know what was bought. Rate limit: 20 checkout attempts per
IP per 10 minutes.

## Take payments with no server at all

Static hosting can still sell. In Stripe, create a **Payment Link** per plan per
interval, then paste them into `PAYMENTS.links` in `config.js`:

```js
links: { PRO: { monthly: "https://buy.stripe.com/…", annual: "…" }, … }
```

The page tries the checkout server first and falls back to these, so you can
start static and add the server later without touching anything else. Note that
with payment links you get no confirmation on your own page — Stripe's receipt
is the confirmation, and `success.html` says so plainly instead of inventing one.

## Deploy it

- **Static host** (Netlify, Vercel, Cloudflare Pages, GitHub Pages, S3): upload
  the folder. Don't publish `.env`, `server.mjs`, `Dockerfile` or `tools/`. Use
  the payment-link route above for selling.
- **Node host** (Render, Railway, Fly, a VPS): `node server.mjs` with the env
  vars set, health check on `/api/health`.
- **Docker**: `docker build -t soundwave-site . && docker run -p 4173:4173 --env-file .env soundwave-site`.

Point your domain at it, then update the placeholders: `canonical` + `og:url` +
`og:image` in `index.html`, `Sitemap:` in `robots.txt`, and the `<loc>` values in
`sitemap.xml` (all use `https://soundwave.ai` today).

## Before you go live — the honest checklist

- [ ] `BRAND.supportEmail` and `salesEmail` are real inboxes that a person reads.
- [ ] The bracketed placeholders in **terms.html**, **privacy.html** and
      **refunds.html** are filled in (company name, address, jurisdiction) — and
      a lawyer has read the terms once. They are a starting point, not advice.
- [ ] The refund window in `refunds.html` matches what you'll actually honour.
- [ ] Prices in `config.js` match the Stripe prices to the cent.
- [ ] `DOWNLOADS` points at real, current installers (CI publishes them to
      GitHub Releases).
- [ ] A real test purchase: card → receipt email → `success.html` → cancel → the
      app drops to free limits.
- [ ] `SITE_URL` is your production domain, and Stripe knows it.
- [ ] The compare table still matches `server/src/lib/plans.ts` in the app.

## Notes for whoever maintains this

- **No fake proof.** There are no invented testimonials, logos or user counts on
  this site. Every claim maps to something the app really does; if you add a
  claim, make it true or don't add it.
- **Fonts** come from Google Fonts (Inter + JetBrains Mono). Self-host them from
  `assets/fonts/` if you'd rather not hand visitors' IPs to Google.
- **CSP**: `server.mjs` sets a strict policy. The JSON-LD block in `index.html`
  is allowed by hash — if you edit it, run `node tools/csp-hash.mjs` and paste
  the new hash into `baseHeaders()`. Nothing breaks if you forget; the crawler
  just ignores the structured data.
- **The OG card** is generated: `./tools/make-og-image.sh` (ImageMagick + the
  Inter fonts in `assets/fonts/`).
- **Voice samples** are copied from `frontend/public/voice-samples/`. If the app
  adds voices, copy the new MP3s here and add them to `VOICES` in `app.js`.
- **Accessibility**: every interactive element is a button or a link, the hero
  animation respects `prefers-reduced-motion`, and the page works with
  JavaScript disabled except for pricing (which needs it to read `config.js`).

## Optional: link the hosted app

The plans here are account plans, so buyers need somewhere to use them. Deploy the
repo's `frontend/` + `server/` (see the root README's deployment section), then set
`BRAND.webApp` in `config.js` to that URL — a "Sign in" link appears in the nav and
in the mobile menu automatically. Left empty, nothing is added: the Windows app
needs no account.
