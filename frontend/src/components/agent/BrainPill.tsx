import { Link } from "react-router-dom";
import type { BrainStatus } from "../../lib/brain";
import { Sparkles } from "lucide-react";

/** Which brain the agent thinks with — a click opens Settings → Brain. */
export function BrainPill({ status }: { status: BrainStatus | null }) {
  if (!status) return null;
  const problem = status.configured ? status.lastError : null;
  const look = !status.configured || problem
    ? "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
    : "border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20";
  const label = !status.configured ? "Add Gemini key" : problem ? "Gemini: problem" : status.modelLabel;
  const title = !status.configured
    ? "The agent needs a Gemini API key to think — add one in Settings → Brain (it's free)"
    : problem
      ? `${problem.message} (Settings → Brain)`
      : `The agent thinks with ${status.modelLabel} — Settings → Brain`;
  return (
    <Link
      to="/settings/brain"
      title={title}
      data-testid="brain-pill"
      className={`hidden sm:flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-semibold font-mono transition-colors ${look}`}
    >
      <Sparkles className="h-3 w-3" />
      {label}
    </Link>
  );
}
