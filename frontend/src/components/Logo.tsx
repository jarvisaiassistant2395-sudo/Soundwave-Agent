import { cn } from "../lib/cn";

interface LogoProps {
  className?: string;
  withWordmark?: boolean;
  wordmarkClassName?: string;
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={cn("h-9 w-9", className)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="sw-logo-g" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3B82F6" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="11" fill="#000000" />
      <rect x="2" y="2" width="44" height="44" rx="11" fill="none" stroke="url(#sw-logo-g)" strokeWidth="2" />
      <g stroke="url(#sw-logo-g)" strokeWidth="3" strokeLinecap="round">
        <path d="M9 20v8" />
        <path d="M15 14v20" />
        <path d="M21 9v30" />
        <path d="M27 17v14" />
        <path d="M33 12v24" />
        <path d="M39 16v16" />
      </g>
      <circle cx="40" cy="9" r="3" fill="#8B5CF6" />
    </svg>
  );
}

export function Logo({ className, withWordmark = true, wordmarkClassName }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      {withWordmark && (
        <span
          className={cn(
            "text-lg font-bold tracking-tight text-white whitespace-nowrap",
            wordmarkClassName,
          )}
        >
          Soundwave <span className="text-gradient">AI</span>
        </span>
      )}
    </span>
  );
}
