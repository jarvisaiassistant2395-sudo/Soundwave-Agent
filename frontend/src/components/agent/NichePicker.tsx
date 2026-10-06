import { useCallback, useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "../../store/toast";
import { NicheButton, NICHES, nicheInfoFrom } from "./niches";
import { NicheProposalCard } from "./NicheProposalCard";
import { useNiches } from "../../lib/niches";

/**
 * The Generate tab's topic picker: the researched niches, plus any the agent
 * found going viral, plus the proposals waiting on a decision.
 *
 * It owns its own fetch, so the list is only asked for when the "New short"
 * modal is actually open, and it is the reason the picker can no longer drift
 * from the server — before, the app had its own hardcoded copy of the nine and a
 * backend test compared the two files as strings.
 *
 * While the server hasn't answered (or can't), the researched nine still render
 * from the local copy: a person who opens the app offline can still make a short.
 */
export function NichePicker({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  const { niches, proposals, leads, counts, loading, error, deciding, accept, dismiss } = useNiches();
  // Which niche's "i" is open. The picker's own business — the screen doesn't
  // need to know, and keeping it here is one less piece of state up there.
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = niches.length ? niches.map(nicheInfoFrom) : NICHES;

  const onAccept = useCallback(
    async (id: string, name: string) => {
      await accept(id);
      // Accepted in the middle of "make me a short" means they want to make one:
      // pick it, and say so, rather than leaving them to find it in the grid.
      onSelect(id);
      toast.success("Added to your topics", `“${name}” is on the list now, and selected.`);
    },
    [accept, onSelect],
  );

  const onDismiss = useCallback(
    async (id: string, name: string) => {
      await dismiss(id);
      toast.info("Dismissed", `“${name}” won't be suggested again.`);
    },
    [dismiss],
  );

  return (
    <div className="space-y-3">
      {proposals.length > 0 && (
        <div className="space-y-2" data-testid="niche-proposals">
          <p className="flex items-center gap-1.5 text-xs text-gray-400">
            <Sparkles className="h-3 w-3 text-fuchsia-400" />
            The agent found {proposals.length === 1 ? "a topic" : `${proposals.length} topics`} going viral that your list doesn't
            cover
          </p>
          {proposals.map((p) => (
            <NicheProposalCard
              key={p.id}
              proposal={p}
              busy={deciding === p.id}
              onAccept={() => void onAccept(p.id, p.name)}
              onDismiss={() => void onDismiss(p.id, p.name)}
            />
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label className="font-semibold text-gray-300" htmlFor="niche-grid">
            Topic
          </label>
          {counts.accepted > 0 && (
            <span className="text-3xs text-fuchsia-300/80" title="Niches the agent found and you accepted">
              {counts.accepted} found by the agent
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" id="niche-grid">
          {list.map((n) => (
            <NicheButton
              key={n.id}
              niche={n}
              selected={selected === n.id}
              expanded={expanded === n.id}
              onSelect={() => onSelect(n.id)}
              onToggleInfo={() => setExpanded((was) => (was === n.id ? null : n.id))}
            />
          ))}
        </div>
        {loading && (
          <p className="text-3xs text-gray-600" data-testid="niche-loading">
            Checking for anything new…
          </p>
        )}
        {error && (
          <p className="text-3xs leading-snug text-amber-300/80" data-testid="niche-error">
            Couldn't reach the server for the newest list ({error}) — showing the researched topics.
          </p>
        )}
        {/* What the free scan saw climbing that isn't on the list yet. Without
            this the whole feature waits on the person happening to ask the agent
            "what's trending" — the leads are already in the answer above, and a
            topic nobody can see might as well not have been found. It's a line,
            not a card: the agent writes a real proposal, with an audience and
            angles and the trap that kills it, and that's what gets accepted. */}
        {proposals.length === 0 && leads.length > 0 && (
          <p className="text-3xs leading-snug text-gray-500" data-testid="niche-leads">
            Climbing right now and not on your list:{" "}
            <span className="text-gray-400">
              {leads
                .slice(0, 4)
                .map((l) => l.topic)
                .join(", ")}
              {leads.length > 4 ? "…" : ""}
            </span>
            . Ask the agent to write one up and it lands here for you to accept.
          </p>
        )}
      </div>
    </div>
  );
}
