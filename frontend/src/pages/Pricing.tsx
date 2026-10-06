import { useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Minus } from "lucide-react";
import { Navbar } from "../components/layout/Navbar";
import { cn } from "../lib/cn";

// ── The full pricing page ───────────────────────────────────────────────────
// Reached from the landing page's "View full pricing", so it says the same
// thing: what a plan buys is minutes of video and clips, the work happens on
// the person's PC, and the free tier is the same shape as the category's.
// Prices and limits mirror server/src/lib/plans.ts — change them there first.

interface FeatureRow {
  label: string;
  free: string | boolean;
  pro: string | boolean;
  enterprise: string | boolean;
}

const FEATURES: FeatureRow[] = [
  { label: "Video processed per month", free: "60 minutes", pro: "300 minutes", enterprise: "1,200 minutes" },
  { label: "Clips per month", free: "30", pro: "Unlimited", enterprise: "Unlimited" },
  { label: "Finished clips kept for", free: "7 days", pro: "As long as you like", enterprise: "As long as you like" },
  { label: "Watermark", free: "Yes", pro: "No", enterprise: "No" },
  { label: "Caption styles & brand kit", free: "All five styles", pro: "All five styles", enterprise: "All five styles" },
  { label: "Export resolution", free: "720p", pro: "Up to 1080p", enterprise: "Up to 4K" },
  { label: "Voice studio (10 neural voices)", free: "Yes", pro: "Yes", enterprise: "Yes" },
  { label: "Voice cloning", free: true, pro: true, enterprise: true },
  { label: "Publish & schedule to YouTube", free: true, pro: true, enterprise: true },
  { label: "Performance read-back", free: true, pro: true, enterprise: true },
  { label: "Cloud project save", free: "Local only", pro: true, enterprise: true },
  { label: "API access", free: false, pro: false, enterprise: true },
  { label: "Export queue", free: "Standard", pro: "Priority", enterprise: "Priority" },
  { label: "Dedicated support", free: false, pro: false, enterprise: true },
];

const FAQS = [
  {
    q: "Where does my video actually go?",
    a: "Nowhere. The clipping, the captions, the narration and the PC agent all run on your Windows PC using ffmpeg, whisper.cpp and the voice models Soundwave installs once. The only thing that leaves your machine is the Short you explicitly publish, uploaded straight to your own YouTube channel.",
  },
  {
    q: "What is metered, then?",
    a: "Minutes of video processed and clips made, per calendar month. A 60-minute episode costs 60 of your minutes whether it produces 5 clips or 20 — the input length, not the output, which is how the rest of the category counts it too. Source files you never clip cost nothing.",
  },
  {
    q: "What happens when I run out?",
    a: "The run is refused before it starts, with the date your allowance resets — so nothing is half-rendered and nothing is wasted. Upgrade and the next clip works immediately; clips already made stay yours (on Free, for the seven days they were always going to be kept).",
  },
  {
    q: "Do I need an API key or an account with anyone else?",
    a: "You link a Google account to use the app, and the assistant runs on a free AI Studio key you create and own. Nothing else — no per-character billing, no cloud storage bill, no GPU rental. That is what makes the Founder lifetime possible.",
  },
  {
    q: "Does it have to be running to post my clip?",
    a: "Yes. The schedule lives on your PC, so Soundwave has to be open at that moment (the window can be closed to the tray — it keeps working and can start with Windows). It is the honest price of keeping your footage local.",
  },
  {
    q: "I subscribed before the plans changed. What happens to me?",
    a: "Nothing. Stripe keeps billing the price you signed up at, and the Billing tab says \"Price held\" so it is clear that is deliberate. Only new subscriptions pay today's prices.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes, from the billing portal. Your plan runs to the end of the period you paid for, and anything you already exported is yours — it was made on your machine.",
  },
];

function Cell({ value }: { value: string | boolean }) {
  if (value === false) return <Minus className="mx-auto h-4 w-4 text-gray-600" />;
  if (value === true) return <Check className="mx-auto h-5 w-5 text-success" />;
  return <span className="text-sm text-gray-300">{value}</span>;
}

export function Pricing() {
  const [annual, setAnnual] = useState(false);

  const plans = [
    {
      name: "Free",
      monthly: 0,
      desc: "An hour of video a month, and the whole studio to try it with.",
      cta: "Open Soundwave",
      to: "/agent",
      highlight: false,
      badge: null,
    },
    {
      name: "Pro",
      monthly: 15,
      annual: 12,
      desc: "300 minutes of video, unlimited clips — the tier a weekly show needs.",
      cta: "Subscribe Now",
      to: "/agent",
      highlight: true,
      badge: "MOST POPULAR",
    },
    {
      name: "Enterprise",
      monthly: 39,
      annual: 31.2,
      desc: "1,200 minutes, 4K exports, API access. For the ones who never stop.",
      cta: "Contact Sales",
      to: "/agent",
      highlight: false,
      badge: null,
    },
  ];

  return (
    <div className="min-h-screen bg-navy">
      <Navbar />
      <div className="mx-auto max-w-6xl px-4 pb-24 pt-32 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-4xl font-extrabold text-white sm:text-5xl">Simple, honest pricing</h1>
          <p className="mx-auto mt-4 max-w-2xl text-gray-400">
            Priced in minutes of video, like everything else in this category — except these minutes are processed on your
            own PC. Your footage is never uploaded, so there is no storage bill to pass on and no reason to meter your
            clips.
          </p>

          <div className="mt-8 inline-flex items-center gap-3 rounded-full border border-gray-700 bg-panel p-1">
            <button
              onClick={() => setAnnual(false)}
              className={cn("rounded-full px-4 py-1.5 text-sm font-medium transition-all", !annual ? "bg-gray-800 text-white" : "text-gray-400")}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={cn("rounded-full px-4 py-1.5 text-sm font-medium transition-all", annual ? "bg-gray-800 text-white" : "text-gray-400")}
            >
              Annual <span className="text-emerald-400">two months free</span>
            </button>
          </div>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {plans.map((p) => {
            const price = annual && "annual" in p && p.annual ? p.annual : p.monthly;
            return (
              <div
                key={p.name}
                className={cn(
                  "relative rounded-card border p-7",
                  p.highlight ? "border-transparent bg-panel shadow-glow lg:scale-105" : "border-gray-800 bg-panel",
                )}
              >
                {p.badge && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-blue-500 to-violet-500 px-3 py-0.5 text-xs font-semibold text-white">
                    {p.badge}
                  </div>
                )}
                <p className="text-lg font-semibold text-white">{p.name}</p>
                <p className="mt-1 min-h-[2.5rem] text-sm text-gray-400">{p.desc}</p>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-5xl font-bold text-white">${price.toFixed(price % 1 === 0 ? 0 : 2)}</span>
                  <span className="text-gray-500">/month</span>
                </div>
                {annual && p.monthly > 0 && (
                  <p className="mt-1 text-xs text-emerald-400">Billed annually (${(price * 12).toFixed(0)}/yr)</p>
                )}
                {!annual && p.monthly > 0 && "annual" in p && p.annual && (
                  <p className="mt-1 text-xs text-gray-500">${p.annual}/mo if billed yearly</p>
                )}
                <Link
                  to={p.to}
                  className={cn(
                    "mt-6 inline-flex h-11 w-full items-center justify-center rounded-btn font-semibold transition-all duration-200",
                    p.highlight
                      ? "bg-gradient-to-r from-blue-500 to-violet-500 text-white hover:from-blue-400 hover:to-violet-400"
                      : "border border-gray-600 text-gray-200 hover:border-blue-500/70 hover:text-white",
                  )}
                >
                  {p.cta}
                </Link>
              </div>
            );
          })}
        </div>

        <div className="mx-auto mt-8 max-w-3xl rounded-card border border-blue-500/30 bg-blue-500/[0.06] p-5 text-center">
          <p className="text-sm text-gray-300">
            <span className="font-semibold text-white">Founder lifetime — $199, once, the first 100 buyers.</span> Everything
            Enterprise gives, for good, with no renewal. It is only possible because your marginal cost here is your own
            Google key and your own CPU — the one thing a cloud clipper can't copy.
          </p>
          <Link to="/settings/billing" className="mt-3 inline-block text-sm font-medium text-blue-300 hover:text-blue-200">
            See how many seats are left →
          </Link>
        </div>

        {!annual && (
          <p className="mt-6 text-center text-sm text-gray-500">
            Subscribed before October 2026? You keep the price you signed up at — nothing to do.
          </p>
        )}

        {/* Feature comparison */}
        <div className="mt-16 overflow-x-auto rounded-card border border-gray-800 bg-panel">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-4 text-sm font-medium text-gray-400">Feature</th>
                {["Free", "Pro", "Enterprise"].map((n) => (
                  <th key={n} className="px-5 py-4 text-center text-sm font-semibold text-white">{n}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((f) => (
                <tr key={f.label} className="border-b border-gray-800/60 last:border-0">
                  <td className="px-5 py-3.5 text-sm text-gray-300">{f.label}</td>
                  <td className="px-5 py-3.5 text-center"><Cell value={f.free} /></td>
                  <td className="px-5 py-3.5 text-center bg-blue-500/5"><Cell value={f.pro} /></td>
                  <td className="px-5 py-3.5 text-center"><Cell value={f.enterprise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-center text-xs text-gray-500">
          Character limits still exist under the hood as a fair-use guard, but nothing you buy is measured in characters.
        </p>

        {/* FAQ */}
        <div className="mx-auto mt-16 max-w-3xl">
          <h2 className="text-center text-3xl font-bold text-white">Frequently asked questions</h2>
          <div className="mt-8 space-y-3">
            {FAQS.map((f) => (
              <FaqItem key={f.q} q={f.q} a={f.a} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-card border border-gray-800 bg-panel">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="font-medium text-white">{q}</span>
        <ChevronDown className={cn("h-5 w-5 shrink-0 text-gray-400 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <p className="px-5 pb-4 text-sm leading-relaxed text-gray-400">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
