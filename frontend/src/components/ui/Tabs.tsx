import { cn } from "../../lib/cn";

export interface TabDef {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

interface TabsProps {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      className={cn("flex gap-1 overflow-x-auto rounded-card border border-gray-800 bg-gray-900/60 p-1", className)}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-all duration-200",
            active === t.id
              ? "bg-gradient-to-r from-blue-500/20 to-violet-500/20 text-white"
              : "text-gray-400 hover:text-gray-200",
          )}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}
