import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

export interface DropdownItem {
  key: string;
  label: string;
  /** One line under the label, for items that need explaining before they're picked. */
  hint?: string;
  /** Marks the item that is currently in force. */
  selected?: boolean;
  icon?: ReactNode;
  danger?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

interface DropdownProps {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: "left" | "right";
  label?: string;
}

/** Generic dropdown menu — closes on outside click and Escape. */
export function Dropdown({ trigger, items, align = "right", label }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            role="menu"
            aria-label={label}
            className={cn(
              "absolute z-20 mt-2 w-56 overflow-hidden rounded-card border border-gray-700 bg-panel py-1 shadow-2xl",
              items.some((i) => i.hint) && "w-72",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            {items.map((item) => (
              <button
                key={item.key}
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick?.();
                }}
                aria-current={item.selected ? "true" : undefined}
                className={cn(
                  "flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-gray-800 disabled:opacity-40",
                  item.danger ? "text-red-400" : item.selected ? "text-white" : "text-gray-200",
                )}
              >
                {item.icon && <span className="mt-0.5 shrink-0">{item.icon}</span>}
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate", item.selected && "font-semibold")}>{item.label}</span>
                  {item.hint && <span className="mt-0.5 block text-xs leading-snug text-gray-500">{item.hint}</span>}
                </span>
                {item.selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-400" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
