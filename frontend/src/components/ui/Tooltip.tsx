import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  disabled?: boolean;
}

/** Lightweight CSS tooltip (z-50). */
export function Tooltip({ content, children, side = "top", disabled }: TooltipProps) {
  const [show, setShow] = useState(false);
  if (disabled) return <>{children}</>;

  const sideClass = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  }[side];

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 w-max max-w-64 rounded-md border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-xs text-gray-200 shadow-xl transition-opacity duration-150",
          sideClass,
          show ? "opacity-100" : "opacity-0",
        )}
      >
        {content}
      </span>
    </span>
  );
}
