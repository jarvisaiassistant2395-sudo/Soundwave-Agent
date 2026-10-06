import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * The card every Settings tab is built from: a title with an icon, then the
 * tab's own content. It had been written out four times — identically, but for
 * the icon colour — so it lives here instead, and a new tab starts consistent
 * with the ones already there.
 */
export function SettingsCard({
  title,
  icon,
  iconClassName = "text-blue-400",
  children,
  className,
}: {
  title: string;
  icon?: ReactNode;
  /** Morning Setup is amber rather than blue; everything else takes the default. */
  iconClassName?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-card border border-gray-800 bg-panel p-5 sm:p-6", className)}>
      <div className="mb-5 flex items-center gap-2">
        {icon && <span className={iconClassName}>{icon}</span>}
        <h2 className="text-lg font-semibold text-white">{title}</h2>
      </div>
      {children}
    </div>
  );
}
