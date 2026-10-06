// ── Google Trends daily RSS: what people are searching for today (free) ──────
// Google publishes its daily Trending Searches as an RSS feed that needs no
// key, no account and no quota:
//
//   https://trends.google.com/trending/rss?geo=US
//
// It is a second, independent signal next to the Shorts scan
// (./shortsTrends.ts): YouTube says which *Shorts* are popular this week,
// Google says which *topics* the country is searching right now. The two
// together are what a "what should I make today?" answer needs — and neither
// costs a Gemini request.
//
// The feed is parsed with a small, dependency-free reader instead of adding an
// XML library: only <item><title>, <ht:approx_traffic> and the news item
// titles are used, and anything unreadable is skipped rather than thrown.

import { config } from "../config.js";

export interface GoogleTrend {
  /** The search term, e.g. "diwali 2026" (cleaned, one line). */
  title: string;
  /** "200,000+" as Google wrote it ("" when it didn't). */
  traffic: string;
  /** Headline of the top related news item ("" when there is none). */
  news: string;
}

export interface GoogleTrendsResult {
  trends: GoogleTrend[];
  /** Which country's feed this was. */
  geo: string;
  fetchedAt: number;
}

/** Google's default feed for English-language markets. */
export const DEFAULT_TRENDS_GEO = "US";

const FETCH_TIMEOUT_MS = 8_000;
/** The feed carries ~20 items; more than this is never used. */
const MAX_TRENDS = 12;

const decodeEntities = (text: string): string =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    .replace(/\s+/g, " ")
    .trim();

function firstTag(itemXml: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, "i").exec(itemXml);
    if (m?.[1]) {
      const value = decodeEntities(m[1]);
      if (value) return value;
    }
  }
  return "";
}

/** The feed's <item> blocks → trends, newest first, deduplicated by title. */
export function parseGoogleTrendsRss(xml: string): GoogleTrend[] {
  if (typeof xml !== "string" || !xml.includes("<item")) return [];
  const out: GoogleTrend[] = [];
  const seen = new Set<string>();
  for (const item of xml.split(/<item[\s>]/i).slice(1)) {
    const title = firstTag(item, ["title"]).slice(0, 120);
    if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    // "200,000+" — Google puts it in the ht namespace, which some mirrors
    // rename; accept a couple of spellings.
    const traffic = firstTag(item, ["ht:approx_traffic", "approx_traffic"]).slice(0, 20);
    const news = firstTag(item, ["ht:news_item_title", "news_item_title"]).slice(0, 140);
    out.push({ title, traffic, news });
    if (out.length >= MAX_TRENDS) break;
  }
  return out;
}

type TrendsFetcher = (opts: { geo?: string; signal?: AbortSignal }) => Promise<GoogleTrendsResult>;

/**
 * Google's daily trending searches for one country. Never throws: an
 * unreachable or changed feed resolves to an empty list — the Shorts scan
 * stands on its own, and a trend refresh must not fail because of a bonus
 * source (or spend AI quota on it).
 */
export async function fetchGoogleTrends(opts: { geo?: string; signal?: AbortSignal } = {}): Promise<GoogleTrendsResult> {
  return fetcher(opts);
}

let fetcher: TrendsFetcher = fetchGoogleTrendsFeed;

/** Tests: replace the RSS read (null restores the real feed), so no test hits the network. */
export function setGoogleTrendsForTests(fn: TrendsFetcher | null): void {
  fetcher = fn ?? fetchGoogleTrendsFeed;
}

/** The feed's address (config, so a test or a mirrored feed can be pointed at). */
export function googleTrendsFeedUrl(geo: string): string {
  const separator = config.googleTrendsFeedUrl.includes("?") ? "&" : "?";
  return `${config.googleTrendsFeedUrl}${separator}geo=${encodeURIComponent(geo)}`;
}

async function fetchGoogleTrendsFeed(opts: { geo?: string; signal?: AbortSignal } = {}): Promise<GoogleTrendsResult> {
  const geo = (opts.geo ?? process.env.TRENDS_REGION ?? DEFAULT_TRENDS_GEO).trim().toUpperCase().slice(0, 4) || DEFAULT_TRENDS_GEO;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const forward = () => controller.abort();
  opts.signal?.addEventListener("abort", forward, { once: true });
  try {
    const res = await fetch(googleTrendsFeedUrl(geo), {
      signal: controller.signal,
      headers: { "user-agent": "SoundwaveAI/1.0 (trend scout)" },
    });
    if (!res.ok) return { trends: [], geo, fetchedAt: Date.now() };
    return { trends: parseGoogleTrendsRss(await res.text()), geo, fetchedAt: Date.now() };
  } catch {
    return { trends: [], geo, fetchedAt: Date.now() };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", forward);
  }
}
