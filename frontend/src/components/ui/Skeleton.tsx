import { cn } from "../../lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden="true" />;
}

export function SkeletonCard() {
  return (
    <div className="rounded-card border border-gray-800 bg-panel p-5">
      <Skeleton className="mb-4 h-6 w-2/5" />
      <Skeleton className="mb-2 h-4 w-full" />
      <Skeleton className="mb-2 h-4 w-4/5" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 p-4">
      <Skeleton className="h-10 w-10 rounded-lg" />
      <div className="min-w-0 flex-1">
        <Skeleton className="mb-2 h-4 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}
