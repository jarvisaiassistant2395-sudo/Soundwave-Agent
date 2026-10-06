import { SettingsCard as Card } from "../../components/ui/SettingsCard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck, Smartphone, Trash2, TriangleAlert, Wifi } from "lucide-react";
import { toast } from "../../store/toast";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/Button";
import { Toggle } from "../../components/ui/Toggle";

// ── Settings → Phone ────────────────────────────────────────────────────────
// Pair the Soundwave phone app (Android) with this PC. The app talks to the
// PC directly over the local network — end-to-end encrypted with a key the
// phone gets by scanning the QR code below — and only while Soundwave AI
// runs here. Server side: server/src/routes/companion.ts + lib/companion.

interface CompanionDevice {
  id: string;
  name: string;
  platform: string;
  model?: string;
  pairedAt: string;
  lastSeenAt: string | null;
  lastAddress: string | null;
  online: boolean;
}

interface CompanionStatus {
  available: boolean;
  enabled: boolean;
  /** Paired phones may chat with Gemini themselves while the PC is off. */
  shareBrain?: boolean;
  listening: boolean;
  port: number | null;
  error: string | null;
  pcName: string;
  addresses: Array<{ address: string; name: string; kind: "lan" | "vpn" | "other" }>;
  devices: CompanionDevice[];
  pairing: { code: string; link: string; expiresAt: string } | null;
  lastPaired: { deviceId: string; name: string; at: string } | null;
}

const API = "/api/v1/companion";

async function call(method: "GET" | "POST" | "DELETE", path = "", body?: unknown): Promise<CompanionStatus> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as CompanionStatus & { error?: { code?: string; message?: string } };
  if (!res.ok) {
    const err = new Error((data.error as { message?: string } | undefined)?.message || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function PairingQr({ link }: { link: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let cancelled = false;
    QRCode.toString(link, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#000000", light: "#ffffff" } })
      .then((s) => !cancelled && setSvg(s))
      .catch(() => !cancelled && setSvg(""));
    return () => {
      cancelled = true;
    };
  }, [link]);
  return (
    <div
      className="h-52 w-52 shrink-0 overflow-hidden rounded-xl bg-white p-2 shadow-[0_0_40px_-10px_rgba(99,102,241,0.6)] [&>svg]:h-full [&>svg]:w-full"
      role="img"
      aria-label="Pairing QR code for the Soundwave phone app"
      data-testid="pairing-qr"
      // The SVG is generated locally by the qrcode library from our own link.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function PhoneTab() {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const requestingCode = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call("GET"));
    } catch (e) {
      if ((e as { status?: number }).status === 404) setUnavailable(true);
    }
  }, []);

  // Live: paired phones come online, a scan completes, the code expires.
  useEffect(() => {
    void refresh();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  // Always show a fresh code while phone access is on (a code works for one phone, 10 minutes).
  const codeExpired = status?.pairing ? Date.parse(status.pairing.expiresAt) <= now : false;
  useEffect(() => {
    if (!status?.enabled || !status.listening || (status.pairing && !codeExpired) || requestingCode.current) return;
    requestingCode.current = true;
    call("POST", "/pairing")
      .then(setStatus)
      .catch(() => undefined)
      .finally(() => {
        requestingCode.current = false;
      });
  }, [status, codeExpired]);

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await call("POST", "/enabled", { enabled });
      setStatus(next);
      if (enabled && next.error) toast.error("Couldn't open the phone connection", next.error);
      else if (enabled) toast.success("Phone access on", "Scan the code with the Soundwave app.");
    } catch (e) {
      toast.error("Couldn't change phone access", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const newCode = async () => {
    try {
      setStatus(await call("POST", "/pairing"));
    } catch (e) {
      toast.error("Couldn't make a new code", (e as Error).message);
    }
  };

  const forget = async (d: CompanionDevice) => {
    if (!window.confirm(`Remove “${d.name}”? It won't be able to talk to Soundwave on this PC until you pair it again.`)) return;
    try {
      setStatus(await call("DELETE", `/devices/${encodeURIComponent(d.id)}`));
      toast.success("Phone removed", d.name);
    } catch (e) {
      toast.error("Couldn't remove the phone", (e as Error).message);
    }
  };

  const justPaired = status?.lastPaired && now - Date.parse(status.lastPaired.at) < 3 * 60_000 ? status.lastPaired : null;
  const lan = useMemo(() => status?.addresses.filter((a) => a.kind === "lan") ?? [], [status]);
  const vpn = useMemo(() => status?.addresses.filter((a) => a.kind === "vpn") ?? [], [status]);
  // `now` only re-renders every second; read the clock itself so the countdown never shows 10:01.
  const secondsLeft = status?.pairing ? Math.min(600, Math.max(0, Math.floor((Date.parse(status.pairing.expiresAt) - Date.now()) / 1000))) : 0;
  const noNetwork = Boolean(status && status.addresses.length === 0);

  if (unavailable) {
    return (
      <Card title="Phone companion" icon={<Smartphone className="h-4 w-4" />}>
        <p className="text-sm text-gray-400">
          Chatting with Soundwave from your phone is part of the Soundwave AI desktop app for Windows: the phone app talks to the agent running on your PC.
        </p>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card title="Phone companion" icon={<Smartphone className="h-4 w-4" />}>
        <p className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      </Card>
    );
  }

  return (
    <>
      <Card title="Phone companion" icon={<Smartphone className="h-4 w-4" />}>
        <p className="mb-4 text-sm text-gray-400">
          Chat with Soundwave from your Android phone — type or talk, start shorts, watch them when they're done, run your Morning Setup. The Soundwave app talks
          straight to this PC over your Wi-Fi, end-to-end encrypted, while Soundwave AI is running here (even tucked away in the tray) — and can keep chatting
          on its own when the PC is off.
        </p>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">Let my phone connect</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {!status.enabled ? (
                "Off — no phone reaches this PC."
              ) : status.error ? (
                <span className="text-amber-300">{status.error}</span>
              ) : status.listening ? (
                <>
                  On — waiting for your phone on {lan[0]?.address ?? status.addresses[0]?.address ?? "this PC"}
                  {status.port ? `, port ${status.port}` : ""}.
                </>
              ) : (
                "Starting…"
              )}
            </p>
          </div>
          <Toggle checked={status.enabled} onChange={(v) => void setEnabled(v)} label="Let my phone connect" disabled={busy} />
        </div>

        <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3" data-testid="share-brain">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">Chat from the phone when this PC is off</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {status.shareBrain !== false
                ? "On — phones get your Gemini key and memory, end-to-end encrypted, so they keep chatting with the agent."
                : "Off — phones chat only while this PC runs; their key copy is deleted next time they connect."}
            </p>
          </div>
          <Toggle
            checked={status.shareBrain !== false}
            onChange={(v) => {
              setBusy(true);
              call("POST", "/share-brain", { enabled: v })
                .then(setStatus)
                .catch((err: Error) => toast.error("Phone", err.message))
                .finally(() => setBusy(false));
            }}
            label="Chat from the phone when this PC is off"
            disabled={busy}
          />
        </div>

        {status.enabled && status.listening && (
          <div className="mt-5">
            {justPaired && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200" data-testid="paired-banner">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Paired with {justPaired.name}. Say hi from the app — it's the same conversation as the Command Center.
              </div>
            )}
            {noNetwork && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" data-testid="no-network">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                This PC isn't on a network right now, so the phone can't find it. Connect to Wi-Fi or Ethernet (the same network as the phone) and the code
                will appear here.
              </div>
            )}
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
              {status.pairing && !noNetwork ? (
                <PairingQr link={status.pairing.link} />
              ) : (
                <div className="flex h-52 w-52 shrink-0 items-center justify-center rounded-xl border border-gray-800 bg-gray-900/60">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <ol className="space-y-2.5 text-sm text-gray-300">
                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-[11px] font-bold text-blue-300">1</span>
                    <span>Install the Soundwave app on your Android phone and open it.</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-[11px] font-bold text-blue-300">2</span>
                    <span>
                      Tap <b className="text-white">Scan QR code</b> and point the camera at this code.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-[11px] font-bold text-blue-300">3</span>
                    <span>That's it — the phone remembers this PC.</span>
                  </li>
                </ol>
                {status.pairing && (
                  <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900/50 p-3">
                    <p className="text-xs text-gray-500">No camera? In the app choose “Enter code” and type:</p>
                    <div className="mt-2 grid gap-1 text-sm">
                      <p>
                        <span className="text-gray-500">PC address </span>
                        <span className="font-mono text-white" data-testid="pairing-address">
                          {lan[0]?.address ?? status.addresses[0]?.address ?? "—"}
                          {status.port && status.port !== 47800 ? `:${status.port}` : ""}
                        </span>
                      </p>
                      <p>
                        <span className="text-gray-500">Code </span>
                        <span className="font-mono text-lg font-semibold tracking-wider text-white" data-testid="pairing-code">
                          {status.pairing.code}
                        </span>
                      </p>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                      <span>
                        Works for one phone · new code in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
                      </span>
                      <button type="button" onClick={() => void newCode()} className="flex items-center gap-1 text-blue-400 hover:text-blue-300">
                        <RefreshCw className="h-3 w-3" /> New code
                      </button>
                    </div>
                  </div>
                )}
                <p className="mt-3 flex items-start gap-2 text-xs text-gray-500">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  The code never travels over the network: the phone uses it to set up its own encryption key with this PC.
                </p>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card title="Paired phones" icon={<Smartphone className="h-4 w-4" />}>
        {status.devices.length === 0 ? (
          <p className="text-sm text-gray-500">No phones yet.</p>
        ) : (
          <ul className="divide-y divide-gray-800" data-testid="paired-phones">
            {status.devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-800">
                    <Smartphone className="h-4 w-4 text-gray-300" />
                    <span
                      className={cn("absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-panel", d.online && status.listening ? "bg-emerald-400" : "bg-gray-600")}
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">{d.name}</p>
                    <p className="truncate text-xs text-gray-500">
                      {d.online && status.listening ? <span className="text-emerald-400">Connected now</span> : `Last seen ${ago(d.lastSeenAt)}`}
                      {d.model ? ` · ${d.model}` : ""} · paired {new Date(d.pairedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </p>
                  </div>
                </div>
                <Button variant="ghost" size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => void forget(d)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {!status.enabled && status.devices.length > 0 && (
          <p className="mt-3 text-xs text-gray-500">Phone access is off, so these phones can't connect right now.</p>
        )}
      </Card>

      <Card title="If the phone can't connect" icon={<Wifi className="h-4 w-4" />}>
        <ul className="space-y-2.5 text-sm text-gray-400">
          <li>
            <b className="text-gray-200">Same Wi-Fi.</b> The phone must be on the same network as this PC (not a guest network, not mobile data).
          </li>
          <li>
            <b className="text-gray-200">Windows Firewall.</b> When you turned this on, Windows may have asked whether Soundwave AI can use your network — it needs{" "}
            <i>Allow</i> on private networks. If you missed it: Windows Security → Firewall &amp; network protection → Allow an app through firewall → tick
            Soundwave AI for <i>Private</i>. Also make sure your Wi-Fi is set to a <i>Private</i> network in Windows.
          </li>
          <li>
            <b className="text-gray-200">Away from home?</b> Install a VPN such as Tailscale on the PC and the phone, then pair again — the code includes the VPN
            address{vpn.length ? ` (${vpn.map((a) => a.address).join(", ")})` : ""}.
          </li>
        </ul>
        {status.addresses.length > 0 && (
          <p className="mt-4 text-xs text-gray-600">
            This PC ({status.pcName}): {status.addresses.map((a) => `${a.address} (${a.name})`).join(" · ")}
          </p>
        )}
        {status.error && (
          <p className="mt-3 flex items-start gap-2 text-xs text-amber-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {status.error}
          </p>
        )}
      </Card>
    </>
  );
}
