// ── Research for the morning briefing (shared by the PC and the phone) ──────
// The user's briefing topics are anything they like ("the latest news about
// open-source, free AI tools", "new trending GitHub repositories"). For each
// one Gemini searches the web: Gemini 2.5 Flash has Google Search grounding on
// the free tier (500 requests a day; Gemini 3.x needs billing for it). If
// search isn't available, fresh items come from free public feeds — GitHub's
// search API, Hacker News and Google News — and Gemini sums them up. The
// briefing (./morning.ts) is then written from these findings only.
// Pure TypeScript: the phone app compiles this file too.

import { GeminiError, visibleText, type GenerateResponse } from "./gemini.js";
import type { Generate } from "./turn.js";

/** Models with free Google Search grounding (the free tier's limit is shared between them). */
export const RESEARCH_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

export interface TopicBrief {
  topic: string;
  /** What was found, as short factual lines (the briefing is written from these). */
  summary: string;
  sources: Array<{ title: string; url?: string }>;
  /** How it was found: Gemini with Google Search, the public feeds, or not at all. */
  via: "search" | "feeds" | "none";
  /** Why nothing was found. */
  note?: string;
}

/** GET a URL as text (null when it can't be fetched). The phone uses native HTTP for feeds browsers block. */
export type FetchText = (url: string, opts?: { signal?: AbortSignal }) => Promise<string | null>;

export interface ResearchOptions {
  apiKey: string;
  generate: Generate;
  /** The chat model — sums up feed items when search isn't available. */
  model: string;
  now?: Date;
  fetchText?: FetchText;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

const NOTHING = /^\s*nothing new found\.?\s*$/i;

function longDate(now: Date): string {
  return now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function researchPrompt(topic: string, now: Date): string {
  return [
    `Today is ${longDate(now)}. Search the web for the latest news and developments — from the last few days — about: “${topic}”.`,
    "Report the 3 to 5 most important, concrete items: what happened or what's new, with names, numbers and dates. One short factual sentence per line, most important first. Plain text, no Markdown, no links.",
    "Only include things you found in the search results. If there's nothing recent, answer exactly: Nothing new found.",
  ].join("\n");
}

function groundingSources(resp: GenerateResponse): TopicBrief["sources"] {
  const out: TopicBrief["sources"] = [];
  for (const chunk of resp.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
    const title = chunk.web?.title?.trim();
    if (title && !out.some((s) => s.title === title)) out.push({ title, ...(chunk.web?.uri ? { url: chunk.web.uri } : {}) });
    if (out.length === 5) break;
  }
  return out;
}

const cleanLines = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .slice(0, 6)
    .join("\n");

/** Gemini 2.5 Flash (then Flash-Lite) with Google Search. Null when search can't be used with this key. */
async function searchTopic(topic: string, o: ResearchOptions): Promise<TopicBrief | null> {
  for (const model of RESEARCH_MODELS) {
    try {
      const resp = await o.generate({
        apiKey: o.apiKey,
        model,
        signal: o.signal,
        timeoutMs: 30_000,
        request: {
          contents: [{ role: "user", parts: [{ text: researchPrompt(topic, o.now ?? new Date()) }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: { maxOutputTokens: 2048 },
        },
      });
      const text = visibleText(resp.candidates?.[0]?.content?.parts);
      if (!text) continue;
      if (NOTHING.test(text)) return { topic, summary: "", sources: [], via: "search", note: "Google Search found nothing new" };
      return { topic, summary: cleanLines(text), sources: groundingSources(resp), via: "search" };
    } catch (err) {
      if (err instanceof GeminiError && err.kind === "aborted") throw err;
      o.log?.(`research: ${model} with Google Search failed for “${topic}” (${err instanceof GeminiError ? err.kind : (err as Error).message})`);
      // Over the search limit, model gone, search refused: try the next model, then the feeds.
    }
  }
  return null;
}

// ── The public feeds (no key needed) ────────────────────────────────────────

interface FeedItem {
  title: string;
  url?: string;
  detail?: string;
  from: string;
}

const FILLER = new Set(
  "a an and any are about all also around as at best brand by can daily for free from get give hot important in is just latest list me most my new newest news of on or popular recent repo repos repository repositories some tell that the this today trending update updates what week with".split(" "),
);

/** “the latest news about open-source, free AI tools” → “open source AI tools”. */
export function topicKeywords(topic: string): string {
  return topic
    .replace(/[“”"'’]/g, " ")
    .replace(/open[- ]?source/gi, "open source")
    .split(/[^\p{L}\p{N}+#.-]+/u)
    .filter((w) => w && !FILLER.has(w.toLowerCase()) && !/^github$/i.test(w))
    .slice(0, 6)
    .join(" ")
    .trim();
}

const wantsGithub = (topic: string) => /github|\brepos?\b|repositor/i.test(topic);
const isTech = (topic: string) =>
  /\b(ai|a\.i\.|llms?|gpt|models?|machine learning|ml|open[- ]?source|software|programming|code|coding|developers?|tech|startups?|github|linux|robots?|apps?|tools?)\b/i.test(topic);

const isoDaysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Items of an RSS feed (Google News). */
export function parseRss(xml: string, limit = 8): FeedItem[] {
  const items: FeedItem[] = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const block = m[0];
    const get = (tag: string) => {
      const r = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
      return r ? decodeXml(r[1]!) : "";
    };
    const title = get("title");
    if (title) items.push({ title, url: get("link") || undefined, detail: get("source") || undefined, from: "Google News" });
    if (items.length >= limit) break;
  }
  return items;
}

async function getJson(fetchText: FetchText, url: string, signal?: AbortSignal): Promise<any> {
  const text = await fetchText(url, { signal });
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function gatherFeeds(topic: string, o: Pick<ResearchOptions, "fetchText" | "now" | "signal">): Promise<FeedItem[]> {
  const fetchText = o.fetchText;
  if (!fetchText) return [];
  const now = o.now ?? new Date();
  const kw = topicKeywords(topic);
  const jobs: Array<Promise<FeedItem[]>> = [];
  if (wantsGithub(topic)) {
    const q = `${kw ? `${kw} ` : ""}created:>${isoDaysAgo(now, 7)}`;
    jobs.push(
      getJson(fetchText, `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, o.signal).then((d) =>
        (Array.isArray(d?.items) ? d.items : []).slice(0, 8).map((r: any) => ({
          title: String(r.full_name ?? ""),
          url: r.html_url,
          detail: `${r.description ? String(r.description).slice(0, 160) : "no description"} — ${r.stargazers_count ?? 0} stars this week${r.language ? `, ${r.language}` : ""}`,
          from: "GitHub",
        })),
      ),
    );
  }
  if (isTech(topic) && kw) {
    const since = Math.floor(now.getTime() / 1000) - 3 * 86_400;
    jobs.push(
      getJson(fetchText, `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(kw)}&tags=story&numericFilters=created_at_i%3E${since}&hitsPerPage=8`, o.signal).then((d) =>
        (Array.isArray(d?.hits) ? d.hits : []).slice(0, 8).map((h: any) => ({ title: String(h.title ?? ""), url: h.url ?? undefined, detail: `${h.points ?? 0} points on Hacker News`, from: "Hacker News" })),
      ),
    );
  }
  jobs.push(
    fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(`${kw || topic} when:3d`)}&hl=en-US&gl=US&ceid=US:en`, { signal: o.signal }).then((xml) => (xml ? parseRss(xml) : [])),
  );
  const lists = await Promise.all(jobs.map((j) => j.catch(() => [] as FeedItem[])));
  return lists.flat().filter((i) => i.title);
}

/** Feed items → a short summary for the topic (the chat model, no search needed). */
async function summarizeFeeds(topic: string, items: FeedItem[], o: ResearchOptions): Promise<TopicBrief | null> {
  const listing = items.slice(0, 18).map((i, n) => `${n + 1}. [${i.from}] ${i.title}${i.detail ? ` — ${i.detail}` : ""}`);
  try {
    const resp = await o.generate({
      apiKey: o.apiKey,
      model: o.model,
      signal: o.signal,
      timeoutMs: 30_000,
      request: {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
                  `Briefing topic: “${topic}”. Here are fresh items from the last few days:`,
                  ...listing,
                  "",
                  "Pick the 3 to 5 items that matter most for this topic and write one short factual sentence for each (name what it is and why it's notable — stars, points or source). Use only these items. Plain text, one per line. If none fit the topic, answer exactly: Nothing new found.",
                ].join("\n"),
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 2048 },
      },
    });
    const text = visibleText(resp.candidates?.[0]?.content?.parts);
    if (!text) return null;
    if (NOTHING.test(text)) return { topic, summary: "", sources: [], via: "feeds", note: "nothing in the news feeds fit" };
    const sources = [...new Set(items.slice(0, 18).map((i) => i.from))].map((title) => ({ title }));
    return { topic, summary: cleanLines(text), sources, via: "feeds" };
  } catch (err) {
    if (err instanceof GeminiError && err.kind === "aborted") throw err;
    o.log?.(`research: summing up the feeds for “${topic}” failed (${(err as Error).message})`);
    return null;
  }
}

export async function researchTopic(topic: string, o: ResearchOptions): Promise<TopicBrief> {
  const searched = await searchTopic(topic, o);
  if (searched) return searched;
  const items = await gatherFeeds(topic, o);
  if (items.length) {
    const summed = await summarizeFeeds(topic, items, o);
    if (summed) return summed;
  }
  return { topic, summary: "", sources: [], via: "none", note: items.length ? "Gemini couldn't sum up the news" : "no search or news feeds could be reached" };
}

/** All topics, three at a time. */
export async function researchTopics(topics: string[], o: ResearchOptions): Promise<TopicBrief[]> {
  const out: TopicBrief[] = new Array(topics.length);
  let next = 0;
  const worker = async () => {
    while (next < topics.length) {
      const i = next++;
      out[i] = await researchTopic(topics[i]!, o);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, topics.length) }, worker));
  return out;
}
