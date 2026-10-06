import { Component, Suspense, type ReactNode } from "react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";

// ── What a page shows while it loads, and if it never does ──────────────────
// Every page in this app is fetched as its own chunk now (App.tsx), which is
// what stops one 510 KB file being parsed before the first pixel. Two things
// that used to be impossible can now happen, so both are handled here rather
// than in sixteen pages:
//
//   * the chunk takes a moment to arrive — the frame and the sidebar are
//     already on screen, so only the page area shows a spinner;
//   * the chunk fails (a bad disk read, an update that left an old chunk
//     behind) — a plain-English apology and a retry, not a white window.

/** Shown inside the frame while a page's own code is arriving. */
export function PageLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-gray-600" />
    </div>
  );
}

interface State {
  error: Error | null;
}

/**
 * Catches a render failure in one page — including a chunk that would not
 * load — so the rest of the window keeps working and the person gets a button
 * instead of nothing at all.
 */
export class PageBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || "something went wrong";
    return (
      <div className="mx-auto max-w-xl rounded-card border border-amber-500/30 bg-amber-500/[0.06] p-6 text-sm text-gray-200">
        <div className="mb-2 flex items-center gap-2 text-amber-300">
          <AlertTriangle className="h-4 w-4" />
          <h2 className="font-semibold">This page didn't load</h2>
        </div>
        <p className="text-gray-300">
          The rest of Soundwave is still running. Loading it again usually fixes it — and if it doesn't, Settings → Help → Copy diagnostics
          will say why.
        </p>
        <p className="mt-2 break-words text-xs text-gray-500">{message}</p>
        <button
          type="button"
          onClick={() => {
            this.setState({ error: null });
            window.location.reload();
          }}
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-200 hover:border-cyan-400/50 hover:text-white"
        >
          <RotateCcw className="h-4 w-4" /> Load it again
        </button>
      </div>
    );
  }
}

/** Boundary + Suspense around one page — the whole of what a route needs. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <PageBoundary>
      <Suspense fallback={<PageLoading />}>{children}</Suspense>
    </PageBoundary>
  );
}
