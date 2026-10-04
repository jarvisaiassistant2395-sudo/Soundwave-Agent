import { cn } from "../../lib/cn";

interface ProgressBarProps {
  value?: number; // 0..100
  className?: string;
  barClassName?: string;
  indeterminate?: boolean;
  tone?: "default" | "success" | "warning" | "danger";
  label?: string;
}

const tones: Record<NonNullable<ProgressBarProps["tone"]>, string> = {
  default: "bg-gradient-to-r from-blue-500 to-violet-500",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export function ProgressBar({ value = 0, className, barClassName, indeterminate, tone = "default", label }: ProgressBarProps) {
  return (
    <div
      className={cn("w-full", className)}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? "Progress"}
    >
      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-800">
        {indeterminate ? (
          <div
            className={cn("h-full w-1/3 rounded-full animate-[shimmer_1.4s_linear_infinite]", tones[tone])}
            style={{ backgroundSize: "200% 100%" }}
          />
        ) : (
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300 ease-out",
              tones[tone],
              barClassName,
            )}
            style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
          />
        )}
      </div>
    </div>
  );
}
