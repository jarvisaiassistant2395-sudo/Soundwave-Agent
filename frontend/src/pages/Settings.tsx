import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  Brain,
  CheckCircle2,
  CreditCard,
  Database,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Mic,
  MonitorSmartphone,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Sunrise,
  Trash2,
  TriangleAlert,
  User,
} from "lucide-react";
import { useAuth } from "../store/auth";
import { toast } from "../store/toast";
import { AgentModeChips } from "../components/agent/AgentModePicker";
import { http } from "../lib/api";
import { cn } from "../lib/cn";
import { formatNumber } from "../lib/format";
import { PLANS, type Plan } from "../lib/plans";
import { Button } from "../components/ui/Button";
import { KokoroSetupNotice } from "../components/KokoroSetupNotice";
import { TextField } from "../components/ui/TextField";
import { Select } from "../components/ui/Select";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { AGENT_VOICES, agentVoiceLabel, loadAgentVoice, saveAgentVoice } from "../lib/voices";
import { useLocalVoices } from "../lib/localVoices";
import { Toggle } from "../components/ui/Toggle";
import {
  fetchVoiceInputStatus,
  loadVoicePrefs,
  saveVoicePrefs,
  startRecording,
  transcribeRecording,
  type Recorder,
  type VoiceInputStatus,
  type VoicePrefs,
} from "../lib/voiceInput";
import { getDesktop, hotkeyLabel, openInBrowser, type DesktopSettings, type DesktopState } from "../lib/desktop";
import { notifyUser } from "../lib/notify";
import { PhoneTab } from "./settings/PhoneTab";
import { BrainTab } from "./settings/BrainTab";
import { MorningTab } from "./settings/MorningTab";

const TABS = [
  { id: "profile", label: "Profile", icon: <User className="h-4 w-4" /> },
  { id: "brain", label: "Brain", icon: <Brain className="h-4 w-4" /> },
  { id: "billing", label: "Billing", icon: <CreditCard className="h-4 w-4" /> },
  { id: "preferences", label: "Preferences", icon: <SlidersHorizontal className="h-4 w-4" /> },
  { id: "voice", label: "Voice & Desktop", icon: <Mic className="h-4 w-4" /> },
  { id: "phone", label: "Phone", icon: <Smartphone className="h-4 w-4" /> },
  { id: "morning", label: "Morning Setup", icon: <Sunrise className="h-4 w-4" /> },
];

export function Settings() {
  const location = useLocation();
  const navigate = useNavigate();
  const { refreshQuota } = useAuth();
  const active = location.pathname.includes("/brain")
    ? "brain"
    : location.pathname.includes("/billing")
    ? "billing"
    : location.pathname.includes("/preferences")
      ? "preferences"
      : location.pathname.includes("/voice")
        ? "voice"
        : location.pathname.includes("/phone")
          ? "phone"
          : location.pathname.includes("/morning")
            ? "morning"
            : "profile";

  useEffect(() => {
    void refreshQuota();
  }, [refreshQuota]);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-bold text-white">Settings</h1>
      <p className="mt-1 text-sm text-gray-400">Manage your account, the agent's brain, billing, and preferences.</p>

      <div className="mt-6 flex gap-1 overflow-x-auto rounded-card border border-gray-800 bg-gray-900/60 p-1" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            onClick={() => navigate(`/settings/${t.id === "profile" ? "" : t.id}`)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-all duration-200",
              active === t.id ? "bg-gradient-to-r from-blue-500/20 to-violet-500/20 text-white" : "text-gray-400 hover:text-gray-200",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6 space-y-5">
        {active === "profile" && <ProfileTab />}
        {active === "brain" && <BrainTab />}
        {active === "billing" && <BillingTab />}
        {active === "preferences" && <PreferencesTab />}
        {active === "voice" && <VoiceDesktopTab />}
        {active === "phone" && <PhoneTab />}
        {active === "morning" && <MorningTab />}
      </div>
    </div>
  );
}

// ── Profile ─────────────────────────────────────────────────────────────────
function ProfileTab() {
  const { user, setUser, loadSession } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");

  const saveProfile = async () => {
    setSaving(true);
    try {
      const updated = await http.put<{ id: string; name: string; email: string; plan: Plan; avatarUrl: string | null }>("/user/profile", { name });
      setUser(updated);
      toast.success("Profile updated");
    } catch (e) {
      toast.error("Update failed", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deleteAccount = async () => {
    try {
      await http.del("/user/account", { confirmEmail: deleteEmail });
      toast.success("Account deleted", "We'll keep your data for 30 days in case you change your mind.");
      await loadSession();
    } catch (e) {
      toast.error("Delete failed", (e as Error).message);
    }
  };

  const signOutOthers = async () => {
    try {
      await http.del("/auth/sessions");
      toast.success("Signed out", "All other sessions have been signed out.");
      await loadSession();
    } catch (e) {
      toast.error("Failed", (e as Error).message);
    }
  };

  return (
    <>
      <Card title="Profile" icon={<User className="h-4 w-4" />}>
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-violet-500 text-xl font-bold text-white">
            {(user?.name ?? "U").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-white">{user?.name}</p>
            <p className="truncate text-sm text-gray-500">{user?.email}</p>
          </div>
        </div>
        <div className="mt-5 space-y-4">
          <TextField label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextField
            label="Google account"
            value={user?.email ?? ""}
            disabled
            hint="This is the Google account Soundwave is linked to on this PC — it is how you sign in, so there is no password to set."
          />
          <Button onClick={saveProfile} loading={saving}>Save changes</Button>
        </div>
      </Card>

      <Card title="Signed in on" icon={<ShieldCheck className="h-4 w-4" />}>
        <div className="space-y-4">
          <div className="border-t border-gray-800 pt-4">
            <p className="text-sm text-gray-400">Sign out everything except this window:</p>
            <Button onClick={signOutOthers} variant="outline" className="mt-2">Sign out all other sessions</Button>
          </div>
        </div>
      </Card>

      <Card title="Danger zone" icon={<Trash2 className="h-4 w-4" />} className="border-red-500/30">
        <p className="text-sm text-gray-400">Deleting your account removes your cloud projects. We keep a 30-day recovery window.</p>
        <Button variant="danger" className="mt-3" onClick={() => setDeleteOpen(true)}>Delete account</Button>
      </Card>

      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete account" description="This action is permanent after the 30-day recovery period.">
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Type <span className="text-gray-200">{user?.email}</span> to confirm.
          </p>
          <TextField label="Your Google account" value={deleteEmail} onChange={(e) => setDeleteEmail(e.target.value)} inputMode="email" autoComplete="off" />
          <Button fullWidth variant="danger" onClick={deleteAccount} disabled={deleteEmail.trim().toLowerCase() !== (user?.email ?? "").toLowerCase()}>
            Permanently delete my account
          </Button>
        </div>
      </Modal>
    </>
  );
}

// ── Billing ─────────────────────────────────────────────────────────────────
// The plans are Stripe subscriptions. Paying happens in the person's own
// browser (Stripe Checkout) — no card ever touches this app — and the account's
// plan follows from what Stripe says about it: the webhook when it can reach
// this PC, and asking Stripe directly when the person comes back.
type SubscriptionSummary = {
  status: string;
  interval: "monthly" | "annual" | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  needsAttention: boolean;
};

type BillingStatus = {
  plan: Plan;
  configured: boolean;
  /** The owner's own build: no payments anywhere (see the desktop editions). */
  personal?: boolean;
  customer: boolean;
  subscription: SubscriptionSummary | null;
  problem?: string;
};

type Invoice = {
  id: string;
  stripeInvoiceId?: string;
  amount: number;
  currency: string;
  status: string;
  pdfUrl: string | null;
  hostedUrl?: string | null;
  createdAt: string | null;
};

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: (currency || "usd").toUpperCase() }).format(cents / 100);

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "");

function BillingTab() {
  const { user, quota, setUser, refreshQuota, loadSession } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [cadence, setCadence] = useState<"monthly" | "annual">("monthly");
  const [busy, setBusy] = useState<"checkout" | "portal" | "dev" | null>(null);
  /** Waiting for the person to finish in their browser. */
  const [waiting, setWaiting] = useState<{ url: string; target: Plan } | null>(null);

  const plan = user?.plan ?? "FREE";
  const planDef = PLANS[plan];
  const used = quota?.used ?? 0;
  const limit = quota?.limit ?? planDef.characterLimit;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const configured = status?.configured ?? true;
  const personal = status?.personal ?? false;
  const sub = status?.subscription ?? null;

  const loadBilling = async () => {
    try {
      const s = await http.get<BillingStatus>("/billing/status");
      setStatus(s);
      if (s.personal) {
        // Nothing was ever bought or billed in this build, so there is no
        // history to ask for (and the route would refuse).
        setInvoices([]);
        return s;
      }
      const i = await http.get<{ invoices: Invoice[] }>("/billing/invoices").catch(() => ({ invoices: [] as Invoice[] }));
      setInvoices(i.invoices);
      return s;
    } catch (e) {
      toast.error("Couldn't read your plan", (e as Error).message);
      return null;
    }
  };

  useEffect(() => {
    void loadBilling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Back from the browser: what Stripe says now is the truth. */
  const reconcile = async (quiet = false) => {
    try {
      const res = await http.post<{ plan: Plan; changed: boolean }>("/billing/reconcile");
      if (res.changed) {
        await loadSession();
        await refreshQuota();
        toast.success(`You're on ${PLANS[res.plan].name}`, "Thanks — your plan is active.");
      } else if (!quiet) {
        toast.info("Nothing has changed yet", "If you just paid, give Stripe a few seconds and press Check again.");
      }
      await loadBilling();
      return res;
    } catch (e) {
      if (!quiet) toast.error("Couldn't check with Stripe", (e as Error).message);
      return null;
    }
  };

  // The person returns to /settings/billing?billing=success in their browser.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const outcome = params.get("billing");
    if (!outcome) return;
    if (outcome === "success") {
      toast.info("Finishing up", "Checking with Stripe…");
      void reconcile(true);
    } else if (outcome === "cancelled") {
      toast.info("No changes made", "You closed the payment page — nothing was charged.");
    }
    // Taken once: coming back to this tab shouldn't re-run the whole thing.
    navigate("/settings/billing", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // While the browser is open, watch for the plan to change by itself. Stripe
  // is asked gently: often for the first minute (the usual case is seconds),
  // then rarely, and never while this window is hidden.
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const started = Date.now();
    let timer = 0;
    const until = started + 6 * 60_000;
    const tick = async () => {
      if (!alive) return;
      if (Date.now() > until) {
        setWaiting(null);
        toast.info("Still nothing from Stripe", "If you did pay, press Check again in a moment.");
        return;
      }
      const every = document.hidden ? 30_000 : Date.now() - started < 60_000 ? 4_000 : 15_000;
      if (!document.hidden) {
        try {
          await reconcile(true);
          const s = await http.get<BillingStatus>("/billing/status");
          if (!alive) return;
          const arrived = !s.subscription || (waiting.target === "FREE" ? s.subscription.cancelAtPeriodEnd : s.plan === waiting.target);
          if (arrived) {
            setWaiting(null);
            await loadSession();
            await refreshQuota();
            setStatus(s);
            toast.success(waiting.target === "FREE" ? "Subscription updated" : `You're on ${PLANS[waiting.target].name}`, "Stripe confirmed the change.");
            return;
          }
        } catch {
          /* the API is briefly unreachable — keep waiting */
        }
      }
      timer = window.setTimeout(() => void tick(), every);
    };
    timer = window.setTimeout(() => void tick(), 3_000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, loadSession, refreshQuota]);

  const upgrade = async (target: "PRO" | "ENTERPRISE") => {
    setBusy("checkout");
    try {
      const res = await http.post<{ url: string }>("/billing/create-checkout", { plan: target, billing: cadence });
      await openInBrowser(res.url);
      setWaiting({ url: res.url, target });
    } catch (e) {
      toast.error("Couldn't start the payment page", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const manage = async () => {
    setBusy("portal");
    try {
      const res = await http.post<{ url: string }>("/billing/create-portal");
      await openInBrowser(res.url);
      setWaiting({ url: res.url, target: "FREE" });
    } catch (e) {
      toast.error("Couldn't open the billing page", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Development only: no Stripe keys on this deployment. */
  const applyPlan = async (p: "PRO" | "ENTERPRISE") => {
    setBusy("dev");
    try {
      const res = await http.post<{ user: { id: string; plan: Plan; name: string; email: string } }>("/billing/apply-plan", { plan: p, billing: cadence });
      setUser({ ...(user!), plan: res.user.plan });
      await refreshQuota();
      await loadBilling();
      toast.success(`Plan changed to ${p}`, "This build has no Stripe keys, so the plan was switched locally.");
    } catch (e) {
      toast.error("Failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const nextPlan: "PRO" | "ENTERPRISE" | null = plan === "FREE" ? "PRO" : plan === "PRO" ? "ENTERPRISE" : null;
  const priceFor = (id: "PRO" | "ENTERPRISE") => (cadence === "annual" ? PLANS[id].annualPricePerMonth : PLANS[id].monthlyPrice);

  return (
    <>
      <Card title="Current plan" icon={<CreditCard className="h-4 w-4" />}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-lg font-bold text-white">{planDef.name}</p>
              {personal ? (
                <Badge tone="gradient">Everything unlocked</Badge>
              ) : (
                <Badge tone="gradient">{planDef.monthlyPrice === 0 ? "Free" : `${money(planDef.monthlyPrice * 100, "usd")}/mo`}</Badge>
              )}
              {sub?.cancelAtPeriodEnd && <Badge tone="gray">Ends {day(sub.currentPeriodEnd)}</Badge>}
            </div>
            <p className="mt-1 text-sm text-gray-400">
              {formatNumber(used)} / {formatNumber(limit)} characters this month
            </p>
            {sub && !sub.cancelAtPeriodEnd && sub.currentPeriodEnd && plan !== "FREE" && (
              <p className="mt-1 text-xs text-gray-500">Renews {day(sub.currentPeriodEnd)}</p>
            )}
            {sub?.needsAttention && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-300">
                <TriangleAlert className="h-3.5 w-3.5" /> Stripe couldn&apos;t take the last payment — update your card to keep {planDef.name}.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {personal && <span className="text-xs text-gray-500">This build has no payments in it — nothing here to buy.</span>}
            {!personal && configured && nextPlan && (
              <Button size="sm" onClick={() => void upgrade(nextPlan)} loading={busy === "checkout"} disabled={Boolean(waiting)}>
                Upgrade to {PLANS[nextPlan].name}
              </Button>
            )}
            {!personal && configured && plan !== "FREE" && (
              <Button size="sm" variant="outline" onClick={() => void manage()} loading={busy === "portal"} disabled={Boolean(waiting)}>
                Manage subscription
              </Button>
            )}
            {!personal && !configured && plan !== "ENTERPRISE" && (
              <Button size="sm" variant="outline" onClick={() => void applyPlan(plan === "FREE" ? "PRO" : "ENTERPRISE")} loading={busy === "dev"}>
                Switch to {plan === "FREE" ? "Pro" : "Enterprise"} (local)
              </Button>
            )}
          </div>
        </div>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-gray-800">
          <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500 transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MiniStat label="Resolution" value={planDef.maxResolution} />
          <MiniStat label="Watermark" value={planDef.watermark ? "Yes" : "No"} />
          <MiniStat label="Cloud save" value={planDef.cloudSave ? "Yes" : "No"} />
          <MiniStat label="Video limit" value={`${planDef.maxVideoMb}MB`} />
        </div>
      </Card>

      {personal && (
        <Card title="Your own build" icon={<Sparkles className="h-4 w-4" />}>
          <p className="text-sm text-gray-300">
            This is the build with no payments in it, installed for your own use. Everything is open — {formatNumber(PLANS.ENTERPRISE.characterLimit)} characters a
            month, {PLANS.ENTERPRISE.maxResolution} exports, no watermark, cloud projects and API keys — and no card, invoice or subscription exists anywhere in it.
          </p>
        </Card>
      )}

      {!personal && configured && (
        <Card title="Upgrade" icon={<Sparkles className="h-4 w-4" />}>
          <div className="flex items-center gap-2">
            {(["monthly", "annual"] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCadence(c)}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                  cadence === c ? "border-blue-500/60 bg-blue-500/10 text-white" : "border-gray-800 text-gray-400 hover:text-gray-200",
                )}
              >
                {c === "monthly" ? "Monthly" : "Annual — two months free"}
              </button>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(["PRO", "ENTERPRISE"] as const).map((id) => {
              const def = PLANS[id];
              const current = plan === id;
              return (
                <div key={id} className={cn("rounded-card border p-4", current ? "border-blue-500/40 bg-blue-500/[0.04]" : "border-gray-800 bg-gray-900/40")}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-white">{def.name}</p>
                    <p className="text-sm text-gray-300">
                      {money(priceFor(id) * 100, "usd")}
                      <span className="text-xs text-gray-500">/mo</span>
                    </p>
                  </div>
                  <ul className="mt-3 space-y-1 text-xs text-gray-400">
                    <li>{formatNumber(def.characterLimit)} characters a month</li>
                    <li>Up to {def.maxResolution}{def.watermark ? "" : " · no watermark"}</li>
                    {def.cloudSave && <li>Cloud projects</li>}
                    {def.apiAccess && <li>API access</li>}
                  </ul>
                  <Button
                    size="sm"
                    className="mt-4"
                    variant={current ? "outline" : "primary"}
                    disabled={current || Boolean(waiting)}
                    onClick={() => void upgrade(id)}
                    loading={busy === "checkout"}
                  >
                    {current ? "Your plan" : `Switch to ${def.name}`}
                  </Button>
                </div>
              );
            })}
          </div>
          {cadence === "annual" && <p className="mt-3 text-xs text-gray-500">Billed once a year at {money(PLANS.PRO.annualPricePerMonth * 12 * 100, "usd")} for Pro, {money(PLANS.ENTERPRISE.annualPricePerMonth * 12 * 100, "usd")} for Enterprise.</p>}
        </Card>
      )}

      {!personal && waiting && (
        <Card title="Finish in your browser" icon={<ExternalLink className="h-4 w-4" />}>
          <p className="text-sm text-gray-300">Stripe opened in your browser — pay there, then come back. This page notices on its own.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reconcile()}>
              Check again
            </Button>
            <Button size="sm" variant="ghost" icon={<ExternalLink className="h-4 w-4" />} onClick={() => void openInBrowser(waiting.url)}>
              Open the page again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setWaiting(null)}>
              Stop waiting
            </Button>
          </div>
        </Card>
      )}

      {!personal && (
      <Card title="Payment method" icon={<CreditCard className="h-4 w-4" />}>
        {!configured ? (
          <p className="text-sm text-gray-400">
            This build has no Stripe keys, so there is nothing to charge and nothing to pay. The plan buttons above switch the plan locally so the whole quota path can be used.
          </p>
        ) : sub ? (
          <p className="text-sm text-gray-400">
            Your card is held by Stripe, never by Soundwave. Change or remove it in the billing page — that is where cancellations happen too, and your access
            continues until {sub.currentPeriodEnd ? day(sub.currentPeriodEnd) : "the end of the period"}.
          </p>
        ) : (
          <p className="text-sm text-gray-400">No card on file yet. Upgrading opens Stripe Checkout in your browser; card details never touch this app.</p>
        )}
        {status?.problem && <p className="mt-2 text-xs text-amber-300">Stripe couldn&apos;t be reached just now ({status.problem}) — showing what this computer already knows.</p>}
      </Card>
      )}

      {!personal && (
      <Card title="Billing history" icon={<CreditCard className="h-4 w-4" />}>
        {invoices === null ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-gray-500">No invoices yet.</p>
        ) : (
          <ul className="divide-y divide-gray-800">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm text-gray-200">
                    {money(inv.amount, inv.currency)} <span className="text-xs text-gray-500">{inv.stripeInvoiceId ?? inv.id}</span>
                  </p>
                  <p className="text-xs text-gray-500">
                    {inv.createdAt ? day(inv.createdAt) : ""} · {inv.status}
                  </p>
                </div>
                {(inv.pdfUrl || inv.hostedUrl) && (
                  <Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} onClick={() => void openInBrowser(inv.pdfUrl ?? inv.hostedUrl!)}>
                    Receipt
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      )}

      {!personal && configured && plan !== "FREE" && (
        <Card title="Cancel subscription" icon={<Trash2 className="h-4 w-4" />}>
          <p className="text-sm text-gray-400">
            Cancel anytime in the billing page; your access continues until the end of the period you paid for. Nothing is deleted.
          </p>
          <Button variant="outline" className="mt-3" onClick={() => void manage()} loading={busy === "portal"}>
            Open billing page
          </Button>
        </Card>
      )}
    </>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-gray-800 bg-gray-900/60 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

// ── Preferences ─────────────────────────────────────────────────────────────
function PreferencesTab() {
  // Same setting as the Command Center's voice picker.
  const [agentVoice, setAgentVoice] = useState(() => loadAgentVoice());
  // Soundwave voices first, then whatever the on-this-PC engine offers (empty
  // when the local voice service isn't running — nothing empty is rendered).
  const {
    status: localVoices,
    canCancelSetup,
    cancellingSetup,
    cancelSetup,
    canRetrySetup,
    retryingSetup,
    retrySetup,
  } = useLocalVoices({ startOnFirstUse: agentVoice.startsWith("kokoro:") });
  const [orbMode, setOrbMode] = useState(() => localStorage.getItem("soundwave_orb_mode") ?? "auto");

  const savePrefs = () => {
    saveAgentVoice(agentVoice);
    localStorage.setItem("soundwave_orb_mode", orbMode);
    toast.success("Preferences saved");
  };

  const downloadData = async () => {
    try {
      const res = await fetch("/api/v1/user/data-export", { credentials: "include" });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "soundwave-data.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error("Export failed", (e as Error).message);
    }
  };

  return (
    <>
      <Card title="The assistant's mode" icon={<Sparkles className="h-4 w-4" />}>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            How it talks to you everywhere — the Command Center, the voice bar and the phone. It can also change this
            itself: ask it to "be more professional" or "call me boss".
          </p>
          <AgentModeChips />
        </div>
      </Card>

      <Card title="Defaults & Agent Appearance" icon={<Palette className="h-4 w-4" />}>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-gray-300">Agent voice</label>
            <Select
              value={agentVoice}
              onChange={setAgentVoice}
              options={[...AGENT_VOICES, ...localVoices.voices].map((v) => ({ value: v.id, label: agentVoiceLabel(v.id) }))}
              ariaLabel="Agent voice"
            />
            <KokoroSetupNotice
              setup={localVoices.setup}
              available={localVoices.available}
              canCancelSetup={canCancelSetup}
              cancellingSetup={cancellingSetup}
              cancelSetup={cancelSetup}
              canRetrySetup={canRetrySetup}
              retryingSetup={retryingSetup}
              retrySetup={retrySetup}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-gray-300">Orb</label>
            <Select
              value={orbMode}
              onChange={setOrbMode}
              options={[
                { value: "auto", label: "Auto" },
                { value: "breathing", label: "Breathing" },
                { value: "listening", label: "Listening" },
                { value: "solving", label: "Solving" },
                { value: "searching", label: "Searching" },
                { value: "connecting", label: "Connecting" },
                { value: "weaving", label: "Weaving" },
                { value: "composing", label: "Composing" },
                { value: "working", label: "Working" },
                { value: "shaping", label: "Shaping" },
              ]}
              ariaLabel="Orb mode"
            />
          </div>
          <Button onClick={savePrefs}>Save</Button>
        </div>
      </Card>

      <Card title="Data & privacy" icon={<Database className="h-4 w-4" />}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-white">Download my data</p>
              <p className="text-xs text-gray-500">Your profile, projects and logs.</p>
            </div>
            <Button size="sm" variant="outline" icon={<Download className="h-4 w-4" />} onClick={downloadData}>Export</Button>
          </div>
        </div>
      </Card>
    </>
  );
}

// ── Voice & Desktop ─────────────────────────────────────────────────────────
function SettingRow({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-gray-800 py-3 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{title}</p>
        {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function VoiceDesktopTab() {
  const desktop = getDesktop();
  const [status, setStatus] = useState<VoiceInputStatus | null>(null);
  const [prefs, setPrefs] = useState<VoicePrefs>(() => loadVoicePrefs());
  const [desk, setDesk] = useState<DesktopState | null>(null);
  const [savingDesk, setSavingDesk] = useState(false);
  // Microphone test
  const [test, setTest] = useState<"idle" | "listening" | "transcribing">("idle");
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState<string | null>(null);
  const recorderRef = useRef<Recorder | null>(null);

  useEffect(() => {
    void fetchVoiceInputStatus().then(setStatus);
    desktop
      ?.getState()
      .then(setDesk)
      .catch(() => undefined);
    // The wake listener and the key watcher change on their own; the state line
    // must be true, not "as it was when the page opened".
    const poll = desktop ? window.setInterval(() => void desktop.getState().then(setDesk).catch(() => undefined), 4000) : undefined;
    return () => {
      if (poll) window.clearInterval(poll);
      recorderRef.current?.cancel();
    };
  }, [desktop]);

  const updatePrefs = (patch: Partial<VoicePrefs>) => setPrefs(saveVoicePrefs(patch));

  const updateDesk = async (patch: Partial<DesktopSettings>) => {
    if (!desktop) return;
    setSavingDesk(true);
    try {
      const next = await desktop.updateSettings(patch);
      setDesk(next);
      if (patch.hotkey || patch.hotkeyEnabled) {
        if (next.hotkeyEnabled && !next.hotkeyRegistered) toast.error("Shortcut not available", next.hotkeyError ?? "Another app uses it — pick a different one.");
        else if (next.hotkeyEnabled) toast.success("Voice shortcut set", `Press ${next.hotkeyLabel} from any app to talk to Soundwave.`);
      }
    } catch (e) {
      toast.error("Couldn't save", (e as Error).message);
    } finally {
      setSavingDesk(false);
    }
  };

  const finishTest = async (stopReason: "manual" | "silence" | "max" | "no-speech" = "manual") => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setTest("transcribing");
    setLevel(0);
    try {
      const recording = await recorder.stop(stopReason);
      if (!recording.hadSpeech && stopReason === "no-speech") {
        setHeard("");
        setTest("idle");
        return;
      }
      const transcript = await transcribeRecording(recording.wav);
      setHeard(transcript.text);
    } catch (e) {
      toast.error("Microphone test failed", (e as Error).message);
      setHeard(null);
    } finally {
      setTest("idle");
      void fetchVoiceInputStatus().then(setStatus);
    }
  };

  const startTest = async () => {
    setHeard(null);
    try {
      recorderRef.current = await startRecording({
        autoStop: true,
        maxMs: 10_000,
        onLevel: setLevel,
        onAutoStop: (reason) => void finishTest(reason),
      });
      setTest("listening");
    } catch (e) {
      toast.error("Microphone problem", (e as Error).message);
    }
  };

  const hotkeyOptions = [
    ...(desk?.hotkeyChoices ?? []).map((c) => ({ value: c.accelerator, label: c.label })),
    { value: "off", label: "Off" },
  ];

  return (
    <>
      <Card title="Voice input" icon={<Mic className="h-4 w-4" />}>
        <div className="space-y-4">
          <div
            className={cn(
              "flex items-start gap-2.5 rounded-lg border p-3 text-sm",
              status?.available ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200" : "border-amber-500/30 bg-amber-500/5 text-amber-200",
            )}
          >
            {status === null ? (
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
            ) : status.available ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <div>
              {status === null
                ? "Checking the speech engine…"
                : status.available
                  ? `On this PC (whisper.cpp ${status.model}) — never uploaded.`
                  : `Voice input isn't available: ${status.reason ?? "the speech engine is missing"}`}
              {status?.lastError && <p className="mt-1 text-xs text-amber-300/90">Last problem: {status.lastError}</p>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              icon={test === "transcribing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
              onClick={() => (test === "listening" ? void finishTest("manual") : void startTest())}
              disabled={test === "transcribing" || status?.available === false}
            >
              {test === "listening" ? "Stop" : test === "transcribing" ? "Transcribing…" : "Test mic"}
            </Button>
            {test === "listening" && (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <span className="h-2 w-40 overflow-hidden rounded-full bg-gray-800">
                  <span className="block h-full rounded-full bg-emerald-400 transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
                </span>
                Say something…
              </div>
            )}
            {heard !== null && test === "idle" && (
              <p className="text-sm text-gray-300">{heard ? <>I heard: “<span className="text-white">{heard}</span>”</> : "I didn't hear anything — check the microphone."}</p>
            )}
          </div>

          <div>
            <SettingRow title="Send when I stop talking" hint="It sends after a pause.">
              <Toggle checked={prefs.autoStop} onChange={(v) => updatePrefs({ autoStop: v })} label="Send when I stop talking" />
            </SettingRow>
            <SettingRow title="Sound cues" hint="Chime on listen.">
              <Toggle checked={prefs.earcons} onChange={(v) => updatePrefs({ earcons: v })} label="Sound cues" />
            </SettingRow>
            <SettingRow title="Speak replies aloud">
              <Toggle checked={prefs.speakReplies} onChange={(v) => updatePrefs({ speakReplies: v })} label="Speak replies aloud" />
            </SettingRow>
          </div>
        </div>
      </Card>

      <Card title="Desktop app" icon={<MonitorSmartphone className="h-4 w-4" />}>
        {!desktop ? (
          <p className="text-sm text-gray-400">The shortcut, tray icon and notifications need the desktop app.</p>
        ) : !desk ? (
          <p className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : (
          <div>
            <SettingRow
              title="Push to talk"
              hint={
                !desk.pushToTalk ? (
                  "Off — the shortcut starts listening, press again to send."
                ) : desk.pushToTalkStatus.problem ? (
                  <span className="text-amber-300">{desk.pushToTalkStatus.problem} Press to start, press again to send.</span>
                ) : desk.pushToTalkStatus.ready ? (
                  "Hold the shortcut (or the mic) and talk — releasing it sends."
                ) : (
                  "Getting ready…"
                )
              }
            >
              <Toggle
                checked={desk.pushToTalk}
                onChange={(v) => void updateDesk({ pushToTalk: v })}
                label="Push to talk"
                disabled={savingDesk || !desk.hotkeyEnabled}
              />
            </SettingRow>
            <SettingRow
              title={`Wake word — “Hey Soundwave”`}
              hint={
                !desk.wakeEnabled ? (
                  "Off."
                ) : desk.wake.state === "listening" ? (
                  desk.wake.lastHit ? `Heard it — ${desk.wake.lastHit} (${desk.wake.heard} checked, ${desk.wake.ignored} ignored)` : "Listening. Everything you say is checked on this PC and thrown away unless it's the phrase — nothing is uploaded."
                ) : desk.wake.state === "paused" ? (
                  "Paused while Soundwave is recording or speaking."
                ) : desk.wake.state === "error" ? (
                  <span className="text-amber-300">{desk.wake.detail ?? "The wake word can't listen right now."}</span>
                ) : (
                  "Starting…"
                )
              }
            >
              <Toggle
                checked={desk.wakeEnabled}
                onChange={(v) => void updateDesk({ wakeEnabled: v })}
                label="Wake word"
                disabled={savingDesk}
              />
            </SettingRow>
            <SettingRow
              title="Voice shortcut"
              hint={
                !desk.hotkeyEnabled ? (
                  "Off."
                ) : desk.hotkeyRegistered ? (
                  <>Works from any app.</>
                ) : (
                  <span className="text-amber-300">{desk.hotkeyError ?? "Another app uses this shortcut."}</span>
                )
              }
            >
              <div className="w-48">
                <Select
                  value={desk.hotkeyEnabled ? desk.hotkey : "off"}
                  onChange={(v) => void updateDesk(v === "off" ? { hotkeyEnabled: false } : { hotkey: v, hotkeyEnabled: true })}
                  options={hotkeyOptions}
                  ariaLabel="Voice shortcut"
                  disabled={savingDesk}
                />
              </div>
            </SettingRow>
            <SettingRow title="Keep running in the tray" hint="Closing the window keeps it running.">
              <Toggle checked={desk.closeToTray} onChange={(v) => void updateDesk({ closeToTray: v })} label="Keep running in the tray" disabled={savingDesk} />
            </SettingRow>
            <SettingRow title="Start with Windows" hint="Quiet start in the tray.">
              <Toggle checked={desk.openAtLogin} onChange={(v) => void updateDesk({ openAtLogin: v })} label="Start with Windows" disabled={savingDesk} />
            </SettingRow>
            <SettingRow title="Notifications" hint="When a short is ready or fails.">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Bell className="h-4 w-4" />}
                  onClick={() => notifyUser({ title: "Soundwave AI", body: "Notifications work. You'll hear from me when a short is ready.", route: "/agent" })}
                  disabled={!desk.notifications}
                >
                  Test
                </Button>
                <Toggle checked={desk.notifications} onChange={(v) => void updateDesk({ notifications: v })} label="Notifications" disabled={savingDesk} />
              </div>
            </SettingRow>
            <p className="pt-2 text-xs text-gray-600">
              Soundwave AI {desk.version} · shortcut {hotkeyLabel(desk.hotkey)}
              {desk.pushToTalk && desk.pushToTalkStatus.ready ? " (hold to talk)" : desk.pushToTalk ? " (press to start, press again to send)" : ""}
            </p>
          </div>
        )}
      </Card>
    </>
  );
}

function Card({ title, icon, children, className }: { title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-card border border-gray-800 bg-panel p-5 sm:p-6", className)}>
      <div className="mb-5 flex items-center gap-2">
        {icon && <span className="text-blue-400">{icon}</span>}
        <h2 className="text-lg font-semibold text-white">{title}</h2>
      </div>
      {children}
    </div>
  );
}
