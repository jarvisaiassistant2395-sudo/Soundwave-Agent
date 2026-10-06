import { Laptop, TriangleAlert } from "lucide-react";
import type { PairingPhase } from "../state/useCompanion";
import { GhostButton, Logo, PrimaryButton } from "./ui";

/** Shown while pairing runs (or failed). */
export function PairingOverlay({ phase, onRetry, onClose }: { phase: PairingPhase; onRetry: () => void; onClose: () => void }) {
  if (phase.kind === "idle") return null;
  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in flex-col items-center justify-center bg-navy/95 px-7 pt-safe pb-safe backdrop-blur" data-testid="pairing-overlay">
      {phase.kind === "working" ? (
        <>
          <div className="flex items-center gap-4">
            <div className="animate-breathe">
              <Logo size={64} glow />
            </div>
            <span className="sw-dots flex gap-1.5 text-cyan-300">
              <span className="h-2 w-2 rounded-full bg-current" />
              <span className="h-2 w-2 rounded-full bg-current" />
              <span className="h-2 w-2 rounded-full bg-current" />
            </span>
            <div className="flex h-16 w-16 items-center justify-center rounded-[28%] border border-white/10 bg-panel">
              <Laptop className="h-7 w-7 text-gray-300" />
            </div>
          </div>
          <p className="mt-8 text-xl font-semibold">Pairing with {phase.pcName}…</p>
          <p className="mt-2 text-center text-[15px] text-gray-400">Setting up an encrypted connection.</p>
        </>
      ) : (
        <>
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-400/15">
            <TriangleAlert className="h-8 w-8 text-amber-300" />
          </div>
          <p className="mt-6 text-xl font-semibold">Couldn't pair</p>
          <p className="mt-3 text-center text-[15px] leading-relaxed text-gray-300" data-testid="pairing-error">
            {phase.message}
          </p>
          <div className="mt-10 w-full space-y-3">
            <PrimaryButton onClick={onRetry}>Scan again</PrimaryButton>
            <GhostButton onClick={onClose}>Back</GhostButton>
          </div>
        </>
      )}
    </div>
  );
}
