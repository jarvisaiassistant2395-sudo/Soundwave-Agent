// ── Niches the agent adds when something new starts going viral ─────────────
// The nine researched niches (brain/core/viral.ts) are the floor: they ship
// with the app and are always offered in the Generate tab. This store is the
// ceiling: what the agent — or the person — adds on top of them when this
// week's Shorts say a new subject is climbing.
//
//   • the agent adds one with its add_viral_niche tool while it is talking
//     about trends (“this week it's all morning-routine Shorts”), or
//   • the person presses Add on a suggestion in the Generate tab.
//
// Either way it lands in DATA_DIR/niches.json, is registered with the shared
// niche registry (so the scriptwriter, detectNiche and /niches all know it),
// and appears in the Generate tab badged as new. Nothing here invents data:
// a suggestion only exists when the trend scan actually saw those topics.
//
// The suggestion pass is deterministic (no Gemini, no key): it reads the
// digest lib/trends.ts saved from YouTube's own Shorts search, finds the
// subject words that keep appearing across channels, drops anything the
// researched niches already cover, and hands back the rest — with the Shorts
// that prove it.

import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { loadTrendDigest } from "../trends.js";
import { topTopics } from "../shortsTrends.js";
import { HOOK_PATTERNS, allNiches, detectNiche, nicheKeywords, registerExtraNiches, type AddedNiche, type Niche } from "./core/viral.js";

/** How many added niches the app keeps. Enough for a shifting few months. */
export const MAX_ADDED_NICHES = 12;
/** How many suggestions the Generate tab shows at once. */
export const MAX_SUGGESTIONS = 3;
/** An added niche stays “new” in the picker for this long. */
export const NICHE_FRESH_DAYS = 14;

const DAY_MS = 86_400_000;
const MAX_NAME = 40;
const MAX_SHORT = 120;
const MAX_AUDIENCE = 200;
const MAX_WHY = 400;
const MAX_ANGLE = 140;

/** The hook shapes an added niche starts with when the agent doesn't name any. */
const DEFAULT_HOOKS = ["question-gap", "number-tease", "contrarian"];

export interface AddNicheInput {
  name?: string;
  /** One line for the picker: what the niche is about. */
  short?: string;
  audience?: string;
  angles?: string[];
  hooks?: string[];
  never?: string;
  /** Why it is worth adding — the evidence the agent saw. */
  why?: string;
  source?: "agent" | "user";
}

export type AddNicheResult = { ok: true; niche: AddedNiche; created: boolean } | { ok: false; error: string };

export interface NicheSuggestion {
  /** The slug the niche would get if it is added. */
  id: string;
  name: string;
  short: string;
  why: string;
  /** The Shorts that made it a suggestion (titles, longest two). */
  evidence: string[];
  /** What those Shorts were worth, and how many different channels posted them. */
  views: number;
  shorts: number;
  channels: number;
}

function fileFor(): string {
  return path.join(config.dataDir, "niches.json");
}

const cleaner = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** A slug the API, the Generate button and the script cache can all carry. */
export function nicheSlug(name: string): string {
  return cleaner(name, MAX_NAME)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
}

function hooksFor(input: string[] | undefined): string[] {
  const valid = HOOK_PATTERNS.map((h) => h.id);
  const asked = (Array.isArray(input) ? input : []).map((h) => cleaner(h, 40).toLowerCase()).filter((h) => valid.includes(h));
  const list = [...new Set([...asked, ...DEFAULT_HOOKS])];
  return list.slice(0, 4);
}

function anglesFor(name: string, input: string[] | undefined): string[] {
  const asked = (Array.isArray(input) ? input : []).map((a) => cleaner(a, MAX_ANGLE)).filter((a) => a.length >= 8);
  if (asked.length >= 3) return asked.slice(0, 5);
  const subject = name.toLowerCase();
  const filler = [
    `the part of ${subject} nobody explains properly`,
    `a number in ${subject} that changes how it feels`,
    `the mistake people make with ${subject}`,
    `what changed recently in ${subject} and why it matters`,
  ];
  return [...new Set([...asked, ...filler])].slice(0, Math.max(3, asked.length + 1));
}

/** Turn loose model/person input into a niche the scriptwriter can really use. */
export function buildAddedNiche(input: AddNicheInput, now = Date.now()): AddNicheResult {
  const name = cleaner(input.name, MAX_NAME);
  if (name.length < 3) return { ok: false, error: "A niche needs a name of at least three characters." };
  const existing = allNiches().find((n) => n.name.toLowerCase() === name.toLowerCase());
  if (existing) return { ok: false, error: `There is already a niche called “${existing.name}” (id ${existing.id}) — use that one.` };

  const slug = nicheSlug(name);
  if (!slug) return { ok: false, error: "That name has no letters or numbers in it — give the niche a real name." };
  const id = allNiches().some((n) => n.id === slug) ? `topic-${slug}`.slice(0, 34) : slug;
  if (allNiches().some((n) => n.id === id)) return { ok: false, error: `“${name}” is already in the picker (id ${id}).` };

  const short = cleaner(input.short, MAX_SHORT) || `What is moving in ${name.toLowerCase()} right now`;
  const niche: AddedNiche = {
    id,
    name,
    short,
    audience:
      cleaner(input.audience, MAX_AUDIENCE) ||
      "The people already scrolling this subject every day — they want the one thing they didn't know.",
    hooks: hooksFor(input.hooks),
    angles: anglesFor(name, input.angles),
    never:
      cleaner(input.never, 240) ||
      "Never invent a fact, figure, name or quote for this niche — if you are not certain of the detail, say the true thing without it.",
    addedAt: now,
    source: input.source === "user" ? "user" : "agent",
    ...(cleaner(input.why, MAX_WHY) ? { why: cleaner(input.why, MAX_WHY) } : {}),
  };
  return { ok: true, niche, created: true };
}

// ── The file ────────────────────────────────────────────────────────────────

interface StoreFile {
  version: 1;
  niches: AddedNiche[];
}

function parseStored(raw: unknown): AddedNiche[] {
  const list = (raw as Partial<StoreFile> | null)?.niches;
  if (!Array.isArray(list)) return [];
  const out: AddedNiche[] = [];
  for (const entry of list) {
    const built = buildAddedNiche(
      {
        name: (entry as AddedNiche)?.name,
        short: (entry as AddedNiche)?.short,
        audience: (entry as AddedNiche)?.audience,
        angles: (entry as AddedNiche)?.angles,
        hooks: (entry as AddedNiche)?.hooks,
        never: (entry as AddedNiche)?.never,
        why: (entry as AddedNiche)?.why,
        source: (entry as AddedNiche)?.source,
      },
      Number((entry as AddedNiche)?.addedAt) || Date.now(),
    );
    // A stored entry that no longer builds (an old shape, a duplicate name) is
    // dropped rather than half-restored — the picker only ever shows working ones.
    if (built.ok && !out.some((n) => n.id === built.niche.id || n.name.toLowerCase() === built.niche.name.toLowerCase())) {
      out.push(built.niche);
    }
  }
  return out.slice(-MAX_ADDED_NICHES);
}

let cache: { file: string; mtimeMs: number; niches: AddedNiche[] } | null = null;
let registered = false;
/** The exact array handed to the shared registry last (compared by identity). */
let lastRegistered: AddedNiche[] | null = null;

/** The added niches, read from disk once and kept in step with the file. */
export function addedNiches(): AddedNiche[] {
  const file = fileFor();
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (!cache || cache.file !== file || cache.mtimeMs !== mtimeMs) {
    let niches: AddedNiche[] = [];
    try {
      niches = parseStored(JSON.parse(fs.readFileSync(file, "utf8")) as StoreFile);
    } catch {
      /* first run, or unreadable: no added niches */
    }
    cache = { file, mtimeMs, niches };
  }
  if (!registered || cache.niches !== lastRegistered) {
    registerExtraNiches(cache.niches);
    lastRegistered = cache.niches;
    registered = true;
  }
  return cache.niches;
}

function saveNiches(niches: AddedNiche[]): void {
  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, niches } satisfies StoreFile, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* just written; the next read will pick it up */
  }
  cache = { file, mtimeMs, niches };
  registerExtraNiches(niches);
  lastRegistered = niches;
  registered = true;
}

/** Add a niche (the agent's tool, or the Generate tab's Add button). */
export function addAddedNiche(input: AddNicheInput, now = Date.now()): AddNicheResult {
  const current = addedNiches();
  if (current.length >= MAX_ADDED_NICHES) {
    return {
      ok: false,
      error: `The picker already holds ${MAX_ADDED_NICHES} added niches — remove one first (remove_niche) before adding another.`,
    };
  }
  const built = buildAddedNiche(input, now);
  if (!built.ok) return built;
  const niches = [...current, built.niche].slice(-MAX_ADDED_NICHES);
  saveNiches(niches);
  return { ok: true, niche: built.niche, created: true };
}

/** Take a niche out of the picker. Returns the removed niche, or null. */
export function removeAddedNiche(id: string): AddedNiche | null {
  const wanted = cleaner(id, 40).toLowerCase();
  const current = addedNiches();
  const found = current.find((n) => n.id.toLowerCase() === wanted || n.name.toLowerCase() === wanted);
  if (!found) return null;
  saveNiches(current.filter((n) => n.id !== found.id));
  return found;
}

/** True while the picker should badge it as new. */
export function isFresh(niche: AddedNiche, now = Date.now()): boolean {
  return Boolean(niche.addedAt) && now - (niche.addedAt ?? 0) < NICHE_FRESH_DAYS * DAY_MS;
}

/** What the Generate tab shows: the added niches, newest first, and what's climbing. */
export function nichesStatus(now = Date.now()) {
  const added = addedNiches();
  return {
    added: [...added]
      .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
      .map((n) => ({
        id: n.id,
        name: n.name,
        description: n.short,
        source: n.source ?? "agent",
        ...(n.why ? { why: n.why } : {}),
        addedAt: n.addedAt ? new Date(n.addedAt).toISOString() : null,
        fresh: isFresh(n, now),
      })),
    suggestions: suggestNiches(),
    max: MAX_ADDED_NICHES,
  };
}

// ── What's climbing that the researched niches don't cover ──────────────────

const STOP_TOPIC = new Set([
  "shorts",
  "short",
  "viral",
  "video",
  "videos",
  "youtube",
  "trending",
  "fyp",
  "subscribe",
  "watch",
  "part",
  "this",
  "that",
  "with",
  "your",
  "from",
  "they",
  "them",
  "what",
  "when",
  "have",
  "just",
  "like",
  "into",
  "more",
  "most",
  "than",
  "then",
  "will",
  "would",
  "about",
  "every",
  "because",
  "people",
  "thing",
  "things",
]);

const words = (text: string): string[] =>
  String(text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 5 && !STOP_TOPIC.has(w));

/** A word's stem, loose enough that “routine” and “routines” are the same word. */
const stem = (w: string): string => w.slice(0, Math.max(5, w.length - 2));

/**
 * Does a researched (or already added) niche already cover this subject?
 * Word by word, against every niche's name, one-liner and angles: “morning
 * routine” is covered when a niche already talks about routines.
 */
export function coveredByNiche(topic: string, niches: Niche[] = allNiches()): boolean {
  const topicWords = words(topic);
  if (!topicWords.length) return true;
  for (const niche of niches) {
    const known = new Set<string>();
    for (const w of [...nicheKeywords(niche), ...words(niche.name), ...words(niche.short)]) {
      known.add(w);
      known.add(stem(w));
    }
    if (topicWords.some((w) => known.has(w) || known.has(stem(w)))) return true;
  }
  return false;
}

const fmtViews = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);

/**
 * The phrase the titles actually use around a subject word — “street food” for
 * “street”, “morning routine” for “routine”. Two words beat one in a picker,
 * and the phrase only wins when enough titles agree on it.
 */
export function phraseFor(topic: string, matches: Array<{ title: string }>): string {
  const counts = new Map<string, number>();
  for (const s of matches) {
    const tokens = s.title
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .filter(Boolean);
    const at = tokens.findIndex((t) => t === topic);
    if (at < 0) continue;
    for (const candidate of [
      [tokens[at - 1], tokens[at]],
      [tokens[at], tokens[at + 1]],
    ]) {
      const [a, b] = candidate as [string | undefined, string | undefined];
      if (!a || !b) continue;
      const other = a === topic ? b : a;
      if (other.length < 4 || STOP_TOPIC.has(other) || /^\d+$/.test(other)) continue;
      const phrase = `${a} ${b}`;
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : "";
}

const titleCase = (phrase: string): string =>
  phrase
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, MAX_NAME);

/**
 * Niches worth adding, from the last trend scan. Deterministic and honest: a
 * subject only appears when several different channels in this week's most
 * popular Shorts are posting about it and no niche covers it yet.
 */
// `now` used to be a parameter here and was never read — the caller passed it,
// the function ignored it, and the linter was the only thing that noticed.
export function suggestNiches(): NicheSuggestion[] {
  const digest = loadTrendDigest();
  if (!digest) return [];
  const added = addedNiches();
  const known: Niche[] = [...allNiches()];
  const taken = new Set([...added.map((n) => n.id), ...known.map((n) => n.name.toLowerCase())]);
  const pool = (digest.top ?? []).filter((s) => s.views > 0);
  const out: NicheSuggestion[] = [];
  const seenTopics = new Set<string>();

  const consider = (topic: string, opts: { requireShorts: boolean }) => {
    const clean = topic.trim().toLowerCase();
    if (clean.length < 5 || seenTopics.has(clean)) return;
    seenTopics.add(clean);
    if (taken.has(clean) || coveredByNiche(clean, known)) return;
    const matches = pool.filter((s) => s.title.toLowerCase().includes(clean) || words(s.title).includes(clean));
    const channels = new Set(matches.map((s) => s.channel ?? s.id)).size;
    const views = matches.reduce((sum, s) => sum + s.views, 0);
    // A subject needs to be real: several Shorts, from more than one channel.
    if (opts.requireShorts && (matches.length < 3 || channels < 2)) return;
    // One word is a search term; the niche people would recognise is usually the
    // phrase the titles use (“Street Food”, not “Street”).
    const phrase = phraseFor(clean, matches) || clean;
    for (const word of phrase.split(" ")) seenTopics.add(word);
    const titles = matches
      .slice()
      .sort((a, b) => b.views - a.views)
      .slice(0, 3)
      .map((s) => `${s.title}${s.channel ? ` — ${s.channel}` : ""} (${fmtViews(s.views)})`);
    out.push({
      id: `topic-${nicheSlug(phrase)}`.slice(0, 34),
      name: titleCase(phrase),
      short: `What is landing in ${phrase} Shorts this week`,
      why: matches.length
        ? `${matches.length} of this week's most-viewed Shorts are about ${phrase}, across ${channels} channels (${fmtViews(views)} views together) — none of the researched niches covers it.`
        : `“${topic.trim()}” is one of today's top Google searches and no niche covers it — a good moment to own the subject while people are looking.`,
      evidence: titles,
      views,
      shorts: matches.length,
      channels,
    });
  };

  // 1. Subject words that keep showing up across channels (the scan's own maths).
  for (const topic of topTopics(pool, 8)) consider(topic, { requireShorts: true });
  // 2. The day's Google searches (a subject about to break, before it has Shorts).
  for (const g of digest.googleTrends ?? []) {
    const phrase = g.replace(/^\d+\s+/, "").trim();
    if (phrase.split(/\s+/).length <= 3) consider(phrase, { requireShorts: false });
  }

  return out.sort((a, b) => b.views - a.views || b.shorts - a.shorts).slice(0, MAX_SUGGESTIONS);
}

/** One suggestion as a niche — what the Add button (and the API) turns into. */
export function suggestionToNiche(suggestion: NicheSuggestion, source: "agent" | "user" = "user"): AddNicheResult {
  return addAddedNiche({ name: suggestion.name, short: suggestion.short, why: suggestion.why, source }, Date.now());
}

// ── Startup and tests ───────────────────────────────────────────────────────

/** Warm the registry at boot so the first script already knows the added niches. */
export function loadAddedNiches(): AddedNiche[] {
  return addedNiches();
}

/** Boot: read the added niches once, and say what it found. */
export function initNiches(): void {
  const added = loadAddedNiches();
  if (added.length)
    console.log(
      `[niches] ${added.length} added niche${added.length === 1 ? "" : "s"} in the Generate tab: ${added.map((n) => n.name).join(", ")}`,
    );
}

/** Which niche a topic would use right now (the API answers this for the app). */
export function nicheForTopic(topic: string): Niche {
  return detectNiche(topic);
}

export function resetAddedNichesForTests(): void {
  cache = null;
  lastRegistered = null;
  registered = false;
  registerExtraNiches([]);
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}
