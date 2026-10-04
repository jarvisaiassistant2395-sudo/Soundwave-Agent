// The agent's "eyes": reading what a video says, what a page says, and what
// YouTube has on a topic. The parsers are pure (real caption and HTML samples,
// including YouTube's rolling auto-captions); the three tools are exercised
// with a stand-in reader so no test touches the network.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capText, clock, decodeEntities, htmlTitle, htmlToText, vttToText } from "../src/lib/brain/core/transcript.js";
import { MAX_ARTICLE_HTML, articleMarkdown, defaultEyes, safePublicUrl } from "../src/lib/eyes.js";
import { config } from "../src/config.js";
import { toolsFor, type ToolContext } from "../src/lib/brain/tools.js";
import type { Eyes } from "../src/lib/eyes.js";

// ── the caption parser ─────────────────────────────────────────────────────

const MANUAL_VTT = `WEBVTT
Kind: captions
Language: en

1
00:00:00.120 --> 00:00:02.400
Welcome back to the channel.

2
00:00:02.400 --> 00:00:05.000
Today we're talking about <c>black holes</c> &amp; gravity.
`;

// YouTube's automatic captions roll the same line along, one word at a time.
const AUTO_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
so the thing about black holes

00:00:02.000 --> 00:00:04.000
so the thing about black holes is

00:00:04.000 --> 00:00:06.000
so the thing about black holes is they

00:00:06.000 --> 00:00:08.000
so the thing about black holes is they bend

00:00:08.000 --> 00:00:10.000
<00:00:08.500><c>so the thing about black holes is they bend light</c>

00:00:10.000 --> 00:00:12.000
and that's why we can see them
`;

const ONE_WORD_OVERLAP_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
and then we

00:00:02.000 --> 00:00:04.000
and then we go into the cave

00:00:04.000 --> 00:00:06.000
the cave is dark
`;

describe("vttToText", () => {
  it("reads manual captions into sentences, dropping cues, timings and markup", () => {
    const text = vttToText(MANUAL_VTT);
    expect(text).toBe("Welcome back to the channel. Today we're talking about black holes & gravity.");
    expect(text).not.toMatch(/-->/);
    expect(text).not.toMatch(/<c>/);
  });

  it("collapses the rolling duplicates of automatic captions into one sentence", () => {
    const text = vttToText(AUTO_VTT);
    expect(text).toBe("so the thing about black holes is they bend light and that's why we can see them");
    // Without the dedupe this reads as five restatements of the same words.
    expect(text.match(/black holes/g)?.length).toBe(1);
  });

  it("keeps every spoken word when a cue repeats the previous cue's tail", () => {
    // "…into the cave" + "the cave is dark": a dropped-word heuristic would read
    // better and lose two words — the transcript must not lose words.
    expect(vttToText(ONE_WORD_OVERLAP_VTT)).toBe("and then we go into the cave the cave is dark");
  });

  it("returns nothing for an empty or cue-less file instead of throwing", () => {
    expect(vttToText("")).toBe("");
    expect(vttToText("WEBVTT\n\nNOTE a note\n")).toBe("");
  });

  it("decodes the entities that show up in captions and picks a clock", () => {
    expect(decodeEntities("Tom &amp; Jerry &quot;best&quot; &#39;bit&#39;")).toBe('Tom & Jerry "best" \'bit\'');
    expect(clock(59)).toBe("0:59");
    expect(clock(754)).toBe("12:34");
    expect(clock(3723)).toBe("1:02:03");
  });
});

// ── the page parser ────────────────────────────────────────────────────────

describe("htmlToText", () => {
  it("keeps the article and drops the machinery around it", () => {
    const html = `<!doctype html><html><head><title>How Rocket Engines Work</title>
      <style>body{color:red}</style><script>window.x = 1;</script></head>
      <body><nav><a href="/">Home</a><a href="/about">About</a></nav>
      <h1>How Rocket Engines Work</h1>
      <p>An engine burns &amp; pushes.</p><ul><li>Fuel</li><li>Oxidiser</li></ul>
      <footer>© 2026</footer></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("How Rocket Engines Work");
    expect(text).toContain("An engine burns & pushes.");
    expect(text).toContain("• Fuel");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("window.x");
    expect(text).not.toContain("Home");
    expect(htmlTitle(html)).toBe("How Rocket Engines Work");
  });

  it("leaves no tag soup and collapses whitespace", () => {
    const text = htmlToText("<div><p>one</p><p>two</p></div><span>   three   </span>");
    expect(text).toBe("one\ntwo\nthree");
  });
});

describe("capText", () => {
  it("keeps short text as it is", () => {
    expect(capText("short", 100)).toEqual({ text: "short", truncated: false });
  });
  it("cuts on a boundary and says it was cut", () => {
    const { text, truncated } = capText("word ".repeat(50), 40);
    expect(truncated).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(41);
  });
});

// ── the URL guard ──────────────────────────────────────────────────────────

describe("safePublicUrl", () => {
  it("accepts public http(s) and refuses everything else", () => {
    expect(safePublicUrl("https://example.com/a")?.hostname).toBe("example.com");
    expect(safePublicUrl("http://news.example.org")?.protocol).toBe("http:");
    expect(safePublicUrl("http://127.0.0.1:8080/api")).toBeNull();
    expect(safePublicUrl("http://localhost/x")).toBeNull();
    expect(safePublicUrl("http://192.168.1.5/router")).toBeNull();
    expect(safePublicUrl("file:///etc/passwd")).toBeNull();
    expect(safePublicUrl("javascript:alert(1)")).toBeNull();
    expect(safePublicUrl("not a url")).toBeNull();
  });
});

// ── the reader fallback, over real HTTP ────────────────────────────────────
// The sandbox and CI both have a stand-in reader on loopback (JINA_READER_URL):
// a page that can't be read directly must come back through it, word for word.
// A real page shape: chrome around an article, and a script that would fake
// content if it ever ran.
const ARTICLE_HTML = `<!doctype html><html lang="en"><head><title>Rocket Engines, Explained</title>
<meta name="author" content="A. Writer"><script>document.body.innerHTML = "<p>" + "injected".repeat(40) + "</p>"</script></head>
<body><nav><a href="/">Home</a><a href="/news">News</a></nav>
<article><h1>How rocket engines work</h1>
<p>An engine burns and pushes: fuel and oxidiser meet, and the result is <strong>thrust</strong>.</p>
<p>There are two families of engines, and the difference is how the fuel is stored.</p>
<ul><li>Solid motors: simple, once lit they burn.</li><li>Liquid engines: throttled, restartable.</li></ul>
<blockquote>Every kilogram counts.</blockquote></article>
<aside><p>Subscribe to our newsletter!</p></aside><footer><p>© 2026 Example</p></footer></body></html>`;

describe("reading a page here (Readability + Turndown, no service)", () => {
  it("pulls the article out of the page as markdown, not the chrome", () => {
    const out = articleMarkdown(ARTICLE_HTML, "https://example.com/rockets")!;
    expect(out).toBeTruthy();
    expect(out.title).toMatch(/Rocket Engines/);
    expect(out.text).toMatch(/^## How rocket engines work/m);
    expect(out.text).toMatch(/\*\*thrust\*\*/);
    expect(out.text).toMatch(/^- Solid motors: simple, once lit they burn\.$/m);
    expect(out.text).toMatch(/^> Every kilogram counts\.$/m);
    // The page's own furniture is not the article.
    expect(out.text).not.toMatch(/Subscribe to our newsletter/);
    expect(out.text).not.toMatch(/Home|News/);
    expect(out.text).not.toMatch(/© 2026 Example/);
    expect(out.text).not.toMatch(/<p>|<li>|<h1>/);
  });

  it("never runs the page's scripts (and refuses to fake content for them)", () => {
    const out = articleMarkdown(ARTICLE_HTML, "https://example.com/rockets");
    expect(out?.text ?? "").not.toMatch(/injected/);
    // A shell whose text only exists in JavaScript has no article to read.
    expect(articleMarkdown('<html><body><div id="root"></div><script>render()</script></body></html>', "https://example.com/app")).toBeNull();
  });

  it("returns nothing for markup it cannot parse or pages too big to be an article", () => {
    expect(articleMarkdown("not html at all", "https://example.com/x")).toBeNull();
    const huge = `<html><body><article><p>${"word ".repeat(MAX_ARTICLE_HTML / 4)}</p></article></body></html>`;
    expect(articleMarkdown(huge, "https://example.com/huge")).toBeNull();
  });

  it("keeps links (with their addresses) and drops images", () => {
    const filler = "<p>An engine burns and pushes, and the numbers decide whether the whole thing leaves the ground at all.</p>";
    const out = articleMarkdown(
      `<html><head><title>Test</title></head><body><article>${filler.repeat(5)}<p>Read <a href="https://example.org/two">the other one</a> next.</p><p><img src="https://tracker.example/pixel.gif" alt="a picture"></p>${filler.repeat(3)}</article></body></html>`,
      "https://example.com/x",
    )!;
    expect(out.text).toMatch(/\[the other one\]\(https:\/\/example\.org\/two\)/);
    expect(out.text).not.toMatch(/tracker\.example/);
  });
});

describe("readPage", () => {
  let server: http.Server;
  let base: string;
  const original = config.jinaReaderUrl;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/blocked-by-js") {
        // A shell with no content: the direct fetch "succeeds" and is useless.
        res.setHeader("Content-Type", "text/html");
        res.end("<html><body><div id=\"root\"></div><script>render()</script></body></html>");
        return;
      }
      res.setHeader("Content-Type", "text/plain");
      res.end(
        "Rendered by the reader service.\n\nTitle: How Rocket Engines Work\n\nAn engine burns and pushes: fuel and oxidiser meet, and the result is thrust.\n",
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The page itself is a public-looking address (the guard refuses loopback),
    // and unreachable here — so the direct fetch fails and the reader answers.
    (config as { jinaReaderUrl: string }).jinaReaderUrl = base;
  });

  afterAll(async () => {
    (config as { jinaReaderUrl: string }).jinaReaderUrl = original;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("falls back to the reader service and says where the text came from", async () => {
    const read = await defaultEyes.readPage("https://example.com/an-article");
    expect(read.via).toBe("reader");
    expect(read.text).toMatch(/Rendered by the reader service/);
    expect(read.url).toBe("https://example.com/an-article");
  });

  it("refuses addresses that aren't public http(s)", async () => {
    await expect(defaultEyes.readPage("http://127.0.0.1:8080/private")).rejects.toThrow(/http\/https only/);
    await expect(defaultEyes.readPage("file:///etc/passwd")).rejects.toThrow(/http\/https only/);
  });

  it("explains both failures when neither the site nor the reader answers", async () => {
    const wasUrl = config.jinaReaderUrl;
    (config as { jinaReaderUrl: string }).jinaReaderUrl = "http://127.0.0.1:1"; // nothing listens
    await expect(defaultEyes.readPage("https://example.com/an-article")).rejects.toThrow(/example\.com/);
    (config as { jinaReaderUrl: string }).jinaReaderUrl = wasUrl;
  });
});

// ── the tools ──────────────────────────────────────────────────────────────

const standIn = (over: Partial<Eyes> = {}): Eyes => ({
  readVideo: async (url: string) => ({
    ok: true as const,
    title: "Black Holes Explained",
    channel: "Space Facts",
    duration: 754,
    captions: "auto" as const,
    transcript: "so the thing about black holes is they bend light",
    truncated: false,
    url,
  }),
  readPage: async (url: string) => ({
    ok: true as const,
    url,
    title: "How Rocket Engines Work",
    text: "An engine burns & pushes.",
    truncated: false,
    via: "direct" as const,
  }),
  search: async (query: string) => [
    {
      id: "dQw4w9WgXcQ",
      title: `${query} — the definitive guide`,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      channel: "Space Facts",
      duration: 754,
      views: 1200000,
      uploadedAt: "20260101",
    },
  ],
  ...over,
});

const ctx = (eyes: Eyes, desktop = true): ToolContext => ({
  userId: "eyes-test",
  voice: "en-US-AvaMultilingualNeural",
  resolution: "720p",
  desktop,
  platform: "win32",
  effects: { log: [] },
  eyes,
});

const tool = (name: string) => toolsFor(ctx(standIn())).find((t) => t.declaration.name === name)!;
const run = async (name: string, args: Record<string, unknown>, c = ctx(standIn())) =>
  toolsFor(c).find((t) => t.declaration.name === name)!.run(args, c);

describe("read_video", () => {
  it("hands the transcript back with the video's facts, and flags auto captions", async () => {
    const out = (await run("read_video", { url: "https://youtu.be/dQw4w9WgXcQ" })) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, title: "Black Holes Explained", channel: "Space Facts", duration: 754, captions: "auto" });
    expect(String(out.note)).toMatch(/automatic captions/);
    expect(String(out.transcript)).toMatch(/black holes/);
  });

  it("says which subtitles these are when the uploader made them", async () => {
    const c = ctx(standIn({ readVideo: async (url: string) => ({ ...(await standIn().readVideo(url)), captions: "manual" as const }) }));
    const out = (await run("read_video", { url: "https://youtu.be/x" }, c)) as Record<string, unknown>;
    expect(String(out.note)).toMatch(/uploader's own subtitles/);
  });

  it("passes a plain-language reason through when the video can't be read", async () => {
    const c = ctx(
      standIn({
        readVideo: async () => {
          throw new Error("This video has no captions, so I can't read it — but I can cut shorts out of it (that listens to the audio with the speech engine).");
        },
      }),
    );
    const out = (await run("read_video", { url: "https://youtu.be/x" }, c)) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toMatch(/no captions/);
  });

  it("asks which video when given none, and is only offered on the desktop app", async () => {
    expect(((await run("read_video", {})) as Record<string, unknown>).ok).toBe(false);
    const web = toolsFor(ctx(standIn(), false)).find((t) => t.declaration.name === "read_video");
    expect(web).toBeUndefined();
  });
});

describe("read_web_page", () => {
  it("returns the readable text and where it came from", async () => {
    const out = (await run("read_web_page", { url: "https://example.com/article" })) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, title: "How Rocket Engines Work", via: "direct" });
    expect(String(out.text)).toMatch(/burns & pushes/);
  });

  it("forwards the honest failure for a page it can't read", async () => {
    const c = ctx(
      standIn({
        readPage: async () => {
          throw new Error("I couldn't read example.com (the page had no readable text; the reader service also failed: the reader answered 429).");
        },
      }),
    );
    const out = (await run("read_web_page", { url: "https://example.com" }, c)) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toMatch(/couldn't read example\.com/);
  });
});

describe("search_youtube", () => {
  it("lists what YouTube has, with length and views, and logs the search", async () => {
    const c = ctx(standIn());
    const out = (await run("search_youtube", { query: "black holes" }, c)) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    const results = out.results as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ channel: "Space Facts", length: "12:34", views: 1200000 });
    expect(c.effects.log.join(" ")).toMatch(/Searched YouTube for “black holes”/);
  });

  it("admits when YouTube had nothing", async () => {
    const c = ctx(standIn({ search: async () => [] }));
    const out = (await run("search_youtube", { query: "zzz nothing" }, c)) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toMatch(/gave me nothing/);
  });

  it("asks what to search for when given nothing", async () => {
    const out = (await run("search_youtube", {})) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toMatch(/search YouTube for/);
  });
});
