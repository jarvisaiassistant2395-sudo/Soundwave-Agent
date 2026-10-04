import type { LocalVoiceSetupStatus } from "../lib/localVoices";
import { Button } from "./ui/Button";

interface KokoroSetupNoticeProps {
  setup?: LocalVoiceSetupStatus;
  available: boolean;
  canCancelSetup: boolean;
  cancellingSetup: boolean;
  cancelSetup: () => Promise<boolean>;
}

export function KokoroSetupNotice({ setup, available, canCancelSetup, cancellingSetup, cancelSetup }: KokoroSetupNoticeProps) {
  if (!setup?.managed || available) return null;

  const active = !["ready", "failed", "cancelled"].includes(setup.phase);
  const progress = typeof setup.progress === "number" ? Math.max(0, Math.min(100, Math.round(setup.progress))) : undefined;

  return (
    <div role="status" aria-live="polite" className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 px-4 py-3 text-sm text-emerald-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1">{setup.message}</p>
        {canCancelSetup && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-emerald-800 text-emerald-100 hover:border-emerald-500 hover:bg-emerald-950/50 hover:text-white"
            loading={cancellingSetup}
            onClick={() => void cancelSetup()}
            aria-label="Cancel Kokoro setup"
          >
            {cancellingSetup ? "Cancelling…" : "Cancel setup"}
          </Button>
        )}
      </div>

      {active && (
        <div className="mt-2">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-emerald-950/80"
            role="progressbar"
            aria-label="Kokoro setup progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-valuetext={progress === undefined ? setup.message : `${setup.progressLabel ?? "Current download"}: ${progress}%`}
          >
            <div
              className={`h-full rounded-full bg-emerald-400 transition-[width] duration-300 ${progress === undefined ? "w-1/3 animate-pulse" : ""}`}
              style={progress === undefined ? undefined : { width: `${progress}%` }}
            />
          </div>
          {progress !== undefined && (
            <p className="mt-1 text-right text-xs tabular-nums text-emerald-100/75">
              {setup.progressLabel ?? "Current download"}: {progress}%
            </p>
          )}
        </div>
      )}

      {setup.phase === "failed" && (
        <p className="mt-1 text-xs text-emerald-100/70">The setup log is saved with Soundwave&apos;s local app data; it will retry next time the app starts.</p>
      )}
      {setup.phase === "cancelled" && (
        <p className="mt-1 text-xs text-emerald-100/70">Soundwave voices remain available. Kokoro setup can run again the next time the app starts.</p>
      )}
    </div>
  );
}
