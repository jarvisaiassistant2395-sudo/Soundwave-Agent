import { KeyRound, Laptop, ScanLine, ToggleRight, QrCode } from "lucide-react";
import type { ReactNode } from "react";
import { GhostButton, Logo, PrimaryButton } from "./ui";

function Step({ n, icon, children }: { n: number; icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 text-blue-300">
        {icon}
      </span>
      <span className="pt-1 text-[15px] leading-snug text-gray-300">
        <span className="sr-only">Step {n}: </span>
        {children}
      </span>
    </li>
  );
}

export function Welcome({ onScan, onManual }: { onScan: () => void; onManual: () => void }) {
  return (
    <div className="flex h-full flex-col px-6 pt-safe pb-safe">
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <div className="animate-breathe">
          <Logo size={96} glow />
        </div>
        <h1 className="mt-7 text-[32px] font-bold tracking-tight">Soundwave</h1>
        <p className="mt-1.5 text-[16px] text-gray-400">Talk to the agent on your PC — from anywhere in the house.</p>

        <div className="mt-9 w-full rounded-3xl border border-line bg-panel/80 p-5 text-left">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">Pair with your PC</p>
          <ol className="mt-4 space-y-4">
            <Step n={1} icon={<Laptop className="h-4 w-4" />}>
              On your PC, open <b className="font-semibold text-white">Soundwave AI → Settings → Phone</b>.
            </Step>
            <Step n={2} icon={<ToggleRight className="h-4 w-4" />}>
              Turn on <b className="font-semibold text-white">Let my phone connect</b>.
            </Step>
            <Step n={3} icon={<QrCode className="h-4 w-4" />}>
              Scan the QR code it shows.
            </Step>
          </ol>
        </div>
      </div>

      <div className="space-y-3 pb-5 pt-4">
        <PrimaryButton onClick={onScan} icon={<ScanLine className="h-5 w-5" />} data-testid="scan-button">
          Scan QR code
        </PrimaryButton>
        <GhostButton onClick={onManual} icon={<KeyRound className="h-4 w-4" />} data-testid="manual-button">
          Enter code instead
        </GhostButton>
        <p className="pt-1 text-center text-xs text-gray-500">Your phone and PC need to be on the same Wi-Fi.</p>
      </div>
    </div>
  );
}
