/**
 * Soundwave AI — sales site behaviour.
 *
 * Plain ES modules, no build step. Everything that can be edited lives in
 * config.js; this file is the plumbing:
 *   1. nav + reveal animations
 *   2. the animated Command Center in the hero
 *   3. the real voice samples
 *   4. pricing cards + compare table rendered from config.js
 *   5. Stripe Checkout, with honest fallbacks when it isn't configured
 */

import {
  BRAND,
  DOWNLOADS,
  PAYMENTS,
  PLANS,
  COMPARISON,
  planById,
  formatPrice,
  yearlyTotal,
} from "./config.js";

/* ── Tiny helpers ───────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const money = (n) => formatPrice(n);

let toastTimer;
function toast(message, ms = 3600) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

function openDialog(title, bodyHtml) {
  const dlg = $("#dialog");
  $("#dialogTitle").textContent = title;
  $("#dialogBody").innerHTML = bodyHtml;
  dlg.hidden = false;
  const first = dlg.querySelector("[data-close-dialog].btn, .btn-primary");
  if (first) first.focus();
}

function closeDialog() {
  const dlg = $("#dialog");
  if (dlg) dlg.hidden = true;
}

/* ── 1. Nav ─────────────────────────────────────────────────────────────── */

const nav = $("#nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

const navToggle = $("#navToggle");
const navMobile = $("#navMobile");
navToggle?.addEventListener("click", () => {
  const open = navMobile.classList.toggle("open");
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
});
navMobile?.addEventListener("click", (e) => {
  if (e.target instanceof HTMLAnchorElement) {
    navMobile.classList.remove("open");
    navToggle.setAttribute("aria-expanded", "false");
  }
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 920) {
    navMobile?.classList.remove("open");
    navToggle?.setAttribute("aria-expanded", "false");
  }
});

/* Reveal on scroll */
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if ("IntersectionObserver" in window && !reduceMotion) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  $$(".reveal").forEach((el) => io.observe(el));
} else {
  $$(".reveal").forEach((el) => el.classList.add("in"));
}

/* ── 2. The Command Center in the hero ──────────────────────────────────── */

function initMock() {
  const mock = $("#mock");
  if (!mock) return;

  const steps = $$(".step", mock);
  const prog = $("#mockProg");
  const result = $("#mockResult");
  const captionWords = $$("#mockCaption span");
  const waveHost = $("#mockWave");

  /* waveform bars */
  const BAR_COUNT = 22;
  const bars = [];
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const bar = document.createElement("i");
    bar.style.height = "4px";
    waveHost.appendChild(bar);
    bars.push(bar);
  }

  let waveTimer;
  let captionTimer;
  let loopTimer;
  /* Every run gets a generation number. Anything the previous run left in
     flight (a pending sleep, a queued loop) checks it and gives up quietly —
     which is what lets the animation stop when the hero scrolls away and start
     again, cleanly, when it comes back. */
  let generation = 0;

  const setStep = (el, state) => el.setAttribute("data-state", state);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function startWave() {
    stopWave();
    const tick = () => {
      for (const bar of bars) {
        const h = 3 + Math.random() * (Math.random() > 0.72 ? 19 : 11);
        bar.style.height = `${h.toFixed(1)}px`;
      }
    };
    tick();
    waveTimer = setInterval(tick, 110);
  }

  function stopWave() {
    clearInterval(waveTimer);
    waveTimer = undefined;
  }

  function startCaptions() {
    stopCaptions();
    let i = 0;
    captionWords.forEach((w) => w.classList.remove("on"));
    const tick = () => {
      captionWords.forEach((w, idx) => w.classList.toggle("on", idx === i));
      i = (i + 1) % (captionWords.length + 2); // small pause before the loop
    };
    tick();
    captionTimer = setInterval(tick, 260);
  }

  function stopCaptions() {
    clearInterval(captionTimer);
    captionTimer = undefined;
  }

  function finish() {
    steps.forEach((el) => setStep(el, "done"));
    prog.style.width = "100%";
    result.classList.add("show");
    startWave();
    startCaptions();
  }

  function reset() {
    stopWave();
    stopCaptions();
    clearTimeout(loopTimer);
    result.classList.remove("show");
    prog.style.width = "0%";
    steps.forEach((el) => {
      el.removeAttribute("data-state");
    });
    captionWords.forEach((w) => w.classList.remove("on"));
    bars.forEach((b) => (b.style.height = "4px"));
  }

  async function run() {
    const mine = ++generation;
    reset();

    if (reduceMotion) {
      finish();
      return;
    }

    for (let i = 0; i < steps.length; i += 1) {
      const el = steps[i];
      setStep(el, "run");
      if (i === 1) startWave(); // narration makes sound
      await sleep(Number(el.dataset.ms) || 1200);
      if (mine !== generation) return;
      setStep(el, "done");
      prog.style.width = `${Math.round(((i + 1) / steps.length) * 100)}%`;
      await sleep(240);
      if (mine !== generation) return;
    }

    result.classList.add("show");
    startCaptions();

    loopTimer = setTimeout(() => {
      if (mine !== generation) return;
      stopWave();
      run();
    }, 6500);
  }

  function halt() {
    generation += 1;
    reset();
  }

  /* Only animate while the hero is on screen. */
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) run();
        else halt();
      },
      { threshold: 0.25 },
    );
    io.observe(mock);
    window.addEventListener("beforeunload", halt);
  } else {
    run();
  }
}

initMock();

/* ── 3. The voices (real MP3 samples that ship with the app) ────────────── */

/* Mirrors frontend/src/lib/voices.ts — the six samples published with the app. */
const VOICES = [
  { id: "en-US-JennyNeural", name: "Jenny", accent: "American", gender: "Female" },
  { id: "en-US-GuyNeural", name: "Guy", accent: "American", gender: "Male" },
  { id: "en-US-AnaNeural", name: "Ana", accent: "American", gender: "Female" },
  { id: "en-US-ChristopherNeural", name: "Christopher", accent: "American", gender: "Male" },
  { id: "en-GB-SoniaNeural", name: "Sonia", accent: "British", gender: "Female" },
  { id: "en-GB-RyanNeural", name: "Ryan", accent: "British", gender: "Male" },
];

function initVoices() {
  const grid = $("#voiceGrid");
  if (!grid) return;

  let audio = null;
  let current = null;

  const stop = () => {
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    current?.classList.remove("playing");
    current?.querySelector("use")?.setAttribute("href", "#i-play");
    current = null;
  };

  for (const voice of VOICES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "voice";
    card.setAttribute("aria-label", `Play the ${voice.name} sample`);
    card.innerHTML = `
      <span class="voice-play"><svg aria-hidden="true"><use href="#i-play" /></svg></span>
      <span class="voice-meta">
        <b>${voice.name}</b>
        <span>${voice.accent} · ${voice.gender}</span>
      </span>
      <span class="voice-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    `;

    card.addEventListener("click", () => {
      const isCurrent = current === card && audio && !audio.paused;
      if (isCurrent) {
        stop();
        return;
      }
      stop();
      audio = new Audio(`assets/voice-samples/${voice.id}.mp3`);
      audio.addEventListener("ended", stop);
      audio.addEventListener("error", () => {
        stop();
        toast("That sample couldn't load — it ships with the desktop app.");
      });
      audio.play().catch(() => {
        stop();
        toast("Your browser blocked playback. Tap again to hear the voice.");
      });
      card.classList.add("playing");
      card.querySelector("use")?.setAttribute("href", "#i-pause");
      current = card;
    });

    grid.appendChild(card);
  }

  /* One voice at a time, and never keep talking through a page change. */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
  });
}

initVoices();

/* ── 4. Pricing, from config.js ─────────────────────────────────────────── */

let interval = PAYMENTS.defaultInterval === "monthly" ? "monthly" : "annual";

const priceOf = (plan) => (interval === "annual" ? plan.price.annual : plan.price.monthly);

function savingPercent() {
  let best = 0;
  for (const plan of PLANS) {
    const { monthly, annual } = plan.price;
    if (monthly > 0 && annual > 0) best = Math.max(best, (1 - annual / monthly) * 100);
  }
  return Math.round(best);
}

function ctaFor(plan) {
  if (plan.action === "download") {
    return `<a class="btn btn-primary btn-lg btn-block" href="${DOWNLOADS.windowsInstaller || "#download"}" data-download="windowsInstaller">
      <svg aria-hidden="true"><use href="#i-download" /></svg> ${plan.cta}
    </a>`;
  }
  if (plan.action === "contact") {
    return `<a class="btn btn-ghost btn-lg btn-block" href="mailto:${BRAND.salesEmail}?subject=Soundwave%20AI%20-%20${encodeURIComponent(plan.name)}%20plan">
      <svg aria-hidden="true"><use href="#i-mail" /></svg> ${plan.cta}
    </a>`;
  }
  return `<button class="btn btn-primary btn-lg btn-block" type="button" data-buy="${plan.id}">
    ${plan.cta} <svg aria-hidden="true"><use href="#i-arrow-right" /></svg>
  </button>`;
}

function renderPricing() {
  const grid = $("#priceGrid");
  if (!grid) return;

  grid.innerHTML = PLANS.map((plan) => {
    const price = priceOf(plan);
    const free = price === 0;
    const annualSaving = !free && interval === "annual" && plan.price.monthly > 0;

    const priceBlock = free
      ? `<div class="plan-price">$0 <span class="per">forever</span></div>
         <div class="plan-note">${plan.priceNote ?? ""}</div>`
      : `<div class="plan-price">
           ${money(price)} <span class="per">/ month</span>
           ${annualSaving ? `<span class="plan-strike" title="Monthly price">${money(plan.price.monthly)}</span>` : ""}
         </div>
         <div class="plan-note">
           ${annualSaving ? `${yearlyTotal(plan)} billed once a year` : plan.priceNote ?? ""}
         </div>`;

    const missing = (plan.missing ?? [])
      .map(
        (m) =>
          `<li class="no"><svg aria-hidden="true"><use href="#i-x" /></svg><span>${m}</span></li>`,
      )
      .join("");

    return `
      <article class="plan ${plan.highlight ? "featured" : ""}">
        ${plan.badge ? `<span class="plan-badge">${plan.badge}</span>` : ""}
        <h3 class="plan-name">${plan.name}</h3>
        <p class="plan-tagline">${plan.tagline}</p>
        ${priceBlock}
        <div class="plan-cta">${ctaFor(plan)}</div>
        <ul class="plan-list">
          ${plan.features
            .map(
              (f) =>
                `<li><svg aria-hidden="true"><use href="#i-check" /></svg><span>${f}</span></li>`,
            )
            .join("")}
          ${missing}
        </ul>
      </article>
    `;
  }).join("");

  /* Compare table */
  const head = $("#compareHead");
  const body = $("#compareBody");
  if (head && body) {
    head.innerHTML =
      `<th scope="col">What you get</th>` +
      PLANS.map(
        (p) => `<th scope="col" class="${p.highlight ? "col-pro" : ""}">${p.name}</th>`,
      ).join("");
    body.innerHTML = COMPARISON.map(
      (row) =>
        `<tr><td>${row.label}</td>` +
        PLANS.map(
          (p) =>
            `<td class="${p.highlight ? "col-pro" : ""}">${row.values[p.id]}</td>`,
        ).join("") +
        `</tr>`,
    ).join("");
  }

  /* Small print + saving label */
  const note = $("#priceNote");
  if (note) note.textContent = PAYMENTS.note ?? "";
  const saveTag = $("#saveTag");
  if (saveTag) {
    const pct = savingPercent();
    const label = PAYMENTS.annualSavingLabel || (pct ? `Save ${pct}%` : "");
    if (label) saveTag.textContent = label;
    else saveTag.hidden = true;
  }

  /* Billing toggle state */
  $$(".billing-toggle button").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.interval === interval));
  });
}

$$(".billing-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    interval = btn.dataset.interval === "monthly" ? "monthly" : "annual";
    renderPricing();
  });
});

renderPricing();

/* ── 5. Checkout ────────────────────────────────────────────────────────── */

function busy(button, on, label) {
  if (!button) return;
  if (on) {
    button.dataset.label = button.dataset.label || button.innerHTML;
    button.setAttribute("aria-disabled", "true");
    button.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span> Starting checkout…`;
  } else {
    button.removeAttribute("aria-disabled");
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
  if (label) button.setAttribute("aria-label", label);
}

/** Only ever follow an absolute, web-ish URL — never a relative one, and never
 *  a javascript:/data: URL, whatever ends up in config.js or in an API reply. */
function safeUrl(value) {
  try {
    const url = new URL(String(value), window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function goTo(url) {
  const safe = safeUrl(url);
  if (!safe) {
    toast("That checkout link looked wrong, so nothing happened. Please try again.");
    return;
  }
  window.location.href = safe;
}

function notConfigured(plan) {
  const isStatic = window.location.protocol === "file:";
  openDialog(
    "Payments aren't connected yet",
    `<p>This deployment has no Stripe keys, so <b>${plan.name}</b> can't be bought
     right now — and the button won't pretend otherwise.</p>
     <p style="margin-top:12px">To switch checkout on, set
     <code>STRIPE_SECRET_KEY</code> plus the price IDs
     (<code>STRIPE_PRICE_${plan.id}_MONTHLY</code>, <code>STRIPE_PRICE_${plan.id}_ANNUAL</code>)
     and restart <code>node server.mjs</code> — or paste Stripe Payment Links into
     <code>PAYMENTS.links</code> in <code>config.js</code>${isStatic ? " (they work with no server at all)" : ""}.
     The README in <code>site/</code> has both, step by step.</p>
     <p style="margin-top:12px">Meanwhile the free plan is a full install — not a trial.</p>`,
  );
}

async function startCheckout(planId, button) {
  const plan = planById(planId);
  if (!plan) return;

  busy(button, true);
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: planId, interval }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.url === "string" && data.url) {
        goTo(data.url);
        return;
      }
    } else if (res.status === 503 || res.status === 501) {
      /* Server is up but has no keys — fall through to a payment link if we
         have one, otherwise say so. */
      const body = await res.json().catch(() => null);
      if (body?.code && body.code !== "NOT_CONFIGURED") {
        busy(button, false);
        toast(body.message || "Checkout couldn't start. Please try again.");
        return;
      }
    }
  } catch {
    /* No server (static hosting) or it's down: try the payment link below. */
  }

  const link = PAYMENTS.links?.[planId]?.[interval];
  if (link) {
    goTo(link);
    return;
  }

  busy(button, false);
  notConfigured(plan);
}

document.addEventListener("click", (event) => {
  const buy = event.target.closest("[data-buy]");
  if (buy) {
    event.preventDefault();
    startCheckout(buy.dataset.buy, buy);
  }
  if (event.target.closest("[data-close-dialog]")) closeDialog();
});

$("#dialog")?.addEventListener("click", (e) => {
  if (e.target.id === "dialog") closeDialog();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDialog();
});

/* ── 6. Download links, emails, footer ──────────────────────────────────── */

/* A "Sign in" link, only when a hosted app URL is configured. Plans are
   account plans, so this is where a paying customer goes to use one. */
(function addSignInLink() {
  const href = safeUrl(BRAND.webApp);
  if (!href) return;

  const navCta = document.querySelector(".nav-cta");
  if (navCta) {
    const link = document.createElement("a");
    link.className = "btn btn-ghost btn-sm";
    link.href = href;
    link.textContent = "Sign in";
    navCta.insertBefore(link, navCta.firstChild);
  }

  const mobile = document.querySelector(".nav-mobile");
  if (mobile) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = "Sign in";
    mobile.insertBefore(link, mobile.querySelector(".btn"));
  }
})();

$$("[data-download]").forEach((el) => {
  const url = DOWNLOADS[el.dataset.download];
  if (!url) {
    /* Nothing to point at: hide it rather than link nowhere. */
    el.hidden = true;
    return;
  }
  el.setAttribute("href", url);
  el.setAttribute("rel", "noopener");
  if (!url.startsWith("#")) el.setAttribute("target", "_blank");
});

const versionNote = $("#versionNote");
if (versionNote) versionNote.textContent = DOWNLOADS.versionNote ?? "";

const mailSubjects = {
  support: "Soundwave AI — support",
  sales: "Soundwave AI — a question before I buy",
};

$$("[data-mail]").forEach((el) => {
  const kind = el.dataset.mail;
  const address = kind === "sales" ? BRAND.salesEmail : BRAND.supportEmail;
  el.setAttribute(
    "href",
    `mailto:${address}?subject=${encodeURIComponent(mailSubjects[kind] ?? "Soundwave AI")}`,
  );
});

$$("[data-link]").forEach((el) => {
  const url = BRAND[el.dataset.link];
  if (url) {
    el.setAttribute("href", url);
    el.setAttribute("rel", "noopener");
    el.setAttribute("target", "_blank");
  } else {
    el.hidden = true;
  }
});

const dialogMail = $("#dialogMail");
if (dialogMail) {
  dialogMail.setAttribute(
    "href",
    `mailto:${BRAND.salesEmail}?subject=${encodeURIComponent("Soundwave AI — buying")}`,
  );
}

const footTagline = $("#footTagline");
if (footTagline) footTagline.textContent = BRAND.tagline;

const copyright = $("#copyright");
if (copyright) {
  copyright.textContent = `© ${new Date().getFullYear()} ${BRAND.copyright}. All rights reserved.`;
}

if (!document.querySelector('link[rel="canonical"]')) {
  /* nothing to do — kept for clarity that canonical is set in the HTML */
}

/* Expose a tiny API for the legal pages and for your own scripts. */
window.SoundwaveSite = { PLANS, PAYMENTS, BRAND, startCheckout, toast };
