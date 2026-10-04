/**
 * The thank-you page asks the checkout server what actually happened, instead
 * of printing "your payment went through" and hoping it did. If the server
 * isn't there (static hosting), the page says so plainly and points at the
 * Stripe receipt, which is the only real source of truth anyway.
 */

import { PLANS, formatPrice } from "./config.js";

const $ = (sel) => document.querySelector(sel);

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session_id");
const planFromUrl = (params.get("plan") || "").toUpperCase();

const lede = $("#successLede");
const receipt = $("#receipt");
const unknown = $("#receiptUnknown");

function showReceipt({ plan, interval, amount, currency, email }) {
  const def = PLANS.find((p) => p.id === plan);
  $("#rPlan").textContent = def ? `${def.name} plan${interval ? ` · ${interval}` : ""}` : "Your plan";
  $("#rAmount").textContent =
    typeof amount === "number" && amount > 0
      ? `${formatPrice(amount / 100, currency || "USD")} paid`
      : "Payment complete";
  $("#rEmail").textContent = email ? `receipt sent to ${email}` : "receipt by email";
  receipt.hidden = false;
}

if (!sessionId) {
  /* Someone landed here directly (or a payment link with no session id). */
  if (lede) {
    lede.textContent =
      "If you just paid, Stripe has emailed your receipt and your plan is active — install the app below and get started.";
  }
  if (unknown) unknown.hidden = false;
  if (planFromUrl) {
    const def = PLANS.find((p) => p.id === planFromUrl);
    if (def) showReceipt({ plan: def.id });
  }
} else {
  try {
    const res = await fetch(`/api/checkout/session?id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (data.paid) {
      if (lede) {
        lede.innerHTML = `Payment received${
          data.email ? ` and receipt sent to <b style="color:var(--text-soft)">${data.email}</b>` : ""
        }. Here's the fast way to your first Short.`;
      }
      showReceipt({
        plan: data.plan,
        interval: data.interval,
        amount: data.amountTotal,
        currency: data.currency,
        email: data.email,
      });
    } else {
      if (lede) {
        lede.textContent =
          "Stripe hasn't finished confirming this payment yet. If you were charged, give it a minute and refresh — or open your receipt email.";
      }
      if (unknown) unknown.hidden = false;
    }
  } catch {
    if (lede) {
      lede.textContent =
        "Payment complete — Stripe has your receipt, and your plan is active.";
    }
    if (unknown) unknown.hidden = false;
    if (planFromUrl) {
      const def = PLANS.find((p) => p.id === planFromUrl);
      if (def) showReceipt({ plan: def.id });
    }
  }
}
