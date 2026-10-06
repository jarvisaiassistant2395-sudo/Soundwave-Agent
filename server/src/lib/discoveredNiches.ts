// ── Niches the agent found, and the ones the person accepted ────────────────
// The nine niches in brain/core/viral.ts are researched and fixed: they are the
// floor that keeps working. This is the ceiling — what is climbing right now
// that none of them covers.
//
// Nothing here decides anything on its own. The trend scout (lib/trends.ts,
// lib/shortsTrends.ts) works out which topics are climbing *outside* the list,
// for free, with no AI call; the agent turns one of those into a real proposal
// with propose_niche, naming it, saying who watches it, what the angles are and
// what kills it; and the person accepts or dismisses it in the Generate tab.
// Only an accepted one becomes a niche scripts are written for.
//
// That order matters. A scan can be wrong, a model can be enthusiastic about
// something that isn't a niche, and the list on the Generate tab is the one the
// person looks at every day — so it is theirs to approve, not theirs to prune
// after the fact.
//
// Saved on this PC in DATA_DIR/niches.json, next to brain.json and agent-mode.json.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { HOOK_PATTERNS, NICHES, SAMPLE_SCRIPTS, hookById, matchNiche, type Niche } from "./brain/core/viral.js";
import type { NicheLead } from "./shortsTrends.js";

export type { NicheLead };

/** Hook shapes offered to a new niche when the agent doesn't pick any. These
 *  three are the ones that work on a topic nobody has written for yet: a gap in
 *  a question, something nobody says, and a number that surprises. */
export const DEFAULT_DISCOVERED_HOOKS = ["question-gap", "secret", "number-tease"];

/** How many proposals are kept before the oldest decided ones are pruned. */
const MAX_PROPOSALS = 40;

export type ProposalStatus = "pending" | "accepted" | "dismissed";

/**
 * One suggested niche. The fields are the ones brain/core/viral.ts needs to
 * write a script for it — a name and a description are not enough, because the
 * brief tells the model who is watching, which hook shapes fit, where the ideas
 * come from and what ruins this kind of video. A proposal that can't supply
 * those is refused rather than stored half-formed.
 */
export interface NicheProposal {
  id: string;
  name: string;
  /** What the picker calls it — Niche.short. */
  description: string;
  audience: string;
  angles: string[];
  hooks: string[];
  never: string;
  /** Why this is worth having: what was seen, and how fast it was climbing. */
  evidence: string;
  /** Where it was seen (page titles, "YouTube search", "Google Trends"). */
  sources: string[];
  /** The scan's own leads behind it, so the card can show real Shorts. */
  leads: NicheLead[];
  status: ProposalStatus;
  proposedAt: number;
  decidedAt: number | null;
  /** True once it has been accepted, so the UI can mark it and allow removal. */
  discovered: true;
}

interface FileShape {
  proposals: NicheProposal[];
  updatedAt?: string;
}

function fileFor(): string {
  return path.join(config.dataDir, "niches.json");
}

let cache: { file: string; data: FileShape } | null = null;

function read(): FileShape {
  const file = fileFor();
  if (cache?.file === file) return cache.data;
  let data: FileShape = { proposals: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<FileShape>;
    const proposals = Array.isArray(raw.proposals) ? raw.proposals.filter(isProposal) : [];
    data = { proposals };
  } catch {
    /* first run, or unreadable: nothing discovered yet */
  }
  cache = { file, data };
  return data;
}

/** A hand-edited or half-written file must not crash the Generate tab. */
function isProposal(value: unknown): value is NicheProposal {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.description === "string" &&
    Array.isArray(p.angles) &&
    (p.status === "pending" || p.status === "accepted" || p.status === "dismissed")
  );
}

function write(next: NicheProposal[]): NicheProposal[] {
  // Decided ones are history, not a queue: keep the newest and let the rest go,
  // so a year of scanning can't grow this file without bound.
  const pending = next.filter((p) => p.status === "pending");
  const decided = next
    .filter((p) => p.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
    .slice(0, Math.max(0, MAX_PROPOSALS - pending.length));
  const kept = [...pending, ...decided];

  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload: FileShape = { proposals: kept, updatedAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = { file, data: payload };
  return kept;
}

/** "Quantum Computing" → "quantum-computing". Readable in a URL and as an id. */
export function nicheIdFromName(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export function listNicheProposals(status?: ProposalStatus): NicheProposal[] {
  const all = read().proposals;
  const list = status ? all.filter((p) => p.status === status) : all;
  // Newest first: the person sees what the agent just found at the top.
  return list.slice().sort((a, b) => b.proposedAt - a.proposedAt);
}

/** The accepted ones, as real niches the script engine can write for. */
export function discoveredNiches(): Niche[] {
  return listNicheProposals("accepted").map(asNiche).reverse();
}

/** Built-ins first (they are the researched floor), then what was discovered. */
export function allNiches(): Niche[] {
  return [...NICHES, ...discoveredNiches()];
}

function asNiche(p: NicheProposal): Niche {
  return {
    id: p.id,
    name: p.name,
    short: p.description,
    audience: p.audience,
    hooks: p.hooks,
    angles: p.angles,
    never: p.never,
  };
}

/**
 * Which niche to write for. A discovered one is matched exactly (by id or name)
 * before the built-ins are guessed at, because `detectNiche` answers "facts" for
 * anything it doesn't recognise — and quietly turning an accepted new niche back
 * into Mind-Bending Facts would make accepting it pointless.
 */
export function resolveNiche(idOrTopic: string | undefined): Niche {
  const t = String(idOrTopic ?? "").toLowerCase().trim();
  if (t) {
    const found = discoveredNiches().find((n) => n.id === t || n.name.toLowerCase() === t);
    if (found) return found;
  }
  // A discovered niche's own words in a loose topic count too — "the quantum
  // computing one" should reach the niche, not fall through to facts.
  if (t) {
    const byWord = discoveredNiches().find((n) => t.includes(n.id.replace(/-/g, " ")) || t.includes(n.name.toLowerCase()));
    if (byWord) return byWord;
  }
  // And the fallback is exactly the one detectNiche has always had: a topic
  // nothing recognises is written as Mind-Bending Facts. Falling back to the
  // newest discovered niche instead would quietly route every unrecognised topic
  // into whatever the agent proposed last.
  return matchNiche(t) ?? NICHES[1]!;
}

/** The catalog the app and the API expose: the nine, plus what was accepted. */
export function fullNicheCatalog(): Array<{
  id: string;
  name: string;
  description: string;
  hooks: string[];
  sampleScripts: string[];
  audience: string;
  angles: string[];
  never: string;
  discovered: boolean;
  addedAt: number | null;
}> {
  const builtins = NICHES.map((n) => ({
    id: n.id,
    name: n.name,
    description: n.short,
    hooks: n.hooks.map((h) => hookById(h)?.example ?? h),
    sampleScripts: sampleScriptsFor(n.id),
    audience: n.audience,
    angles: n.angles,
    never: n.never,
    discovered: false,
    addedAt: null,
  }));
  const found = listNicheProposals("accepted")
    .slice()
    .reverse()
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      hooks: p.hooks.map((h) => hookById(h)?.example ?? h),
      sampleScripts: [] as string[],
      audience: p.audience,
      angles: p.angles,
      never: p.never,
      discovered: true,
      addedAt: p.decidedAt,
    }));
  return [...builtins, ...found];
}

export type ProposeInput = {
  name?: unknown;
  description?: unknown;
  audience?: unknown;
  angles?: unknown;
  hooks?: unknown;
  never?: unknown;
  evidence?: unknown;
  sources?: unknown;
  leads?: unknown;
};

export type ProposeResult = { ok: true; proposal: NicheProposal; alreadyPending?: boolean } | { ok: false; reason: string };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const strList = (v: unknown, max: number, each: number): string[] =>
  Array.isArray(v)
    ? v.map((x) => str(x, each)).filter((x) => x.length > 0).slice(0, max)
    : [];

/**
 * Store a niche the agent found. Returns a reason rather than throwing, because
 * the caller is a tool result the model reads and then tells the person about:
 * "that's already on the list" and "you dismissed that on Tuesday" are both
 * useful answers, and neither is an error.
 */
export function proposeNiche(input: ProposeInput): ProposeResult {
  const name = str(input.name, 60);
  const description = str(input.description, 140);
  const audience = str(input.audience, 220);
  const never = str(input.never, 220);
  const evidence = str(input.evidence, 600);
  const angles = strList(input.angles, 8, 140);
  const sources = strList(input.sources, 6, 160);

  const missing: string[] = [];
  if (name.length < 3) missing.push("a name");
  if (description.length < 3) missing.push("a one-line description");
  if (audience.length < 3) missing.push("who watches it");
  if (never.length < 3) missing.push("the one thing that kills it");
  if (evidence.length < 3) missing.push("what was seen that makes this worth having");
  if (angles.length < 2) missing.push("at least two angles the ideas come from");
  if (missing.length) {
    return {
      ok: false,
      reason: `A niche needs ${missing.join(", ")}. Without those the script engine has nothing to write from and the person has nothing to judge it by.`,
    };
  }

  const id = nicheIdFromName(name);
  if (id.length < 3) return { ok: false, reason: `“${name}” doesn't give me a usable id — try a plainer name.` };

  if (NICHES.some((n) => n.id === id || n.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, reason: `“${name}” is already one of the standing niches — nothing to add.` };
  }
  const existing = read().proposals.find((p) => p.id === id || p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.status === "accepted") return { ok: false, reason: `“${existing.name}” is already on the Generate tab.` };
    if (existing.status === "pending") {
      return { ok: true, proposal: existing, alreadyPending: true };
    }
    return {
      ok: false,
      reason: `“${existing.name}” was proposed on ${new Date(existing.proposedAt).toLocaleDateString()} and dismissed — don't propose it again unless the person asks.`,
    };
  }
  // A topic that reads as a niche we already cover isn't new, whatever the scan
  // thought: "the psychology of pricing" is finance or psychology, not a niche.
  const covered = matchNiche(`${name} ${description} ${angles.join(" ")}`);
  if (covered) {
    return {
      ok: false,
      reason: `That's ${covered.name} — already on the list. Only propose a niche when nothing standing covers it.`,
    };
  }

  const wanted = strList(input.hooks, 6, 30);
  const known = HOOK_PATTERNS.map((h) => h.id);
  const hooks = wanted.filter((h) => known.includes(h));
  const leads = Array.isArray(input.leads)
    ? (input.leads.filter((l): l is NicheLead => Boolean(l) && typeof l === "object" && typeof (l as NicheLead).topic === "string")).slice(0, 4)
    : [];

  const proposal: NicheProposal = {
    id,
    name,
    description,
    audience,
    angles,
    // Unknown hook ids are dropped rather than stored: the script brief looks
    // each one up, and one it can't find would leave a gap in the instruction.
    hooks: hooks.length ? hooks : DEFAULT_DISCOVERED_HOOKS,
    never,
    evidence,
    sources,
    leads,
    status: "pending",
    proposedAt: Date.now(),
    decidedAt: null,
    discovered: true,
  };
  write([...read().proposals, proposal]);
  return { ok: true, proposal };
}

/**
 * Accept or dismiss. Returns null when there's no such proposal *waiting* —
 * one already decided counts as not waiting, so a second click (or a second
 * call from the agent) can't quietly reverse the first. Taking an accepted
 * niche back off the tab is removeDiscoveredNiche, which is a different
 * question and says what it did.
 */
export function decideNicheProposal(id: string, decision: "accepted" | "dismissed"): NicheProposal | null {
  const wanted = String(id ?? "").trim().toLowerCase();
  const proposals = read().proposals;
  const found = proposals.find((p) => p.status === "pending" && (p.id === wanted || p.name.toLowerCase() === wanted));
  if (!found) return null;
  const next: NicheProposal = { ...found, status: decision, decidedAt: Date.now() };
  write(proposals.map((p) => (p.id === found.id ? next : p)));
  return next;
}

/** Take an accepted niche back off the Generate tab. Built-ins can't be removed. */
export function removeDiscoveredNiche(id: string): boolean {
  const wanted = String(id ?? "").trim().toLowerCase();
  const proposals = read().proposals;
  if (!proposals.some((p) => p.id === wanted && p.status === "accepted")) return false;
  write(proposals.filter((p) => p.id !== wanted));
  return true;
}

/** How many proposals are waiting on the person, and how many they accepted. */
export function discoveredNicheCounts(): { pending: number; accepted: number } {
  return { pending: listNicheProposals("pending").length, accepted: listNicheProposals("accepted").length };
}

// The sample scripts live in core/viral.ts, which stays pure and import-free;
// its SAMPLE_SCRIPTS map is read here rather than adding a lookup to core. A
// discovered niche simply has none, and pickTemplate already falls back.
function sampleScriptsFor(id: string): string[] {
  return SAMPLE_SCRIPTS[id] ?? [];
}

/** Only the tests call this: drop the in-memory copy so the file is read again. */
export function _forgetDiscoveredNicheCacheForTests(): void {
  cache = null;
}

/** Only the tests call this: forget the file so the next read starts clean. */
export function _resetDiscoveredNichesForTests(): void {
  cache = null;
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing on disk */
  }
}
