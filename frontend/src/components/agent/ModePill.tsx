import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Briefcase, Feather, Laugh, Settings as SettingsIcon, Smile, Target, Zap } from "lucide-react";
import { Dropdown, type DropdownItem } from "../ui/Dropdown";
import { toast } from "../../store/toast";
import { useAgentMode, type AgentMode } from "../../lib/agentMode";

/**
 * One icon per mode, so the pill and the Settings page mean the same thing by
 * the same picture. Kept here rather than server-side: which glyph stands for
 * "concise" is a presentation choice, and persona.ts is shared with the phone
 * app, which has its own.
 */
const MODE_ICONS: Record<AgentMode, typeof Briefcase> = {
  professional: Briefcase,
  friendly: Smile,
  concise: Zap,
  coach: Target,
  witty: Laugh,
  narrator: Feather,
};

export function modeIcon(mode: AgentMode, className = "h-3 w-3") {
  const Icon = MODE_ICONS[mode] ?? Smile;
  return <Icon className={className} />;
}

/**
 * How the agent is talking right now, in the Command Center's header next to
 * the Gemini pill — one click to change it, because "be more formal" is the
 * kind of thing you want in the moment rather than after a trip to Settings.
 *
 * It polls (see useAgentMode), so when the agent switches itself in reply to
 * something you said, the pill follows instead of contradicting the chat.
 */
export function ModePill() {
  const { status, mode, modes, setMode, busy, error } = useAgentMode();
  const navigate = useNavigate();

  const choose = useCallback(
    async (next: AgentMode, name: string) => {
      await setMode(next);
      if (next === mode) return;
      toast.success(`${name} mode`, "That's how I'll talk from the next reply.");
    },
    [setMode, mode],
  );

  if (!status || !mode) return null;

  const editable = status.editable !== false;
  const items: DropdownItem[] = [
    ...modes.map((m) => ({
      key: m.id,
      label: m.name,
      hint: m.tagline,
      selected: m.id === mode,
      disabled: busy || !editable,
      icon: modeIcon(m.id, "h-3.5 w-3.5 text-gray-400"),
      onClick: () => void choose(m.id, m.name),
    })),
    {
      key: "settings",
      label: "Personality settings",
      icon: <SettingsIcon className="h-3.5 w-3.5 text-gray-400" />,
      onClick: () => navigate("/settings/personality"),
    },
  ];

  const title = editable
    ? `The agent is talking in ${status.name} mode — ${status.tagline} Click to change it.`
    : `The agent is talking in ${status.name} mode. It's set by whoever runs this server, so it can't be changed from here.`;

  return (
    <Dropdown
      label="How the agent talks"
      align="right"
      items={items}
      trigger={
        <span
          role="button"
          tabIndex={0}
          title={title}
          aria-label={title}
          data-testid="mode-pill"
          data-mode={mode}
          className="hidden sm:flex cursor-pointer items-center gap-1.5 rounded-full border border-surface-border bg-surface-subtle px-2 py-0.5 font-mono text-xs font-semibold text-gray-300 transition-colors hover:border-white/20 hover:text-white"
        >
          {modeIcon(mode, "h-3 w-3 text-blue-400")}
          <span className="max-w-[9rem] truncate">{status.name}</span>
          {error && <span className="text-red-400" title={error}>!</span>}
        </span>
      }
    />
  );
}
