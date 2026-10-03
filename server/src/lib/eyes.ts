// ── The agent's eyes: read a video, read a page, search YouTube ─────────────
// What the agent can *read* (not just open in a browser), with the tools we
// already ship: the bundled yt-dlp for anything YouTube, and plain HTTP for
// pages. No Python, no paid API, no login — and when a thing genuinely can't be
// read (no captions, a page that only exists in JavaScript) the caller gets a
// sentence a person would understand rather than an empty result.
//
// The reader service (r.jina.ai by default) is only ever a fallback for pages
// that hand back nothing usable: fetching a page directly keeps the request
// between the person's PC and that site.

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
  /** "direct" = fetched from the site; "reader" = through the reader service. */
  via: "direct" | "reader";
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
    const directText = direct.status === 200 && direct.body && !/pdf/i.test(direct.type) ? (isHtml ? htmlToText(direct.body) : direct.body.trim()) : "";
    if (directText.length >= 300) {
      const { text, truncated } = capText(directText, READ_TEXT_MAX);
      return { ok: true, url: url.toString(), title: isHtml ? htmlTitle(direct.body) : "", text, truncated, via: "direct" };
    }

    // Nothing usable directly (JS-only page, paywall wall, blocked bot, PDF, an
    // error): the free reader service renders and cleans it. Its URL is public,
    // which is the one privacy note the guide makes about this path.
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
      throw new Error(`I couldn't read ${url.hostname} (${why}; the reader service also failed: ${(err as Error).message}).`);
    }
  },

  async search(query: string, limit?: number): Promise<YtSearchResult[]> {
    return searchVideos(query, { limit });
  },
};
