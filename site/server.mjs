#!/usr/bin/env node
/**
 * Soundwave AI — sales site server.
 *
 * Two jobs, no dependencies (Node 18+ only):
 *   1. Serve this folder as a static site, properly (gzip, caching, clean URLs).
 *   2. Create real Stripe Checkout Sessions for the paid plans, so a Buy button
 *      takes money — prices, taxes, receipts and cancellations all live in
 *      Stripe, and nothing about your card touches this process.
 *
 * Run it with the keys set:
 *   STRIPE_SECRET_KEY=sk_live_...            (or sk_test_... while you test)
 *   STRIPE_PRICE_PRO_MONTHLY=price_...       etc. — see .env.example
 *   SITE_URL=https://soundwave.ai            (basename for success/cancel URLs)
 *   node server.mjs
 *
 * With no keys it still serves the site and answers checkout honestly with a
 * 503 NOT_CONFIGURED, which the page turns into a short explanation instead of
 * a broken button. That is deliberate: a store that silently fails to charge
 * is worse than one that says it isn't open yet.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PAYMENTS, PLANS, planById } from "./config.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY?.trim() || "";
const STRIPE_API = process.env.STRIPE_API_BASE?.trim() || "https://api.stripe.com";
/** "subscription" (default) or "payment" for one-time prices. */
const STRIPE_MODE = process.env.STRIPE_MODE?.trim() || "subscription";
/** Where Stripe sends people back to. Defaults to the request's own origin. */
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");

/* ── Helpers ────────────────────────────────────────────────────────────── */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg)/;

const log = (...args) => console.log(`[site]`, ...args);

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(res.req?.method === "HEAD" ? undefined : payload);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8" });
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("BAD_JSON");
  }
}

/* Security headers that don't get in the way of embedding or of Google Fonts.
   Note: no X-Frame-Options and no CSP frame-ancestors — a marketing page is
   meant to be embeddable, and the preview environment frames it too.        */
function baseHeaders() {
  return {
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      /* The hash is the JSON-LD block in index.html. If you edit that block,
         run `node tools/csp-hash.mjs` and paste the new hash here — otherwise
         the structured data is simply ignored by crawlers (nothing breaks). */
      "script-src 'self' 'sha256-GOV+PkTSMNV+qRqDWdmK0pmc6wN9SlCtdYDsgbLCJoE='",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "media-src 'self'",
      "connect-src 'self'",
      "form-action 'self' https://checkout.stripe.com",
      "base-uri 'none'",
    ].join("; "),
  };
}

/* ── Stripe ─────────────────────────────────────────────────────────────── */

function priceIdFor(planId, interval) {
  const key = `STRIPE_PRICE_${planId}_${interval.toUpperCase()}`;
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  return PAYMENTS.priceIds?.[planId]?.[interval]?.trim() || "";
}

async function stripeRequest(path, params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") body.append(key, String(value));
  }
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-06-20",
    },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.error?.message || `Stripe answered ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.stripe = data?.error;
    throw err;
  }
  return data;
}

async function stripeGet(path) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": "2024-06-20" },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Stripe answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* A tiny in-memory rate limit: 20 checkout attempts per IP per 10 minutes. */
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 20;

function rateLimited(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_ATTEMPTS) return true;
  list.push(now);
  attempts.set(ip, list);
  if (attempts.size > 5000) attempts.clear(); // keeps the map from growing forever
  return false;
}

function originFor(req) {
  if (SITE_URL) return SITE_URL;
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${String(proto).split(",")[0]}://${host}`;
}

async function handleCheckout(req, res) {
  const ip = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  if (rateLimited(ip)) {
    return sendJson(res, 429, {
      code: "RATE_LIMITED",
      message: "Too many checkout attempts from this address. Try again in a few minutes.",
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, {
      code: e.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "BAD_JSON",
      message: "That request couldn't be read.",
    });
  }

  const planId = String(body.plan ?? "").toUpperCase();
  const interval = body.interval === "monthly" ? "monthly" : "annual";
  const plan = planById(planId);

  if (!plan || plan.action !== "checkout") {
    return sendJson(res, 400, {
      code: "UNKNOWN_PLAN",
      message: `${planId || "That plan"} isn't something this site can sell.`,
    });
  }

  if (!STRIPE_KEY) {
    return sendJson(res, 503, {
      code: "NOT_CONFIGURED",
      message:
        "Stripe isn't configured on this deployment. Set STRIPE_SECRET_KEY and the STRIPE_PRICE_* ids, then restart the server.",
    });
  }

  const priceId = priceIdFor(planId, interval);
  if (!priceId) {
    return sendJson(res, 503, {
      code: "NOT_CONFIGURED",
      message: `No Stripe price id for ${plan.name} (${interval}). Set STRIPE_PRICE_${planId}_${interval.toUpperCase()}.`,
    });
  }

  const origin = originFor(req);
  try {
    const session = await stripeRequest("/v1/checkout/sessions", {
      mode: STRIPE_MODE === "payment" ? "payment" : "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cancel`,
      allow_promotion_codes: "true",
      billing_address_collection: "auto",
      client_reference_id: planId,
      "metadata[plan]": planId,
      "metadata[interval]": interval,
      "subscription_data[metadata][plan]": planId,
      "subscription_data[metadata][interval]": interval,
    });
    log(`checkout ${planId}/${interval} → ${session.id}`);
    return sendJson(res, 200, { url: session.url, id: session.id });
  } catch (e) {
    log("stripe error:", e.message);
    return sendJson(res, e.status && e.status < 500 ? 400 : 502, {
      code: "STRIPE_ERROR",
      message: "Stripe couldn't start that checkout. Please try again in a moment.",
    });
  }
}

/** Used by success.html to show a real confirmation instead of a guess. */
async function handleSession(req, res, url) {
  const id = url.searchParams.get("id") || "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) {
    return sendJson(res, 400, { code: "BAD_SESSION", message: "That session id doesn't look right." });
  }
  if (!STRIPE_KEY) {
    return sendJson(res, 503, { code: "NOT_CONFIGURED", message: "Stripe isn't configured here." });
  }
  try {
    const session = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(id)}`);
    const paid =
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required" ||
      session.status === "complete";
    return sendJson(res, 200, {
      paid,
      status: session.status,
      paymentStatus: session.payment_status,
      email: session.customer_details?.email || null,
      amountTotal: session.amount_total ?? null,
      currency: session.currency || null,
      plan: session.metadata?.plan || null,
      interval: session.metadata?.interval || null,
    });
  } catch (e) {
    return sendJson(res, 404, { code: "NOT_FOUND", message: "That checkout session wasn't found." });
  }
}

/* ── Static files ───────────────────────────────────────────────────────── */

const gzipCache = new Map(); // path+size → gzipped buffer (small site, fine)

function resolveFile(urlPath) {
  let pathname = decodeURIComponent(urlPath.split("?")[0]);
  if (pathname.endsWith("/")) pathname += "index.html";
  const clean = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidates = [clean];
  if (!extname(clean)) candidates.push(`${clean}.html`, join(clean, "index.html"));

  for (const candidate of candidates) {
    const filePath = resolve(join(ROOT, candidate));
    /* Never serve anything outside this folder, whatever the URL says. */
    if (!filePath.startsWith(ROOT + sep)) continue;
    if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
  }
  return null;
}

async function serveStatic(req, res, url) {
  const file = resolveFile(url.pathname);
  if (!file) {
    const notFound = join(ROOT, "404.html");
    if (existsSync(notFound)) {
      const html = await readFile(notFound);
      return send(res, 404, html, {
        "Content-Type": MIME[".html"],
        "Cache-Control": "no-cache",
        ...baseHeaders(),
      });
    }
    return send(res, 404, "404 — not found", { "Cache-Control": "no-cache", ...baseHeaders() });
  }

  const ext = extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const stats = statSync(file);
  const etag = `W/"${stats.size}-${Number(stats.mtimeMs).toString(36)}"`;

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
    return res.end();
  }

  const headers = {
    "Content-Type": type,
    ETag: etag,
    /* HTML is always revalidated so a price change is never stale; assets get
       a short cache because they are tiny and versioned by content anyway. */
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    ...baseHeaders(),
  };

  const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  if (acceptsGzip && COMPRESSIBLE.test(type) && stats.size > 1024) {
    const key = `${file}:${stats.size}`;
    let gz = gzipCache.get(key);
    if (!gz) {
      gz = gzipSync(await readFile(file), { level: 6 });
      gzipCache.set(key, gz);
    }
    headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = gz.length;
    headers["Vary"] = "Accept-Encoding";
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    return res.end(gz);
  }

  headers["Content-Length"] = stats.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

/* ── Router ─────────────────────────────────────────────────────────────── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const route = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (route === "/api/health") {
      const configured = Boolean(STRIPE_KEY);
      return sendJson(res, 200, {
        ok: true,
        stripe: configured,
        mode: STRIPE_MODE,
        priceIds: Object.fromEntries(
          PLANS.filter((p) => p.action === "checkout").map((p) => [
            p.id,
            { monthly: Boolean(priceIdFor(p.id, "monthly")), annual: Boolean(priceIdFor(p.id, "annual")) },
          ]),
        ),
      });
    }

    if (route === "/api/checkout" || route === "/api/checkout/session") {
      if (req.method === "POST" && route === "/api/checkout") return await handleCheckout(req, res);
      if (req.method === "GET" && route === "/api/checkout/session") return await handleSession(req, res, url);
      return sendJson(res, 405, { code: "METHOD", message: "Not that method." });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, "Method not allowed");
    }

    return await serveStatic(req, res, url);
  } catch (e) {
    log("unhandled error:", e?.stack || e);
    if (!res.headersSent) send(res, 500, "Something went wrong on the server.");
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const lines = [
    "",
    "  Soundwave AI — sales site",
    `  ▸ http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`,
    STRIPE_KEY
      ? `  ▸ Stripe: connected (${STRIPE_KEY.slice(0, 7)}…, ${STRIPE_MODE} mode)`
      : "  ▸ Stripe: not configured — Buy buttons explain that instead of failing silently",
    SITE_URL ? `  ▸ Site URL: ${SITE_URL}` : "  ▸ Site URL: using the request's own origin",
    "",
  ];
  console.log(lines.join("\n"));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("shutting down");
    server.close(() => process.exit(0));
  });
}
