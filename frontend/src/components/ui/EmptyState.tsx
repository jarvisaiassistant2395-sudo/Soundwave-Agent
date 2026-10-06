import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}>
      {icon && (
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-gray-700 bg-gray-800/60 text-gray-500">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm text-gray-400">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
