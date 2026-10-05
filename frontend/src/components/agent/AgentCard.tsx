import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { ArrowUpRight } from "lucide-react";

export interface AgentCardProps {
  id: string;
  name: string;
  role: string;
  description: string;
  icon: ReactNode;
  status: "ready" | "running" | "idle" | "standby";
  statusText?: string;
  capabilities: string[];
  recentActivity: string;
  primaryActionLabel: string;
  onPrimaryAction: () => void;
  active?: boolean;
  className?: string;
}

export function AgentCard({
  name,
  role,
  description,
  icon,
  status,
  statusText,
  capabilities,
  recentActivity,
  primaryActionLabel,
  onPrimaryAction,
  active = false,
  className,
}: AgentCardProps) {
  const getStatusBadge = () => {
    switch (status) {
      case "running":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" />
            </span>
            {statusText || "Running"}
          </span>
        );
      case "ready":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {statusText || "Ready"}
          </span>
        );
      case "idle":
      case "standby":
      default:
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] font-medium text-gray-400">
            <span className="h-1.5 w-1.5 rounded-full bg-gray-500" />
            {statusText || (status === "idle" ? "Idle" : "Standby")}
          </span>
        );
    }
  };

  return (
    <div
      className={cn(
        "group relative flex flex-col justify-between rounded-xl border border-white/[0.07] bg-[#0C0C0F] p-5 transition-all duration-150 hover:border-white/[0.14] hover:bg-[#131419]",
        active && "border-blue-500/40 bg-[#131419] shadow-sm",
        className,
      )}
    >
      <div>
        {/* Header: Icon, Name, Role, Status */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-gray-200 group-hover:border-blue-500/30 group-hover:text-blue-400 transition-colors">
              {icon}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-white tracking-tight">{name}</h3>
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
                  {role}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-gray-400 line-clamp-2">{description}</p>
            </div>
          </div>
          <div className="shrink-0">{getStatusBadge()}</div>
        </div>

        {/* Capabilities Pills */}
        <div className="mt-4 flex flex-wrap gap-1.5">
          {capabilities.map((cap) => (
            <span
              key={cap}
              className="rounded-md border border-white/[0.05] bg-white/[0.02] px-2 py-0.5 text-[11px] font-medium text-gray-400"
            >
              {cap}
            </span>
          ))}
        </div>
      </div>

      {/* Footer: Recent Activity & Primary CTA */}
      <div className="mt-5 pt-3.5 border-t border-white/[0.06] flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="text-[11px] text-gray-400 block truncate">
            <strong className="text-gray-400 font-medium">Activity:</strong> {recentActivity}
          </span>
        </div>
        <button
          type="button"
          onClick={onPrimaryAction}
          className="inline-flex items-center gap-1 shrink-0 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-gray-200 hover:border-blue-500/40 hover:bg-blue-600 hover:text-white transition-all cursor-pointer"
        >
          <span>{primaryActionLabel}</span>
          <ArrowUpRight className="h-3.5 w-3.5 opacity-70" />
        </button>
      </div>
    </div>
  );
}
