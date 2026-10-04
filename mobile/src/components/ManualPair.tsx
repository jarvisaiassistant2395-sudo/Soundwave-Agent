import { useState } from "react";
import { ArrowLeft, KeyRound, Laptop } from "lucide-react";
import { formatPairingCode, normalizePairingCode, parseTypedAddress, type PairingLink } from "../lib/protocol";
import { CompanionError, linkFromTyped } from "../lib/client";
import { IconButton, PrimaryButton } from "./ui";

/** "abcd efgh" → "ABCD-EFGH" as you type. */
function prettyCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 12);
  return raw.replace(/(.{4})(?=.)/g, "$1-");
}

export function ManualPair({ onBack, onLink }: { onBack: () => void; onLink: (link: PairingLink) => void }) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const where = parseTypedAddress(address);
    if (!where) return setError("Type the PC address shown in Settings → Phone, like 192.168.1.23.");
    const normalized = normalizePairingCode(code);
    if (!normalized) return setError("The code has 12 letters and numbers, like ABCD-EFGH-JKMN.");
    setBusy(true);
    try {
      onLink(await linkFromTyped(where, normalized));
    } catch (err) {
      setError(err instanceof CompanionError ? err.message : "Couldn't reach the PC.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex h-full flex-col px-5 pt-safe pb-safe" data-testid="manual-pair">
      <div className="flex items-center gap-1 pt-2">
        <IconButton label="Back" onClick={onBack} className="-ml-2">
          <ArrowLeft className="h-6 w-6" />
        </IconButton>
        <h1 className="text-lg font-semibold">Enter the code</h1>
      </div>
      <p className="mt-3 text-[15px] text-gray-400">
        On your PC: <span className="text-gray-200">Soundwave AI → Settings → Phone</span>. The address and code are under the QR code.
      </p>

      <label className="mt-7 block">
        <span className="flex items-center gap-2 text-[13px] font-medium text-gray-400">
          <Laptop className="h-4 w-4" /> PC address
        </span>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="192.168.1.23"
          inputMode="decimal"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="mt-2 h-14 w-full rounded-2xl border border-line bg-panel px-4 font-mono text-[18px] text-white outline-none placeholder:text-gray-600 focus:border-blue-500/60"
          data-testid="manual-address"
        />
      </label>

      <label className="mt-5 block">
        <span className="flex items-center gap-2 text-[13px] font-medium text-gray-400">
          <KeyRound className="h-4 w-4" /> Code
        </span>
        <input
          value={code}
          onChange={(e) => setCode(prettyCode(e.target.value))}
          placeholder={formatPairingCode("XXXXXXXXXXXX")}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={14}
          className="mt-2 h-14 w-full rounded-2xl border border-line bg-panel px-4 font-mono text-[20px] tracking-[0.12em] text-white outline-none placeholder:text-gray-600 focus:border-blue-500/60"
          data-testid="manual-code"
        />
      </label>

      {error && (
        <p className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-[14px] text-amber-100" role="alert">
          {error}
        </p>
      )}

      <div className="mt-auto pb-5 pt-6">
        <PrimaryButton type="submit" busy={busy} data-testid="manual-submit">
          Pair
        </PrimaryButton>
      </div>
    </form>
  );
}
