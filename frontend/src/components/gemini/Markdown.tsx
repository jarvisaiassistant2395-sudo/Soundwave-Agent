// ── An answer, rendered ─────────────────────────────────────────────────────
// The point of the file tab: an answer that arrives as one grey block is the
// thing this exists to avoid. Headings get real sizes, bold is bold, a table is
// a table, code is monospace with a Copy button — the Gemini app's look, in this
// app's colours.
//
// Everything is React elements built from lib/markdown's tree: no innerHTML, no
// dangerouslySetInnerHTML, so a model that writes `<script>` writes four
// characters. Links are opened in a new tab only when lib/markdown said they are
// http(s)/mailto.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { parseMarkdown, markdownToPlainText, type Block, type Inline } from "../../lib/markdown";

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case "text":
            return <span key={index}>{node.text}</span>;
          case "code":
            return (
              <code key={index} className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[13px] text-cyan-200">
                {node.text}
              </code>
            );
          case "strong":
            return (
              <strong key={index} className="font-semibold text-white">
                <InlineNodes nodes={node.children} />
              </strong>
            );
          case "em":
            return (
              <em key={index} className="italic">
                <InlineNodes nodes={node.children} />
              </em>
            );
          case "strike":
            return (
              <s key={index} className="text-gray-500">
                <InlineNodes nodes={node.children} />
              </s>
            );
          case "link":
            return (
              <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" className="text-cyan-400 underline decoration-cyan-400/40 underline-offset-2 hover:decoration-cyan-300">
                <InlineNodes nodes={node.children} />
              </a>
            );
          case "break":
            return <br key={index} />;
        }
      })}
    </>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-gray-400 transition-colors hover:bg-white/5 hover:text-gray-200"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={label}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-white/10 bg-[#05070d]">
      <div className="flex items-center justify-between border-b border-white/8 bg-white/[0.03] px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-gray-500">{language || "code"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed">
        <code className="font-mono text-gray-200">{code}</code>
      </pre>
    </div>
  );
}

function Table({ head, rows, align }: { head: Inline[][]; rows: Inline[][][]; align: Array<"left" | "center" | "right"> }) {
  const alignClass = (index: number) => (align[index] === "center" ? "text-center" : align[index] === "right" ? "text-right" : "text-left");
  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full border-collapse text-[13.5px]">
        <thead>
          <tr className="bg-white/[0.04]">
            {head.map((cell, index) => (
              <th key={index} className={`border-b border-white/10 px-3 py-2 font-semibold text-gray-100 ${alignClass(index)}`}>
                <InlineNodes nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-white/[0.015]">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className={`border-b border-white/5 px-3 py-2 align-top text-gray-300 ${alignClass(cellIndex)}`}>
                  <InlineNodes nodes={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlockNode({ block }: { block: Block }) {
  switch (block.type) {
    case "heading": {
      const sizes: Record<number, string> = {
        1: "text-[26px] leading-8 font-semibold text-white mt-6 mb-2",
        2: "text-[21px] leading-7 font-semibold text-white mt-5 mb-2",
        3: "text-[17px] leading-6 font-semibold text-gray-50 mt-4 mb-1.5",
        4: "text-[15px] leading-6 font-semibold text-gray-100 mt-3 mb-1",
        5: "text-[14px] leading-6 font-semibold text-gray-200 mt-3 mb-1",
        6: "text-[13px] leading-6 font-semibold uppercase tracking-wide text-gray-400 mt-3 mb-1",
      };
      const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag className={`${sizes[block.level]} first:mt-0`}>
          <InlineNodes nodes={block.content} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="my-2.5 text-[14.5px] leading-7 text-gray-200 first:mt-0">
          <InlineNodes nodes={block.content} />
        </p>
      );
    case "code":
      return <CodeBlock code={block.text} language={block.language} />;
    case "list":
      return (
        <ul className="my-2 space-y-1 pl-1">
          {block.items.map((item, index) => (
            <li key={index} className="flex gap-2.5 text-[14.5px] leading-7 text-gray-200">
              <span className={`mt-[3px] shrink-0 select-none ${block.ordered ? "min-w-5 text-right font-medium text-cyan-300/80" : "text-cyan-300/80"}`}>
                {item.checked === undefined ? (block.ordered ? `${block.start + index}.` : "•") : item.checked ? "☑" : "☐"}
              </span>
              <span className="min-w-0 flex-1">
                <InlineNodes nodes={item.content} />
                {item.children.length > 0 && (
                  <div className="mt-1 border-l border-white/10 pl-3">
                    {item.children.map((child, childIndex) => (
                      <BlockNode key={childIndex} block={child} />
                    ))}
                  </div>
                )}
              </span>
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote className="my-3 border-l-2 border-cyan-500/40 pl-3 text-gray-300">
          {block.blocks.map((child, index) => (
            <BlockNode key={index} block={child} />
          ))}
        </blockquote>
      );
    case "table":
      return <Table head={block.head} rows={block.rows} align={block.align} />;
    case "hr":
      return <hr className="my-4 border-white/10" />;
  }
}

/**
 * An answer. `streaming` adds the caret that tells the person it is still being
 * written; the blocks are re-parsed on every delta because answers are short
 * enough that it costs nothing and the markup is always correct.
 */
export function Markdown({ source, streaming = false }: { source: string; streaming?: boolean }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="sw-markdown">
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} />
      ))}
      {streaming && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] animate-pulse bg-cyan-300" />}
    </div>
  );
}

/** Copy the whole answer as plain text — what the toolbar's button does. */
export function plainTextOf(source: string): string {
  return markdownToPlainText(parseMarkdown(source));
}
