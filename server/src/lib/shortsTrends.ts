// ── Free Shorts trend tracker (no Gemini, no API key) ───────────────────────
// YouTube has no public "trending Shorts" API, and it retired the Trending page
// in 2025. What it still has is its own search, which can be limited to Shorts
// uploaded this week and ranked by popularity. This module reads that through
// YouTube.js (LuanRT/YouTube.js, MIT — the Innertube client the website uses),
// across a few general queries plus every niche the app writes for, then works
// out the findings itself: rising hashtags and topics, hook shapes that are
// landing, typical length, and the fastest climbers.
//
// Nothing here calls Gemini, so refreshing trends costs no AI quota at all.
// The scripts and the agent read the result exactly like the old search digest.

import { NICHES } from "./brain/core/viral.js";

/** One Short seen in this week's popular results. */
export interface TrendingShort {
  id: string;
  title: string;
  url: string;
  views: number;
  channel?: string;
  /** "3 days ago" as hours, when YouTube said. */
  ageHours?: number;
  seconds?: number;
  /** Which search found it (a niche name or a general query). */
  query: string;
  /** Views per hour since upload (only when the age is known). */
  velocity?: number;
}

export interface ShortsScan {
  scannedAt: number;
  shorts: TrendingShort[];
  findings: string[];
  queries: string[];
  /** Searches that failed (the scan still counts if enough came back). */
  failures: number;
}

/** What one search returns: YouTube.js result nodes (duck-typed, so tests can feed fixtures). */
export type ShortsSearchFn = (query: string, kind: "shorts" | "video", signal?: AbortSignal) => Promise<unknown[]>;

// General queries cast the wide net; the niche queries keep it relevant.
const GENERAL_QUERIES = ["#shorts", "viral shorts"];
const NICHE_QUERY: Record<string, string> = {
  psychology: "psychology facts shorts",
  facts: "mind blowing facts shorts",
  history: "history facts shorts",
  finance: "money tips shorts",
  ai: "AI tools shorts",
  motivation: "motivation shorts",
  horror: "scary stories shorts",
  crime: "true crime shorts",
  health: "health facts shorts",
};

export function scanQueries(): Array<{ query: string; label: string }> {
  const niches = NICHES.map((n) => ({ query: NICHE_QUERY[n.id] ?? `${n.name} shorts`, label: n.name }));
  return [...GENERAL_QUERIES.map((q) => ({ query: q, label: q })), ...niches];
}

// ── Parsing YouTube's display text ──────────────────────────────────────────

const text = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as { text?: unknown; toString?: () => string };
    if (typeof o.text === "string") return o.text;
    const s = typeof o.toString === "function" ? o.toString() : "";
    return s === "[object Object]" ? "" : s;
  }
  return "";
};

/** "1.2M views" / "1,234,567 views" / "12K" / "3.4 million views" → number (0 when unknown). */
export function parseViews(raw: string): number {
  const s = String(raw ?? "").toLowerCase().replace(/,/g, "").trim();
  if (!s || /no views/.test(s)) return 0;
  const m = /(\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\b/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  const mult = unit === "k" || unit === "thousand" ? 1e3 : unit === "m" || unit === "million" ? 1e6 : unit === "b" || unit === "billion" ? 1e9 : 1;
  return Math.round(n * mult);
}

/** "3 days ago" / "Streamed 5 hours ago" → hours (undefined when unknown). */
export function parseAgeHours(raw: string): number | undefined {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(String(raw ?? ""));
  if (!m) return undefined;
  const n = Number(m[1]);
  const per: Record<string, number> = { second: 1 / 3600, minute: 1 / 60, hour: 1, day: 24, week: 168, month: 720, year: 8760 };
  return n * per[m[2]!.toLowerCase()]!;
}

/** "0:58" / "1:02:03" → seconds. */
export function parseLength(raw: string): number | undefined {
  const parts = String(raw ?? "").trim().split(":").map(Number);
  if (parts.length < 2 || parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** A YouTube.js search node → a TrendingShort (null for channels, playlists, long videos…). */
export function normalizeNode(node: unknown, query: string): TrendingShort | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, any>;
  const type = String(n.type ?? (n.constructor as { type?: unknown } | undefined)?.type ?? "");

  // Shorts shelf / Shorts tab entries.
  if (type === "ShortsLockupView" || type === "ReelItem" || "overlay_metadata" in n) {
    const id = n.on_tap_endpoint?.payload?.videoId ?? n.id ?? String(n.entity_id ?? "").replace(/^shorts-shelf-item-/, "");
    const title = text(n.overlay_metadata?.primary_text) || text(n.title) || (String(n.accessibility_text ?? "").split(",")[0] ?? "");
    const views = parseViews(text(n.overlay_metadata?.secondary_text) || text(n.views) || String(n.accessibility_text ?? ""));
    if (!VIDEO_ID.test(String(id)) || !title.trim()) return null;
    return { id, title: title.trim().slice(0, 140), url: `https://www.youtube.com/shorts/${id}`, views, query };
  }

  // Regular video results (searched with "under 3 minutes"): Shorts are ≤ 3 min.
  if (type === "Video" || "video_id" in n) {
    const id = String(n.video_id ?? n.id ?? "");
    const title = text(n.title).trim();
    if (!VIDEO_ID.test(id) || !title) return null;
    const seconds = typeof n.duration?.seconds === "number" && n.duration.seconds > 0 ? n.duration.seconds : parseLength(text(n.length_text));
    if (seconds !== undefined && seconds > 180) return null;
    if (/live/i.test(text(n.length_text)) || n.is_live) return null;
    const views = parseViews(text(n.view_count) || text(n.short_view_count));
    const ageHours = parseAgeHours(text(n.published));
    const channel = text(n.author?.name) || undefined;
    return {
      id,
      title: title.slice(0, 140),
      url: `https://www.youtube.com/shorts/${id}`,
      views,
      query,
      ...(channel ? { channel } : {}),
      ...(ageHours !== undefined ? { ageHours } : {}),
      ...(seconds !== undefined ? { seconds } : {}),
    };
  }
  return null;
}

/** Results can be nested in shelves (ReelShelf.items, ItemSection.contents). Flatten them. */
function flatten(nodes: unknown[], depth = 0): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes ?? []) {
    if (!node || typeof node !== "object") continue;
    out.push(node);
    if (depth > 2) continue;
    const n = node as Record<string, unknown>;
    for (const key of ["items", "contents"]) {
      const inner = n[key];
      if (Array.isArray(inner)) out.push(...flatten(inner, depth + 1));
    }
  }
  return out;
}

// ── The default search: YouTube.js (loaded on first use) ────────────────────

let innertube: Promise<any> | null = null;

async function client(): Promise<any> {
  if (!innertube) {
    innertube = (async () => {
      const { Innertube } = await import("youtubei.js");
      return Innertube.create({ retrieve_player: false, lang: "en", location: process.env.TRENDS_REGION || "US", generate_session_locally: true });
    })().catch((err) => {
      innertube = null; // try again next time
      throw err;
    });
  }
  return innertube;
}

const youtubeSearch: ShortsSearchFn = async (query, kind) => {
  const yt = await client();
  const filters =
    kind === "shorts"
      ? { type: "shorts", upload_date: "week", prioritize: "popularity" }
      : { type: "video", duration: "under_three_mins", upload_date: "week", prioritize: "popularity" };
  const res = await yt.search(query, filters);
  return Array.from((res?.results ?? []) as unknown[]);
};

let searchImpl: ShortsSearchFn = youtubeSearch;
/** A polite pause between searches. */
let pauseMs = 250;

/** Tests: replace the network search (null restores YouTube.js) and skip the pause. */
export function setShortsSearchForTests(fn: ShortsSearchFn | null): void {
  searchImpl = fn ?? youtubeSearch;
  pauseMs = fn ? 0 : 250;
  innertube = null;
}

/** When the first searches all fail and nothing has come back, YouTube is unreachable: stop. */
const GIVE_UP_AFTER_FAILURES = 3;

// ── Scanning ────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the searches (two at a time, gently) and returns every distinct Short found. */
export async function collectTrendingShorts(opts: { signal?: AbortSignal; queries?: Array<{ query: string; label: string }> } = {}): Promise<{ shorts: TrendingShort[]; failures: number; searches: number }> {
  const queries = opts.queries ?? scanQueries();
  const jobs: Array<{ query: string; label: string; kind: "shorts" | "video" }> = [];
  for (const q of queries) {
    jobs.push({ ...q, kind: "video" }); // has channel, age and length
    jobs.push({ ...q, kind: "shorts" }); // the Shorts tab itself
  }
  const byId = new Map<string, TrendingShort>();
  let failures = 0;
  let successes = 0;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      if (opts.signal?.aborted) return;
      if (successes === 0 && failures >= GIVE_UP_AFTER_FAILURES) return;
      const job = jobs[next++]!;
      try {
        const nodes = flatten(await searchImpl(job.query, job.kind, opts.signal));
        successes++;
        for (const node of nodes) {
          const s = normalizeNode(node, job.label);
          if (!s) continue;
          const prev = byId.get(s.id);
          // Merge: the video result knows the channel/age; the Shorts card may have fresher views.
          if (!prev) byId.set(s.id, s);
          else byId.set(s.id, { ...prev, ...s, views: Math.max(prev.views, s.views), query: prev.query, channel: s.channel ?? prev.channel, ageHours: s.ageHours ?? prev.ageHours, seconds: s.seconds ?? prev.seconds });
        }
      } catch (err) {
        failures++;
        console.warn(`[trends] YouTube search "${job.query}" (${job.kind}) failed: ${(err as Error).message}`);
      }
      if (pauseMs) await delay(pauseMs);
    }
  };
  await Promise.all([worker(), worker()]);
  const shorts = [...byId.values()].map((s) => (s.ageHours && s.ageHours > 0 ? { ...s, velocity: Math.round(s.views / Math.max(1, s.ageHours)) } : s));
  return { shorts, failures, searches: successes + failures };
}

// ── Turning the data into findings (deterministic) ──────────────────────────

const STOP = new Set(
  ("a an and are as at be but by can do does for from get got has have he her his how i if in into is it its just me my no not of on or our out she so than that the their them then there these they this to too up us was we what when where which who why will with you your " +
    "shorts short viral video videos youtube fyp trending subscribe like watch new part day facts fact tips tip").split(" "),
);

const fmtViews = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

const fmtAge = (h: number): string => (h < 24 ? `${Math.max(1, Math.round(h))} hours` : `${Math.round(h / 24)} day${Math.round(h / 24) === 1 ? "" : "s"}`);

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const quote = (t: string, max = 60) => `“${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}”`;

/** Title shapes worth knowing about, each with a plain-English label. */
const HOOKS: Array<{ label: string; test: RegExp }> = [
  { label: "“POV:” setups", test: /\bpov\b/i },
  { label: "question titles", test: /\?\s*(?:#|$)|^(?:why|how|what|who|did|do|does|is|are|can|would)\b/i },
  { label: "numbered/list titles", test: /^\s*\d+\s+\w|\btop\s+\d+\b|\b\d+\s+(?:things|ways|facts|signs|reasons|tricks|secrets)\b/i },
  { label: "“wait for it / till the end” teases", test: /wait (?:for it|till|until)|till the end|watch (?:till|until) the end|end\b.*\bwait/i },
  { label: "multi-part series (Part 2, Day 14…)", test: /\b(?:part|pt\.?|day|episode|ep\.?)\s*\d+\b/i },
  { label: "“vs” face-offs", test: /\bvs\.?\b|\bversus\b/i },
  { label: "“nobody/no one tells you” secrets", test: /no ?one|nobody|they don'?t (?:want|tell)|secret|hidden/i },
  { label: "shock words (insane, crazy, unbelievable)", test: /\b(?:insane|crazy|unbelievable|shocking|impossible|mind ?blowing|can'?t believe)\b/i },
];

/** The findings the script writer and the agent read. 3–8 lines, most useful first. */
export function analyzeTrendingShorts(shorts: TrendingShort[]): string[] {
  const pool = shorts.filter((s) => s.views > 0).sort((a, b) => b.views - a.views);
  if (pool.length < 5) return [];
  const top = pool.slice(0, Math.min(60, pool.length));
  const overallMedian = median(top.map((s) => s.views));
  const findings: string[] = [];

  // 1. The fastest climbers (views per hour since upload).
  const fast = top.filter((s) => s.velocity).sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0)).slice(0, 2);
  for (const s of fast) {
    findings.push(`Fastest climber: ${quote(s.title)} — ${fmtViews(s.views)} views in ${fmtAge(s.ageHours!)}${s.channel ? ` (${s.channel})` : ""}, ${s.query}.`);
  }
  if (!fast.length) {
    const s = top[0]!;
    findings.push(`Most-viewed Short this week: ${quote(s.title)} — ${fmtViews(s.views)} views${s.channel ? ` (${s.channel})` : ""}.`);
  }

  // 2. Hook shapes that are over-performing (only with enough examples).
  const hookStats = HOOKS.map((h) => {
    const hits = top.filter((s) => h.test.test(s.title));
    return { label: h.label, count: hits.length, med: median(hits.map((s) => s.views)) };
  })
    .filter((h) => h.count >= 3)
    .sort((a, b) => b.med * b.count - a.med * a.count);
  for (const h of hookStats.slice(0, 2)) {
    const lift = overallMedian > 0 ? h.med / overallMedian : 1;
    const liftText = lift >= 1.15 ? `, ${lift.toFixed(1)}× the typical views` : "";
    findings.push(`Hook shape landing now: ${h.label} — ${h.count} of the top ${top.length} Shorts this week${liftText}.`);
  }

  // 3. Hashtags on the most-viewed Shorts, weighted by views.
  const tagScore = new Map<string, number>();
  for (const s of top) {
    for (const tag of new Set((s.title.match(/#[\p{L}\p{N}_]{2,30}/gu) ?? []).map((t) => t.toLowerCase()))) {
      if (/^#(?:shorts?|viral|fyp|foryou|trending|youtubeshorts|short)$/.test(tag)) continue;
      tagScore.set(tag, (tagScore.get(tag) ?? 0) + s.views);
    }
  }
  const tags = [...tagScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
  if (tags.length >= 2) findings.push(`Hashtags riding the most-viewed Shorts this week: ${tags.join(", ")}.`);

  // 4. Topic words that keep showing up across different channels.
  const wordChannels = new Map<string, Set<string>>();
  const wordViews = new Map<string, number>();
  for (const s of top) {
    const words = new Set(
      s.title
        .toLowerCase()
        .replace(/#[\p{L}\p{N}_]+/gu, " ")
        .split(/[^\p{L}\p{N}']+/u)
        .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)),
    );
    for (const w of words) {
      if (!wordChannels.has(w)) wordChannels.set(w, new Set());
      wordChannels.get(w)!.add(s.channel ?? s.id);
      wordViews.set(w, (wordViews.get(w) ?? 0) + s.views);
    }
  }
  const topics = [...wordChannels.entries()]
    .filter(([, ch]) => ch.size >= 3)
    .sort((a, b) => b[1].size * (wordViews.get(b[0]) ?? 0) - a[1].size * (wordViews.get(a[0]) ?? 0))
    .slice(0, 6)
    .map(([w]) => w);
  if (topics.length >= 3) findings.push(`Topics spiking across many channels this week: ${topics.join(", ")}.`);

  // 5. Length of what's working.
  const lengths = top.map((s) => s.seconds).filter((x): x is number => typeof x === "number" && x > 0);
  if (lengths.length >= 8) {
    const med = Math.round(median(lengths));
    const under30 = Math.round((lengths.filter((x) => x <= 30).length / lengths.length) * 100);
    findings.push(`Typical length of this week's top Shorts: ${med} seconds; ${under30}% run 30 seconds or less.`);
  }

  // 6. The strongest niche this week (from the niche queries).
  const nicheNames = new Set(NICHES.map((n) => n.name));
  const byNiche = new Map<string, number[]>();
  for (const s of pool) if (nicheNames.has(s.query)) (byNiche.get(s.query) ?? byNiche.set(s.query, []).get(s.query)!).push(s.views);
  const nicheRank = [...byNiche.entries()].filter(([, v]) => v.length >= 3).map(([n, v]) => ({ n, med: median(v) })).sort((a, b) => b.med - a.med);
  if (nicheRank.length >= 2) {
    findings.push(`Hottest niche this week: ${nicheRank[0]!.n} (typical top Short ${fmtViews(nicheRank[0]!.med)} views); coolest: ${nicheRank[nicheRank.length - 1]!.n}.`);
  }

  return findings.slice(0, 8);
}

/** One full scan: search, merge, analyze. Throws only when nothing at all came back. */
export async function scanTrendingShorts(opts: { signal?: AbortSignal } = {}): Promise<ShortsScan> {
  const queries = scanQueries();
  const { shorts, failures, searches } = await collectTrendingShorts({ signal: opts.signal, queries });
  if (!shorts.length) throw new Error(failures >= searches ? "YouTube search could not be reached" : "YouTube returned no Shorts");
  const ranked = shorts.sort((a, b) => b.views - a.views);
  return {
    scannedAt: Date.now(),
    shorts: ranked.slice(0, 40),
    findings: analyzeTrendingShorts(ranked),
    queries: queries.map((q) => q.query),
    failures,
  };
}
