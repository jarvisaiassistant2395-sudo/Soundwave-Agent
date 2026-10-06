// ── The agent's mode, saved on this PC ──────────────────────────────────────
// Settings → Modes (and the Command Center's mode picker) write here; the chat
// instruction, the morning briefing and the canned lines read it. Saved in
// DATA_DIR/persona.json, the same way brain.json and memory.json are — one
// machine, one assistant, and the phone is told the choice in the brain kit.
//
// The catalog itself (what each mode says and does) is brain/core/persona.ts,
// which the phone app compiles too.

import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import {
  DEFAULT_PERSONA,
  PERSONA_IDS,
  isPersonaId,
  personaAddress,
  personaById,
  personaCatalog,
  type PersonaId,
} from "./core/persona.js";

export interface PersonaSettings {
  /** The mode the agent speaks in. */
  persona: PersonaId;
  /** How it addresses the person, for the modes that use a title (“sir”, a first name…). */
  address?: string;
  updatedAt?: string;
}

export type PersonaPatch = { persona?: PersonaId; address?: string | null };

/** Longest form of address we keep — one or two words, never a sentence. */
export const MAX_ADDRESS_CHARS = 24;

function fileFor(): string {
  return path.join(config.dataDir, "persona.json");
}

// Kept in step with the file the way the added-niche store is: the settings are
// read once, and re-read when the file appears, changes or goes away (another
// window, the phone, or a test tidying DATA_DIR).
let cache: { file: string; mtimeMs: number; settings: PersonaSettings } | null = null;

/** A form of address is one short line of text, not a prompt to paste into. */
export function cleanAddress(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[<>{}\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.slice(0, MAX_ADDRESS_CHARS);
}

export function loadPersonaSettings(): PersonaSettings {
  const file = fileFor();
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (cache?.file === file && cache.mtimeMs === mtimeMs) return cache.settings;
  let settings: PersonaSettings = { persona: DEFAULT_PERSONA };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    settings = {
      persona: isPersonaId(raw.persona) ? raw.persona : DEFAULT_PERSONA,
      ...(cleanAddress(raw.address) ? { address: cleanAddress(raw.address)! } : {}),
      ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    };
  } catch {
    /* first run, or unreadable: the default mode */
  }
  cache = { file, mtimeMs, settings };
  return settings;
}

export function savePersonaSettings(patch: PersonaPatch): PersonaSettings {
  const current = loadPersonaSettings();
  const next: PersonaSettings = { persona: current.persona, ...(current.address ? { address: current.address } : {}) };
  if (patch.persona !== undefined) {
    if (!isPersonaId(patch.persona)) throw new Error(`Unknown mode: ${String(patch.persona)} (expected one of ${PERSONA_IDS.join(", ")})`);
    next.persona = patch.persona;
  }
  if (patch.address !== undefined) {
    const address = cleanAddress(patch.address);
    if (address) next.address = address;
    else delete next.address;
  }
  next.updatedAt = new Date().toISOString();

  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* just written; the next read will pick it up */
  }
  cache = { file, mtimeMs, settings: next };
  return next;
}

/** The mode in use right now — the id and the form of address, never throws. */
export function activePersona(): { id: PersonaId; address: string | null } {
  const settings = loadPersonaSettings();
  const persona = personaById(settings.persona);
  return { id: persona.id, address: personaAddress(persona, settings.address) };
}

/** For the API and the apps: the catalog, the current mode and its address. */
export function personaStatus() {
  const settings = loadPersonaSettings();
  const persona = personaById(settings.persona);
  return {
    personas: personaCatalog(),
    current: {
      persona: persona.id,
      name: persona.name,
      tagline: persona.tagline,
      address: personaAddress(persona, settings.address),
      addressSet: Boolean(settings.address),
      addresses: persona.addresses === true,
    },
    defaultPersona: DEFAULT_PERSONA,
    updatedAt: settings.updatedAt ?? null,
  };
}

export function resetPersonaSettingsForTests(): void {
  cache = null;
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}
