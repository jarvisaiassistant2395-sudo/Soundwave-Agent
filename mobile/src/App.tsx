import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { useCompanion } from "./state/useCompanion";
import { parsePairingLink, type PairingLink } from "./lib/protocol";
import { onBackButton, onDeepLink } from "./lib/native";
import { closeTopmost } from "./lib/back";
import { storage } from "./lib/storage";
import { toast, useToast } from "./lib/toast";
import { Welcome } from "./components/Welcome";
import { Scanner } from "./components/Scanner";
import { ManualPair } from "./components/ManualPair";
import { PairingOverlay } from "./components/PairingOverlay";
import { Chat } from "./components/Chat";
import { SettingsSheet } from "./components/SettingsSheet";
import { Forgotten } from "./components/Forgotten";
import { cn, Logo } from "./components/ui";

type PairScreen = "welcome" | "scan" | "manual";

function Toast() {
  const t = useToast();
  if (!t) return null;
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-[calc(var(--sab)+86px)] z-[60] flex justify-center" role="status" aria-live="polite">
      <div
        key={t.id}
        className={cn(
          "flex max-w-md animate-rise-in items-start gap-2.5 rounded-2xl border px-4 py-3 text-[14px] shadow-2xl backdrop-blur",
          t.tone === "error" ? "border-red-400/30 bg-[#2a1117]/95 text-red-100" : t.tone === "success" ? "border-emerald-400/30 bg-[#0f231c]/95 text-emerald-100" : "border-line bg-elevated/95 text-gray-100",
        )}
        data-testid="toast"
      >
        {t.tone === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : t.tone === "error" ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : null}
        <span>{t.text}</span>
      </div>
    </div>
  );
}

export function App() {
  const companion = useCompanion();
  const [screen, setScreen] = useState<PairScreen>("welcome");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pairRef = useRef(companion.pair);
  pairRef.current = companion.pair;

  const startPairing = useCallback(async (link: PairingLink) => {
    setScreen("welcome");
    if (await pairRef.current(link)) toast(`Paired with ${link.pcName}`, "success");
  }, []);

  // soundwave://pair?… opened from the system camera (or a test harness).
  useEffect(
    () =>
      onDeepLink((url) => {
        const link = parsePairingLink(url);
        if (link) void startPairing(link);
      }),
    [startPairing],
  );

  // Back: close what's on top, then step back through pairing, else leave the app.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const pairingRef = useRef(companion.pairing);
  pairingRef.current = companion.pairing;
  const resetPairing = companion.resetPairing;
  useEffect(
    () =>
      onBackButton(() => {
        if (closeTopmost()) return true;
        if (pairingRef.current.kind === "failed") {
          resetPairing();
          return true;
        }
        if (screenRef.current !== "welcome") {
          setScreen("welcome");
          return true;
        }
        return false;
      }),
    [resetPairing],
  );

  if (companion.record === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Logo size={72} glow />
      </div>
    );
  }

  if (!companion.record) {
    return (
      <>
        {screen === "welcome" && <Welcome onScan={() => setScreen("scan")} onManual={() => setScreen("manual")} />}
        {screen === "scan" && <Scanner onResult={(link) => void startPairing(link)} onClose={() => setScreen("welcome")} onManual={() => setScreen("manual")} />}
        {screen === "manual" && <ManualPair onBack={() => setScreen("welcome")} onLink={(link) => void startPairing(link)} />}
        <PairingOverlay
          phase={companion.pairing}
          onRetry={() => {
            companion.resetPairing();
            setScreen("scan");
          }}
          onClose={companion.resetPairing}
        />
        <Toast />
      </>
    );
  }

  if (companion.state.kind === "forgotten") {
    return (
      <Forgotten
        pcName={companion.record.pcName}
        onPairAgain={() => {
          void storage.clearAll().then(() => window.location.reload());
        }}
      />
    );
  }

  return (
    <>
      <Chat companion={companion} onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} companion={companion} />
      <PairingOverlay phase={companion.pairing} onRetry={companion.resetPairing} onClose={companion.resetPairing} />
      <Toast />
    </>
  );
}
