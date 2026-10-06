// ── Which mode the agent talks in ───────────────────────────────────────────
// The Command Center's header pill, Settings → Personality, and the agent's own
// set_agent_mode tool all read and write this one setting. The modes themselves
// — what each one says to Gemini — live in brain/core/persona.ts, which is pure
// so the phone app shares it; this file is the half that touches the disk.
//
// Saved on this PC in DATA_DIR/agent-mode.json, next to brain.json, with the
// same desktop-app-only rule: on a hosted server the mode is whoever's
// installation it is, and GEMINI_API_KEY setups change it in the environment.
//
// The stored id is re-validated on every read. A mode that is renamed or retired
// in an update falls back to the default rather than leaving the agent talking
// in a voice nobody can select or turn off.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { AGENT_MODES, DEFAULT_MODE, isAgentMode, modeById, type AgentMode } from "./brain/core/persona.js";

export { AGENT_MODES, DEFAULT_MODE, modeById };
export type { AgentMode };

/** Set AGENT_MODE=professional to start an installation in a given mode. */
function envMode(): AgentMode | null {
  const raw = process.env.AGENT_MODE;
  return isAgentMode(raw?.trim().toLowerCase()) ? (raw!.trim().toLowerCase() as AgentMode) : null;
}

function fileFor(): string {
  return path.join(config.dataDir, "agent-mode.json");
}

let cache: { file: string; mode: AgentMode } | null = null;

/** The mode in force right now: the saved one, else the environment's, else the default. */
export function loadAgentMode(): AgentMode {
  const file = fileFor();
  if (cache?.file === file) return cache.mode;
  let mode: AgentMode = envMode() ?? DEFAULT_MODE;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    // A stale or hand-edited file naming a mode that no longer exists must not
    // strand the agent in a voice the picker can't show.
    if (isAgentMode(raw.mode)) mode = raw.mode;
  } catch {
    /* first run, or unreadable: the environment's choice or the default */
  }
  cache = { file, mode };
  return mode;
}

export function saveAgentMode(mode: AgentMode): AgentMode {
  const next = modeById(mode).id;
  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ mode: next, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = { file, mode: next };
  return next;
}

/** What the pill and Settings → Personality render: the choice and every option. */
export function agentModeStatus(): {
  mode: AgentMode;
  name: string;
  tagline: string;
  addresses: string;
  /** Where the choice came from, so the UI can say why it can't be changed. */
  source: "saved" | "environment" | "default";
  editable: boolean;
  modes: Array<{ id: AgentMode; name: string; tagline: string; addresses: string }>;
} {
  const mode = loadAgentMode();
  const chosen = modeById(mode);
  const saved = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as Record<string, unknown>;
      return isAgentMode(raw.mode);
    } catch {
      return false;
    }
  })();
  return {
    mode,
    name: chosen.name,
    tagline: chosen.tagline,
    addresses: chosen.addresses,
    source: saved ? "saved" : envMode() ? "environment" : "default",
    editable: config.brainSettingsAvailable,
    modes: AGENT_MODES.map((m) => ({ id: m.id, name: m.name, tagline: m.tagline, addresses: m.addresses })),
  };
}

/** Only the tests call this: forget the in-memory copy so the file is read again. */
export function _resetAgentModeForTests(): void {
  cache = null;
}
