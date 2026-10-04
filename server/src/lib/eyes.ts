// ── The agent's eyes: read a video, read a page, search YouTube ─────────────
// What the agent can *read* (not just open in a browser), with the tools we
// already ship: the bundled yt-dlp for anything YouTube, and plain HTTP for
// pages. No Python, no paid API, no login — and when a thing genuinely can't be
// read (no captions, a page that only exists in JavaScript) the caller gets a
// sentence a person would understand rather than an empty result.
//
// A fetched page is parsed here, on this PC, with the reader-mode machinery
// Firefox uses (Mozilla's Readability) and turned into markdown (Turndown): the
// article, not the menus — and nothing about the page leaves the machine. A page
// that hands back nothing usable (a wall that wants a real browser, a
// JavaScript-only shell) is fetched next by the *local* page reader if the
// person installed it (SCRAPLING_URL → the Scrapling sidecar in ../scrapling),
// which also keeps the address on this machine. Only when that isn't there or
// can't either does the reader service (r.jina.ai) get the URL — it is the last
// resort, and the one path where a page's address leaves the PC.

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

import { config } from "../config.js";
import { fetchTranscript, parseYouTubeUrl, searchVideos, type YtSearchResult } from "./ytdlp.js";
import { capText, htmlTitle, htmlToText, vttToText } from "./brain/core/transcript.js";

export const READ_TEXT_MAX = 12_000;

export interface ReadVideoResult {
  ok: true;
  title: string;
  channel: string;
  duration: number;
  /** Whether the words are the uploader's own subtitles or YouTube's auto ones. */
  captions: "manual" | "auto";
  transcript: string;
  truncated: boolean;
  url: string;
}

export interface ReadPageResult {
  ok: true;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  /**
   * "readability" = the article pulled out of the page here (markdown),
   * "direct" = the page/text as fetched, "scrapling" = fetched here by the local
   * page-reader sidecar (a page that answered our own fetch with a wall or a
   * JavaScript shell), "reader" = through the reader service on the internet.
   */
  via: "readability" | "direct" | "scrapling" | "reader";
}

/** Bigger than this and the page is not an article worth DOM-parsing (a dump, a feed). */
export const MAX_ARTICLE_HTML = 4_000_000;

/** Below this the extraction isn't worth calling "the article". */
const MIN_ARTICLE_CHARS = 200;

export interface ArticleText {
  title: string;
  /** Markdown: headings, lists, quotes, links — what the model reads best. */
  text: string;
}

/**
 * The article inside an HTML page, as markdown — Mozilla's Readability (the
 * reader mode in Firefox, Apache-2.0) picks the article out of the page and
 * Turndown (MIT) writes it as markdown. Both are pure JavaScript and run here:
 * nothing is sent anywhere. Returns null when the page holds no article this
 * long (a JavaScript-only shell, a wall, a list of links).
 *
 * Scripts never run (jsdom is created without `runScripts`) and nothing is
 * fetched: parsing untrusted HTML must stay passive.
 */
export function articleMarkdown(html: string, url = "https://example.invalid/"): ArticleText | null {
  if (!html || html.length > MAX_ARTICLE_HTML) return null;
  try {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    const article = new Readability(doc).parse();
    if (!article) return null;
    const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
    // Images say nothing to a model, and off-site URLs in a summary are noise:
    // keep the words, drop the pictures (their alt text stays in the page's own
    // text, which the fallback below keeps when there is no article).
    turndown.addRule("images", { filter: "img", replacement: () => "" });
    const text = turndown
      .turndown(article.content ?? "")
      .replace(/[ \t]+$/gm, "")
      // Turndown writes "-   item"; one space reads the same and costs fewer tokens.
      .replace(/^(\s*)[-*+]\s{2,}/gm, "$1- ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length < MIN_ARTICLE_CHARS) return null;
    return { title: (article.title ?? "").trim() || htmlTitle(html), text };
  } catch {
    // Unparseable markup is not an error worth reporting: the caller falls back.
    return null;
  }
}

export interface Eyes {
  readVideo(url: string): Promise<ReadVideoResult>;
  readPage(url: string): Promise<ReadPageResult>;
  search(query: string, limit?: number): Promise<YtSearchResult[]>;
}

/** Only http(s), and never a URL that points back at this machine. */
export function safePublicUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL((raw ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const localhostish =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".local");
  if (localhostish) return null;
  return url;
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 SoundwaveAI/1.0",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchText(url: string, accept: string, timeoutMs: number): Promise<{ status: number; type: string; body: string }> {
  const res = await fetch(url, {
    headers: { ...BROWSER_HEADERS, Accept: accept },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  return { status: res.status, type, body };
}

/**
 * The local page reader (the Scrapling sidecar in ../scrapling): a page that our
 * own fetch couldn't read — a bot check that wants a real browser's TLS
 * fingerprint, a page that only exists after scripts run — fetched here, on this
 * machine. Nothing about the page leaves the PC on this path, which is why it
 * gets the first try and the reader service is the last resort.
 *
 * The sidecar hands back HTML and nothing else: the article is extracted by the
 * same `articleMarkdown` as a directly fetched page, so there is exactly one
 * definition of "what this page says". Null when the sidecar isn't configured
 * (SCRAPLING_URL unset — the default), isn't running, or came back empty; the
 * caller then falls through to the reader service exactly as before.
 */
async function fetchThroughLocalReader(url: string): Promise<{ html: string; title: string } | null> {
  if (!config.scraplingUrl) return null;
  try {
    const res = await fetch(`${config.scraplingUrl}/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...BROWSER_HEADERS },
      // The stealth browser takes seconds; 90 s is the sidecar's own budget plus
      // room for loopback. A timeout here just means "fall through", never a hang.
      body: JSON.stringify({ url, mode: "auto" }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; html?: string; title?: string };
    if (!data.ok || typeof data.html !== "string" || !data.html.trim()) return null;
    return { html: data.html.slice(0, MAX_ARTICLE_HTML), title: (data.title ?? "").trim() };
  } catch {
    // Not installed, not running, or timed out — all the same to the caller.
    return null;
  }
}

export const defaultEyes: Eyes = {
  async readVideo(url: string): Promise<ReadVideoResult> {
    const parsed = parseYouTubeUrl((url ?? "").trim());
    if (!parsed) {
      throw new Error("That isn't a YouTube link — give me a youtube.com or youtu.be video link, or a video file path for make_shorts_from_video.");
    }
    const found = await fetchTranscript(parsed.toString());
    const { text, truncated } = capText(vttToText(found.vtt), READ_TEXT_MAX);
    if (!text) throw new Error("I got the captions but they were empty — try another video.");
    return {
      ok: true,
      title: found.title,
      channel: found.channel,
      duration: found.duration,
      captions: found.kind,
      transcript: text,
      truncated,
      url: found.url,
    };
  },

  async readPage(raw: string): Promise<ReadPageResult> {
    const url = safePublicUrl(raw);
    if (!url) throw new Error("That doesn't look like a web address I can read (http/https only).");
    let direct = { status: 0, type: "", body: "" };
    let directError = "";
    try {
      direct = await fetchText(url.toString(), BROWSER_HEADERS.Accept!, 20_000);
    } catch (err) {
      directError = (err as Error).message;
    }
    const isHtml = /html/i.test(direct.type) || /^\s*<(!doctype|html)/i.test(direct.body);
    const fetched = direct.status === 200 && direct.body && !/pdf/i.test(direct.type);
    // The article itself first (reader mode, here), then the page's plain text:
    // a page too short to be an article (a definition, a quote, a changelog
    // entry) is still worth reading, and the plain text is what those have.
    const article = fetched && isHtml ? articleMarkdown(direct.body, url.toString()) : null;
    const directText = fetched ? (isHtml ? (article?.text ?? htmlToText(direct.body)) : direct.body.trim()) : "";
    if (directText.length >= MIN_ARTICLE_CHARS) {
      const { text, truncated } = capText(directText, READ_TEXT_MAX);
      return {
        ok: true,
        url: url.toString(),
        title: article?.title || (isHtml ? htmlTitle(direct.body) : ""),
        text,
        truncated,
        via: article ? "readability" : "direct",
      };
    }

    // Nothing usable directly (blocked bot, JS-only page, PDF, an error): this
    // machine's own page reader gets the first try, so the address stays local.
    const local = await fetchThroughLocalReader(url.toString());
    if (local) {
      const localArticle = articleMarkdown(local.html, url.toString());
      const localText = localArticle?.text ?? htmlToText(local.html);
      if (localText.length >= MIN_ARTICLE_CHARS) {
        const { text, truncated } = capText(localText, READ_TEXT_MAX);
        return {
          ok: true,
          url: url.toString(),
          title: localArticle?.title || local.title || htmlTitle(local.html),
          text,
          truncated,
          via: "scrapling",
        };
      }
    }

    // Still nothing (no local reader installed, or it couldn't either): the free
    // reader service renders and cleans it. Its URL is public, which is the one
    // privacy note the guide makes about this path.
    const readerUrl = `${config.jinaReaderUrl.replace(/\/+$/, "")}/${url.toString()}`;
    try {
      const read = await fetchText(readerUrl, "text/plain", 30_000);
      const text = read.body.trim();
      // A short answer can be a real one (a definition, a quote) — only a
      // near-empty body means the reader shrugged.
      if (read.status === 200 && text.length >= 40) {
        const capped = capText(text, READ_TEXT_MAX);
        return { ok: true, url: url.toString(), title: "", text: capped.text, truncated: capped.truncated, via: "reader" };
      }
      throw new Error(`the reader answered ${read.status}`);
    } catch (err) {
      const why = directError || (direct.status ? `the site answered ${direct.status}` : "the page had no readable text");
      const localNote = config.scraplingUrl ? "the local page reader also failed" : "no local page reader is installed (see scrapling/README.md)";
      throw new Error(`I couldn't read ${url.hostname} (${why}; ${localNote}, and the reader service failed: ${(err as Error).message}).`);
    }
  },

  async search(query: string, limit?: number): Promise<YtSearchResult[]> {
    return searchVideos(query, { limit });
  },
};
