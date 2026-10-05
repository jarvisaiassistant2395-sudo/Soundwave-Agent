import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * One icon and no words. The label still exists — as the tooltip on hover and
 * as the accessible name — so nothing gets less usable by losing its caption.
 * Use it for every action whose icon says what it does (download, post, play,
 * refresh, delete); keep a short word for anything ambiguous.
 */
const SIZES = {
  sm: "h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5",
  md: "h-8 w-8 [&_svg]:h-4 [&_svg]:w-4",
  lg: "h-10 w-10 [&_svg]:h-5 [&_svg]:w-5",
} as const;

const TONES = {
  ghost: "border-[#2C2C2C] bg-[#050505] text-gray-300 hover:border-cyan-400/60 hover:text-cyan-300",
  plain: "text-gray-400 hover:text-cyan-300",
  cyan: "border-cyan-500/40 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500 hover:text-[#0C0C0C]",
  red: "border-red-500/40 bg-red-600/20 text-red-300 hover:bg-red-600/35",
} as const;

interface IconButtonProps {
  /** Tooltip + screen-reader name, e.g. "Download MP4". */
  label: string;
  children: ReactNode;
  onClick?: () => void;
  size?: keyof typeof SIZES;
  tone?: keyof typeof TONES;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function IconButton({
  label,
  children,
  onClick,
  size = "md",
  tone = "ghost",
  disabled,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
        SIZES[size],
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** The same, for the actions that are really links (download, watch, open). */
export function IconLink({
  label,
  href,
  children,
  size = "md",
  tone = "ghost",
  className,
  download,
  ...rest
}: Omit<IconButtonProps, "onClick" | "disabled"> & {
  href: string;
  download?: boolean | string;
  target?: string;
  rel?: string;
}) {
  return (
    <a
      href={href}
      download={download}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg border transition-colors cursor-pointer",
        SIZES[size],
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </a>
  );
}
