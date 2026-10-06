import { MessageSquareText } from "lucide-react";
import { cn } from "../../lib/cn";
import { toast } from "../../store/toast";
import { SettingsCard } from "../../components/ui/SettingsCard";
import { modeIcon } from "../../components/agent/ModePill";
import { useAgentMode } from "../../lib/agentMode";

// ── Settings → Personality ──────────────────────────────────────────────────
// How the agent talks: the same assistant, the same tools and the same facts, in
// one of six registers. Chosen here, in the Command Center's header pill, or by
// just saying "be more formal" (its set_agent_mode tool).
//
// What it does NOT touch is written on the page, because it's the first thing
// people worry about: the shorts, their narrations and the morning briefing are
// made for an audience, and an executive-assistant voice saying "sir" to
// strangers would ruin them. Server side: lib/agentMode.ts + core/persona.ts.

export function PersonalityTab() {
  const { status, mode, modes, setMode, busy, error } = useAgentMode();

  if (!status) {
    return (
      <SettingsCard title="How the agent talks" icon={<MessageSquareText className="h-4 w-4" />}>
        <p className="text-sm text-gray-500">Reading the current mode…</p>
      </SettingsCard>
    );
  }

  const editable = status.editable !== false;

  const choose = async (id: typeof mode & string, name: string) => {
    if (!editable || busy || id === mode) return;
    await setMode(id);
    toast.success(`${name} mode`, "That's how I'll talk from the next reply.");
  };

  return (
    <>
      <SettingsCard title="How the agent talks" icon={<MessageSquareText className="h-4 w-4" />}>
        <p className="mb-4 text-sm text-gray-400">
          Six ways of answering, one assistant. The mode changes the tone of chat replies and nothing else — the same tools, the
          same memory, the same facts, and the same rules about never inventing one.
        </p>

        {!editable && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" data-testid="mode-locked">
            This Soundwave runs on a server rather than your own PC, so the mode is set by whoever runs it and can't be changed
            from here.
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100" data-testid="mode-error">
            {error}
          </div>
        )}

        <div className="grid gap-2.5 sm:grid-cols-2" role="radiogroup" aria-label="How the agent talks">
          {modes.map((m) => {
            const selected = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!editable || busy}
                onClick={() => void choose(m.id, m.name)}
                data-testid={`mode-${m.id}`}
                data-selected={selected ? "true" : "false"}
                className={cn(
                  "flex items-start gap-3 rounded-card border p-3.5 text-left transition-colors",
                  selected
                    ? "border-blue-500/50 bg-blue-500/10"
                    : "border-gray-800 bg-surface-subtle hover:border-white/15 hover:bg-surface-hover",
                  (!editable || busy) && "cursor-not-allowed opacity-50",
                )}
              >
                <span className={cn("mt-0.5 shrink-0", selected ? "text-blue-400" : "text-gray-500")}>{modeIcon(m.id, "h-4 w-4")}</span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm font-semibold", selected ? "text-white" : "text-gray-200")}>
                    {m.name}
                    {selected && <span className="ml-2 text-xs font-normal text-blue-300">in use</span>}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-gray-400">{m.tagline}</span>
                  <span className="mt-1.5 block text-xs text-gray-600">Addresses you: {m.addresses}</span>
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-gray-500">
          You can also just ask — “be more formal”, “act like my executive assistant”, “keep it short”, “stop with the jokes” —
          and the agent switches itself. The pill in the Command Center's header follows, so you can see which mode answered.
        </p>
      </SettingsCard>

      <SettingsCard title="What a mode never changes" icon={<MessageSquareText className="h-4 w-4" />}>
        <ul className="space-y-2 text-sm text-gray-400">
          <li>
            <span className="text-gray-200">Your shorts and their narration.</span> Those are written for whoever watches them, so
            they keep the researched hook shapes and beat structure in every mode. A Professional agent does not make videos that
            say “sir” to strangers.
          </li>
          <li>
            <span className="text-gray-200">The morning briefing.</span> Same research, same weather, same ideas — only the chat
            replies change.
          </li>
          <li>
            <span className="text-gray-200">What it can do, or how carefully.</span> Tools, memory and the rule against inventing a
            fact are the same in every mode. If a mode's register doesn't fit the moment — bad news, an error, a frustrated
            question — the agent drops the register and answers plainly.
          </li>
          <li>
            <span className="text-gray-200">The voice that reads replies aloud.</span> That's Settings → Voice &amp; Desktop.
          </li>
        </ul>
      </SettingsCard>
    </>
  );
}
