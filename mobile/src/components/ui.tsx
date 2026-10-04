import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect } from "react";
import { X } from "lucide-react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** The Soundwave waveform (same mark as the desktop app's icon). */
export function Wave({ className, strokeWidth = 6 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 100 60" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="sw-wave" x1="0" y1="0" x2="100" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22D3EE" />
          <stop offset="0.45" stopColor="#8B5CF6" />
          <stop offset="0.62" stopColor="#6366F1" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
      </defs>
      <path
        d="M2 31 H17 C23 31 25 24 30 25 C35 26 37 39 41.5 39 C46 39 46.5 7 51 7 C55.5 7 56.5 53 61 53 C65.5 53 67 31 76 31 H98"
        stroke="url(#sw-wave)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** App mark: the waveform on a navy tile. */
export function Logo({ size = 40, glow = false }: { size?: number; glow?: boolean }) {
  return (
    <div
      className={cn("relative flex shrink-0 items-center justify-center rounded-[28%] border border-white/10 bg-[#080b1e]", glow && "shadow-[0_0_60px_-8px_rgba(99,102,241,0.7)]")}
      style={{ width: size, height: size }}
    >
      <Wave className="w-[74%]" strokeWidth={size > 60 ? 6 : 8} />
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; busy?: boolean };

export function PrimaryButton({ icon, busy, children, className, disabled, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cn(
        "flex h-14 w-full items-center justify-center gap-2.5 rounded-2xl bg-gradient-to-r from-blue-600 to-violet-600 text-[16px] font-semibold text-white shadow-[0_8px_30px_-8px_rgba(99,102,241,0.8)] transition active:scale-[0.98] disabled:opacity-50",
        className,
      )}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function GhostButton({ icon, children, className, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-line bg-white/[0.03] text-[15px] font-medium text-gray-200 transition active:bg-white/[0.07] disabled:opacity-50",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn("flex h-11 w-11 items-center justify-center rounded-full text-gray-300 transition active:bg-white/10 disabled:opacity-40", className)}
    >
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn("inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/25 border-t-white", className)} aria-hidden="true" />;
}

/** Bottom sheet with a dimmed backdrop. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" className="absolute inset-0 animate-fade-in bg-black/60" onClick={onClose} />
      <div className="relative max-h-[88%] animate-sheet-in overflow-y-auto rounded-t-3xl border-t border-line bg-panel px-5 pb-safe">
        <div className="sticky top-0 z-10 -mx-5 flex items-center justify-between bg-panel px-5 pb-2 pt-3">
          <div className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-white/15" />
          <h2 className="pt-3 text-lg font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2 mt-2">
            <X className="h-5 w-5" />
          </IconButton>
        </div>
        <div className="pb-6">{children}</div>
      </div>
    </div>
  );
}
