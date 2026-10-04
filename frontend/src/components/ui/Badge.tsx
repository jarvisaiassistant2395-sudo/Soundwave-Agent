import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Tone = "blue" | "violet" | "green" | "red" | "amber" | "gray" | "gradient";

const tones: Record<Tone, string> = {
  blue: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  violet: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  green: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  red: "bg-red-500/10 text-red-400 border-red-500/20",
  amber: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  gray: "bg-white/[0.05] text-gray-400 border-white/[0.08]",
  gradient: "bg-blue-500/10 text-blue-400 border-blue-500/20",
};

export function Badge({
  children,
  tone = "gray",
  className,
  dot,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
