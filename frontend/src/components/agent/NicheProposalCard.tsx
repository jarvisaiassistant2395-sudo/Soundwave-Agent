import { useState } from "react";
import { Check, ChevronDown, ExternalLink, Sparkles, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { compactViews, proposalAge, type NicheProposal } from "../../lib/niches";

/**
 * A niche the agent found going viral, waiting on a yes or a no.
 *
 * It shows the evidence rather than asking to be trusted: what the agent says it
 * saw, and the actual Shorts the free scan found climbing on it, with their view
 * counts and links. Accepting puts it in the picker and makes it a niche scripts
 * are really written for; dismissing tells the agent not to bring it up again.
 * Nothing happens until one of those is pressed — that's the point of it.
 */
export function NicheProposalCard({
  proposal,
  busy,
  onAccept,
  onDismiss,
}: {
  proposal: NicheProposal;
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const leads = proposal.leads ?? [];
  const strongest = leads.reduce((best, l) => Math.max(best, l.views || 0), 0);

  return (
    <div className="rounded-card border border-fuchsia-500/25 bg-fuchsia-500/[0.04] p-3" data-testid={`niche-proposal-${proposal.id}`}>
      <div className="flex items-start gap-2.5">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fuchsia-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold text-white">{proposal.name}</span>
            <span className="rounded bg-fuchsia-500/15 px-1.5 py-px text-3xs font-bold text-fuchsia-300">FOUND</span>
            <span className="text-xs text-gray-500">proposed {proposalAge(proposal.proposedAt)}</span>
          </div>
          <p className="mt-0.5 text-xs leading-snug text-gray-400">{proposal.description}</p>
        </div>
      </div>

      {/* Why it's worth having — the agent's own words, and the numbers behind them. */}
      <p className="mt-2.5 border-l-2 border-fuchsia-500/30 pl-2.5 text-xs leading-relaxed text-gray-300" data-testid={`niche-proposal-evidence-${proposal.id}`}>
        {proposal.evidence}
      </p>

      {leads.length > 0 && (
        <ul className="mt-2 space-y-1">
          {leads.flatMap((l) => l.examples).slice(0, 3).map((ex) => (
            <li key={ex.url} className="flex items-baseline gap-1.5 text-xs text-gray-500">
              <span className="shrink-0 font-mono text-gray-400">{compactViews(ex.views)}</span>
              <a
                href={ex.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1 hover:text-gray-300"
                title={ex.title}
              >
                <span className="truncate">{ex.title}</span>
                <ExternalLink className="h-2.5 w-2.5 shrink-0" />
              </a>
            </li>
          ))}
        </ul>
      )}

      {/* What a script would actually be written from — the part that decides
          whether this is a niche or just a topic with a good week. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-2.5 inline-flex cursor-pointer items-center gap-1 text-xs text-gray-500 hover:text-gray-300"
        data-testid={`niche-proposal-details-${proposal.id}`}
      >
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
        {open ? "Hide" : "Show"} what a script would be written from
        {strongest > 0 && !open && <span className="text-gray-600">· {compactViews(strongest)} views on the strongest</span>}
      </button>
      {open && (
        <dl className="mt-2 space-y-1.5 text-xs">
          <div>
            <dt className="text-gray-500">Who watches it</dt>
            <dd className="text-gray-300">{proposal.audience}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Where the ideas come from</dt>
            <dd className="text-gray-300">
              <ul className="mt-0.5 space-y-0.5">
                {(proposal.angles ?? []).map((a) => (
                  <li key={a}>· {a}</li>
                ))}
              </ul>
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">The one thing that kills it</dt>
            <dd className="text-gray-300">{proposal.never}</dd>
          </div>
          {(proposal.sources ?? []).length > 0 && (
            <div>
              <dt className="text-gray-500">Seen in</dt>
              <dd className="text-gray-400">{proposal.sources.join(" · ")}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onAccept}
          disabled={busy}
          data-testid={`niche-proposal-accept-${proposal.id}`}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          Add to my topics
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          data-testid={`niche-proposal-dismiss-${proposal.id}`}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-gray-400 transition-colors hover:border-white/20 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          Not for me
        </button>
        <span className="ml-auto text-3xs leading-tight text-gray-600">Nothing is added until you say so</span>
      </div>
    </div>
  );
}
