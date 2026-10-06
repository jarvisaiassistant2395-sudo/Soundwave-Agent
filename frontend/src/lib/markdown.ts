// ── Markdown → blocks, for answers that should look written ──────────────────
// Gemini answers in Markdown, and the app has to make that look like the Gemini
// app rather than like a terminal: real headings at real sizes, bold that is
// bold, tables that are tables. No dependency (the frontend ships none for this
// and the phone will reuse these rules) — a small, well-tested parser that
// covers what a model actually writes.
//
// Two things it does that a naive regex pass does not:
//   • it is tolerant of a half-written answer, because answers are rendered
//     while they stream in: an unclosed code fence is code to the end, a heading
//     without its text yet is not a heading, a table row still being typed is
//     just shown as it is;
//   • it never trusts a link: only http(s)/mailto become links, everything else
//     stays text, and the renderer escapes every string it is given.

export interface MarkdownText {
  type: "text";
  text: string;
}
export interface MarkdownCode {
  type: "code";
  text: string;
}
export interface MarkdownStrong {
  type: "strong";
  children: Inline[];
}
export interface MarkdownEm {
  type: "em";
  children: Inline[];
}
export interface MarkdownStrike {
  type: "strike";
  children: Inline[];
}
export interface MarkdownLink {
  type: "link";
  href: string;
  children: Inline[];
}
export interface MarkdownBreak {
  type: "break";
}

export type Inline = MarkdownText | MarkdownCode | MarkdownStrong | MarkdownEm | MarkdownStrike | MarkdownLink | MarkdownBreak;

export interface MarkdownHeading {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  content: Inline[];
}
export interface MarkdownParagraph {
  type: "paragraph";
  content: Inline[];
}
export interface MarkdownCodeBlock {
  type: "code";
  language: string;
  text: string;
}
export interface MarkdownListItem {
  content: Inline[];
  /** Task lists: undefined = not a task, false = open, true = done. */
  checked?: boolean;
  /** A nested list or paragraph under this item. */
  children: Block[];
}
export interface MarkdownList {
  type: "list";
  ordered: boolean;
  start: number;
  items: MarkdownListItem[];
}
export interface MarkdownQuote {
  type: "quote";
  blocks: Block[];
}
export interface MarkdownTable {
  type: "table";
  head: Inline[][];
  rows: Inline[][][];
  align: Array<"left" | "center" | "right">;
}
export interface MarkdownHr {
  type: "hr";
}

export type Block = MarkdownHeading | MarkdownParagraph | MarkdownCodeBlock | MarkdownList | MarkdownQuote | MarkdownTable | MarkdownHr;

const SAFE_PROTOCOL = /^(https?:|mailto:)/i;

/** A link target we are willing to put in an href, or null (it stays text). */
export function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/^<|>$/g, "");
  if (!href || /[\u0000-\u001f]/.test(href)) return null;
  return SAFE_PROTOCOL.test(href) ? href : null;
}

/** Text with its escapes resolved — `\*` is a star, not emphasis. */
function unescapeText(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1");
}

/**
 * Inline markdown: code, bold, italic, strike, links (and bare URLs). Returned
 * as a tree so the renderer can nest React elements instead of setting HTML.
 */
export function inlineMarkdown(source: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  let i = 0;
  const flush = () => {
    if (buffer) out.push({ type: "text", text: unescapeText(buffer) });
    buffer = "";
  };

  /** Everything up to the matching closer, or null when there is none. */
  const findClose = (marker: string, from: number): number => {
    const at = source.indexOf(marker, from);
    return at < 0 ? -1 : at;
  };

  while (i < source.length) {
    const char = source[i]!;

    // Escapes first: `\*` is a literal star.
    if (char === "\\" && i + 1 < source.length) {
      buffer += source.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (char === "`") {
      // A run of backticks closes only on the same-length run.
      let run = 1;
      while (source[i + run] === "`") run += 1;
      const marker = "`".repeat(run);
      const close = source.indexOf(marker, i + run);
      if (close > i) {
        flush();
        out.push({ type: "code", text: source.slice(i + run, close).replace(/\n/g, " ") });
        i = close + run;
        continue;
      }
      buffer += marker;
      i += run;
      continue;
    }

    if (char === "[" && !source.startsWith("![", i - 1)) {
      // [text](href) — a link only when the target is one we would follow.
      const label = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(source.slice(i));
      if (label) {
        const href = safeHref(label[2] ?? "");
        if (href) {
          flush();
          out.push({ type: "link", href, children: inlineMarkdown(label[1] ?? "") });
          i += label[0].length;
          continue;
        }
      }
    }

    if (source.startsWith("**", i) || source.startsWith("__", i)) {
      const marker = source.slice(i, i + 2);
      const close = findClose(marker, i + 2);
      if (close > i + 2) {
        flush();
        out.push({ type: "strong", children: inlineMarkdown(source.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (source.startsWith("~~", i)) {
      const close = findClose("~~", i + 2);
      if (close > i + 2) {
        flush();
        out.push({ type: "strike", children: inlineMarkdown(source.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      // Underscores only emphasise at a word boundary, so file_names survive.
      const wordBoundary = char === "*" || !/[\w]/.test(source[i - 1] ?? " ") || !/[\w]/.test(source[i + 1] ?? " ");
      const close = findClose(char, i + 1);
      if (wordBoundary && close > i + 1 && !/^\s/.test(source.slice(i + 1, close))) {
        flush();
        out.push({ type: "em", children: inlineMarkdown(source.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }

    // A bare URL is a link — but never one we invented from a partial word.
    if (source.startsWith("http://", i) || source.startsWith("https://", i)) {
      const url = /^https?:\/\/[^\s<>()]+/.exec(source.slice(i))![0];
      flush();
      out.push({ type: "link", href: safeHref(url.replace(/[.,;:]+$/, "")) ?? url, children: [{ type: "text", text: url }] });
      i += url.length;
      continue;
    }

    if (char === "\n") {
      flush();
      out.push({ type: "break" });
      i += 1;
      continue;
    }

    buffer += char;
    i += 1;
  }
  flush();
  return out;
}

const isBlank = (line: string) => line.trim() === "";
const headingMatch = (line: string) => /^(#{1,6})\s+(.*)$/.exec(line.trim());
const hrMatch = (line: string) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]*)\s*$/;
const listMatch = (line: string) => /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);

const cells = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
};
const isDelimiterRow = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");

/** Markdown source → blocks. Tolerant: anything unparseable is a paragraph. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // Fenced code — an unclosed fence runs to the end of the answer.
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const language = (fence[2] ?? "").toLowerCase();
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !new RegExp(`^\\s{0,3}\\${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // the closing fence
      blocks.push({ type: "code", language, text: body.join("\n") });
      continue;
    }

    if (hrMatch(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const heading = headingMatch(line);
    if (heading) {
      blocks.push({ type: "heading", level: Math.min(6, heading[1]!.length) as 1 | 2 | 3 | 4 | 5 | 6, content: inlineMarkdown(heading[2]!.trim()) });
      i += 1;
      continue;
    }

    // A setext heading: a line underlined with === or ---.
    if (!isBlank(line) && i + 1 < lines.length && /^\s{0,3}(=+|-{2,})\s*$/.test(lines[i + 1]!) && !listMatch(line)) {
      const underline = lines[i + 1]!.trim();
      blocks.push({ type: "heading", level: underline.startsWith("=") ? 1 : 2, content: inlineMarkdown(line.trim()) });
      i += 2;
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i]!.trimStart().startsWith(">") || (!isBlank(lines[i]!) && quoted.length && !isBlank(lines[i - 1]!)))) {
        quoted.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", blocks: parseMarkdown(quoted.join("\n")) });
      continue;
    }

    // A table: a row of cells, then a delimiter row.
    if (line.includes("|") && i + 1 < lines.length && isDelimiterRow(lines[i + 1]!)) {
      const align = cells(lines[i + 1]!).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left")) as Array<"left" | "center" | "right">;
      const head = cells(line).map((cell) => inlineMarkdown(cell));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.includes("|") && !isBlank(lines[i]!)) {
        const row = cells(lines[i]!).map((cell) => inlineMarkdown(cell));
        // A row still being typed may have the wrong width; pad it so the table
        // never jumps around while the answer streams in.
        while (row.length < head.length) row.push([]);
        rows.push(row.slice(0, Math.max(head.length, row.length)));
        i += 1;
        if (rows.length > 200) break; // a table that is not a table
      }
      blocks.push({ type: "table", head, rows, align });
      continue;
    }

    const item = listMatch(line);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const start = ordered ? Number.parseInt(item[2]!, 10) || 1 : 1;
      const items: MarkdownListItem[] = [];
      while (i < lines.length) {
        const current = listMatch(lines[i]!);
        if (!current) {
          // A wrapped line of the item above.
          if (items.length && !isBlank(lines[i]!) && /^\s{2,}/.test(lines[i]!)) {
            const last = items[items.length - 1]!;
            const extra = lines[i]!.trim();
            last.content = [...last.content, { type: "break" as const }, ...inlineMarkdown(extra)];
            i += 1;
            continue;
          }
          break;
        }
        if (/\d/.test(current[2]!) !== ordered) break;
        let text = current[3]!;
        let checked: boolean | undefined;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
        if (task) {
          checked = task[1]!.toLowerCase() === "x";
          text = task[2]!;
        }
        const entry: MarkdownListItem = { content: inlineMarkdown(text), ...(checked !== undefined ? { checked } : {}), children: [] };
        i += 1;
        // Anything indented under this item is its child content.
        const nested: string[] = [];
        while (i < lines.length && (isBlank(lines[i]!) || /^\s{2,}/.test(lines[i]!)) && !isBlank(lines[i + 1] ?? "")) {
          nested.push(lines[i]!.replace(/^\s{2}/, ""));
          i += 1;
          if (isBlank(lines[i] ?? "")) break;
        }
        if (nested.some((n) => n.trim())) entry.children = parseMarkdown(nested.join("\n"));
        items.push(entry);
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    // A paragraph: consecutive plain lines, soft-wrapped into one.
    const paragraph: string[] = [];
    while (i < lines.length && !isBlank(lines[i]!) && !headingMatch(lines[i]!) && !listMatch(lines[i]!) && !FENCE.test(lines[i]!) && !hrMatch(lines[i]!) && !lines[i]!.trimStart().startsWith(">")) {
      paragraph.push(lines[i]!.trim());
      i += 1;
      if (i < lines.length && isDelimiterRow(lines[i]!) && paragraph.join(" ").includes("|")) break;
    }
    const text = paragraph.join(" ");
    if (text) blocks.push({ type: "paragraph", content: inlineMarkdown(text) });
  }

  return blocks;
}

/** The answer as plain text — what "Copy" puts on the clipboard. */
export function markdownToPlainText(blocks: Block[]): string {
  const inlineText = (nodes: Inline[]): string => nodes.map((node) => (node.type === "text" || node.type === "code" ? node.text : node.type === "break" ? "\n" : inlineText(node.children))).join("");
  const blockText = (list: Block[]): string =>
    list
      .map((block) => {
        switch (block.type) {
          case "heading":
            return inlineText(block.content);
          case "paragraph":
            return inlineText(block.content);
          case "code":
            return block.text;
          case "list":
            return block.items.map((item, index) => `${block.ordered ? `${block.start + index}.` : "-"} ${inlineText(item.content)}`).join("\n");
          case "quote":
            return blockText(block.blocks);
          case "table":
            return [block.head, ...block.rows].map((row) => row.map(inlineText).join("\t")).join("\n");
          case "hr":
            return "";
        }
      })
      .join("\n\n");
  return blockText(blocks).trim();
}
