// The file-chat tab renders Gemini's Markdown with its own parser (it is also
// compiled into the phone later, so it lives in frontend/src/lib and is tested
// here the way frontend/src/lib/agentChat.ts is — see chat_messages.test.ts).
// What matters: headings and bold are real structure, tables are tables, a
// half-streamed answer never throws, and nothing a model writes can become HTML.
import { describe, expect, it } from "vitest";
import { inlineMarkdown, markdownToPlainText, parseMarkdown, safeHref, type Inline } from "../../frontend/src/lib/markdown.js";

const textOf = (source: string): string =>
  markdownToPlainText(parseMarkdown(source));

describe("blocks", () => {
  it("reads headings at every level", () => {
    const blocks = parseMarkdown("# Title\n\n## Section\n\n### Detail\n#### Small\n##### Smaller\n###### Tiny");
    expect(blocks.map((b) => (b.type === "heading" ? b.level : b.type))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(blocks[0]).toMatchObject({ type: "heading", content: [{ type: "text", text: "Title" }] });
    // A hash without a space is not a heading, and a heading with no text yet is
    // not one either (it is the first character of a streamed answer).
    expect(parseMarkdown("#nope").map((b) => b.type)).toEqual(["paragraph"]);
    expect(parseMarkdown("#").map((b) => b.type)).toEqual(["paragraph"]);
  });

  it("reads a setext heading", () => {
    expect(parseMarkdown("Revenue grew\n=============")[0]).toMatchObject({ type: "heading", level: 1 });
    expect(textOf("Revenue grew\n-------------")).toBe("Revenue grew");
  });

  it("keeps soft-wrapped lines in one paragraph", () => {
    const blocks = parseMarkdown("One line\nand its continuation.\n\nA new paragraph.");
    expect(blocks).toHaveLength(2);
    expect(textOf("One line\nand its continuation.")).toBe("One line and its continuation.");
  });

  it("reads fenced code with its language, and survives an unclosed fence", () => {
    const closed = parseMarkdown("```ts\nconst x = 1;\n```");
    expect(closed[0]).toMatchObject({ type: "code", language: "ts", text: "const x = 1;" });
    const streaming = parseMarkdown("Here:\n\n```python\nprint(1)\npr");
    expect(streaming[1]).toMatchObject({ type: "code", language: "python" });
    expect((streaming[1] as { text: string }).text).toContain("pr");
    // Tildes too, and a language with a friendly name.
    expect(parseMarkdown("~~~js\nlet a\n~~~")[0]).toMatchObject({ type: "code", language: "js" });
    // Markdown inside code is not markup.
    expect(textOf("```\n**not bold**\n```")).toBe("**not bold**");
  });

  it("reads lists, numbering, nesting and tasks", () => {
    const list = parseMarkdown("- one\n- two\n  - nested\n- three")[0];
    expect(list).toMatchObject({ type: "list", ordered: false });
    expect((list as { items: Array<{ content: unknown; children: unknown[] }> }).items).toHaveLength(3);
    expect((list as { items: Array<{ children: unknown[] }> }).items[1]!.children[0]).toMatchObject({ type: "list", ordered: false });

    const ordered = parseMarkdown("3. three\n4. four")[0];
    expect(ordered).toMatchObject({ type: "list", ordered: true, start: 3 });

    const tasks = parseMarkdown("- [ ] todo\n- [x] done")[0];
    expect((tasks as { items: Array<{ checked?: boolean }> }).items.map((it) => it.checked)).toEqual([false, true]);

    // A wrapped list item stays one item.
    expect(textOf("- a long item\n  that wraps")).toBe("- a long item\nthat wraps");
  });

  it("reads tables with alignment, and pads rows still being typed", () => {
    const table = parseMarkdown("| Region | Sales |\n|:-------|------:|\n| North | 1,250 |\n| South |")[0];
    expect(table).toMatchObject({ type: "table", align: ["left", "right"] });
    const rows = (table as { rows: unknown[][] }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(2); // padded, so the table does not jump
    expect(textOf("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a\tb\n1\t2");
  });

  it("reads quotes and horizontal rules", () => {
    const quote = parseMarkdown("> Worth remembering.\n> Second line.")[0];
    expect(quote.type).toBe("quote");
    expect((quote as { blocks: Array<{ type: string }> }).blocks[0]).toMatchObject({ type: "paragraph" });
    expect(parseMarkdown("above\n\n---\n\nbelow").map((b) => b.type)).toEqual(["paragraph", "hr", "paragraph"]);
  });

  it("never invents a table from a paragraph", () => {
    expect(parseMarkdown("a | b\nnot a table").map((b) => b.type)).toEqual(["paragraph"]);
  });
});

describe("inline", () => {
  it("makes bold, italic, code and strikethrough", () => {
    expect(inlineMarkdown("Revenue **grew 18%** this quarter")).toEqual([
      { type: "text", text: "Revenue " },
      { type: "strong", children: [{ type: "text", text: "grew 18%" }] },
      { type: "text", text: " this quarter" },
    ]);
    expect(inlineMarkdown("_very_ important")).toEqual([
      { type: "em", children: [{ type: "text", text: "very" }] },
      { type: "text", text: " important" },
    ]);
    expect(inlineMarkdown("`npm run build` now")).toEqual([
      { type: "code", text: "npm run build" },
      { type: "text", text: " now" },
    ]);
    expect(inlineMarkdown("~~gone~~")).toEqual([{ type: "strike", children: [{ type: "text", text: "gone" }] }]);
    // Bold inside a list item, italic inside bold.
    expect(inlineMarkdown("**a _b_ c**")).toEqual([{ type: "strong", children: [{ type: "text", text: "a " }, { type: "em", children: [{ type: "text", text: "b" }] }, { type: "text", text: " c" }] }]);
  });

  it("leaves filenames and snake_case alone", () => {
    expect(inlineMarkdown("the file report_final_v2.pdf")).toEqual([{ type: "text", text: "the file report_final_v2.pdf" }]);
    expect(inlineMarkdown("call fetch_user_data()")).toEqual([{ type: "text", text: "call fetch_user_data()" }]);
  });

  it("handles escapes and partial emphasis while streaming", () => {
    expect(inlineMarkdown("a \\*literal\\* star")).toEqual([{ type: "text", text: "a *literal* star" }]);
    // A lone opening marker is text, not an empty tag.
    expect(inlineMarkdown("**bold so far")).toEqual([{ type: "text", text: "**bold so far" }]);
    expect(inlineMarkdown("5 * 3 = 15")).toEqual([{ type: "text", text: "5 * 3 = 15" }]);
  });

  it("links, and refuses to link anywhere dangerous", () => {
    expect(safeHref("https://soundwave.test/x")).toBe("https://soundwave.test/x");
    expect(safeHref("mailto:a@b.test")).toBe("mailto:a@b.test");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeHref("/api/v1/gemini/files/abc")).toBeNull(); // relative paths are not model-controlled links
    expect(safeHref("javascript:\u0000")).toBeNull();

    expect(inlineMarkdown("see [the docs](https://x.test/d)")).toEqual([
      { type: "text", text: "see " },
      { type: "link", href: "https://x.test/d", children: [{ type: "text", text: "the docs" }] },
    ]);
    // A javascript: "link" keeps its words and loses its link.
    expect(inlineMarkdown("[click](javascript:alert(1))")).toEqual([{ type: "text", text: "[click](javascript:alert(1))" }]);
    expect(inlineMarkdown("go to https://x.test/a.b now")[1]).toMatchObject({ type: "link", href: "https://x.test/a.b" });
  });

  it("turns a line break into a break", () => {
    expect(inlineMarkdown("one\ntwo")).toEqual([{ type: "text", text: "one" }, { type: "break" }, { type: "text", text: "two" }]);
  });
});

describe("tolerance while streaming", () => {
  it("parses every prefix of a real answer without throwing", () => {
    const answer = [
      "## Summary",
      "",
      "Revenue **grew 18%** to 1.2M in Q3.",
      "",
      "- North: 480k",
      "- South: 320k",
      "",
      "| Region | Growth |",
      "|--------|-------:|",
      "| North | 21% |",
      "",
      "```js",
      "const total = 1200000;",
      "```",
    ].join("\n");
    for (let length = 0; length <= answer.length; length += 1) {
      const blocks = parseMarkdown(answer.slice(0, length));
      expect(Array.isArray(blocks)).toBe(true);
      expect(() => markdownToPlainText(blocks)).not.toThrow();
    }
  });

  it("shows a half-typed table row as it is", () => {
    const blocks = parseMarkdown("| a | b |\n|---|---|\n| 1 |");
    expect(blocks[0]).toMatchObject({ type: "table" });
    // The empty cell is padded in the structure (so the renderer keeps the
    // columns straight); copied text is trimmed, as copied text should be.
    expect((blocks[0] as { rows: Inline[][] }).rows[0]).toHaveLength(2);
    expect(markdownToPlainText(blocks)).toBe("a\tb\n1");
  });

  it("copies the answer as plain text", () => {
    const plain = textOf("# Title\n\n**Bold** and `code`.\n\n- one\n- two\n\n[A link](https://x.test)");
    expect(plain).toBe("Title\n\nBold and code.\n\n- one\n- two\n\nA link");
  });
});
