import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  Brain,
  CheckCircle2,
  CreditCard,
  Database,
  Download,
  Loader2,
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
import { getDesktop, hotkeyLabel, type DesktopSettings, type DesktopState } from "../lib/desktop";
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
function BillingTab() {
  const { user, quota, setUser, refreshQuota } = useAuth();
  const [changing, setChanging] = useState(false);
  const plan = user?.plan ?? "FREE";
  const planDef = PLANS[plan];
  const used = quota?.used ?? 0;
  const limit = quota?.limit ?? planDef.characterLimit;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  const applyPlan = async (p: "PRO" | "ENTERPRISE") => {
    setChanging(true);
    try {
      const res = await http.post<{ user: { id: string; plan: Plan; name: string; email: string } }>("/billing/apply-plan", { plan: p, billing: "monthly" });
      setUser({ ...(user!), plan: res.user.plan });
      await refreshQuota();
      toast.success(`Plan changed to ${p}`, "In production this goes through Stripe Checkout.");
    } catch (e) {
      toast.error("Failed", (e as Error).message);
    } finally {
      setChanging(false);
    }
  };

  return (
    <>
      <Card title="Current plan" icon={<CreditCard className="h-4 w-4" />}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-lg font-bold text-white">{planDef.name}</p>
              <Badge tone="gradient">{planDef.monthlyPrice === 0 ? "Free" : `$${planDef.monthlyPrice}/mo`}</Badge>
            </div>
            <p className="mt-1 text-sm text-gray-400">
              {formatNumber(used)} / {formatNumber(limit)} characters this month
            </p>
          </div>
          {plan !== "ENTERPRISE" && (
            <Button size="sm" onClick={() => applyPlan(plan === "FREE" ? "PRO" : "ENTERPRISE")} loading={changing}>
              Upgrade to {plan === "FREE" ? "Pro" : "Enterprise"}
            </Button>
          )}
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

      <Card title="Payment method" icon={<CreditCard className="h-4 w-4" />}>
        <p className="text-sm text-gray-400">No card on file. In production, payment methods are managed via Stripe Customer Portal (no raw card data ever touches our servers).</p>
      </Card>

      <Card title="Billing history" icon={<CreditCard className="h-4 w-4" />}>
        <p className="text-sm text-gray-500">No invoices yet.</p>
      </Card>

      <Card title="Cancel subscription" icon={<Trash2 className="h-4 w-4" />}>
        <p className="text-sm text-gray-400">You can cancel anytime from the Stripe Customer Portal. Your access continues until the end of the billing period.</p>
      </Card>
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
