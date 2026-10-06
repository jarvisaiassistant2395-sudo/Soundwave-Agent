// ── Reading the file a person dropped in ────────────────────────────────────
// The rule the tab follows: read it here when here can read it, send it to
// Gemini when only Gemini can. Text, code, CSV, JSON, Word, Excel, PowerPoint,
// EPUB and a PDF with a text layer are all read on this PC — free, private, and
// instant. A photo, a recording, a video, or a scanned PDF has no text to read
// locally, and those go to Gemini's File API (which sees pages and frames, not
// bytes). It is the same promise as the rest of the app: spend the person's
// Gemini quota only where nothing else can do the job.
//
// Everything in this file is pure: bytes in, text and a note out. No disk, no
// network, no state — so the shapes are all unit-tested.

import { docxText, epubText, looksLikeZip, pptxText, xlsxText } from "./zipText.js";
import { looksLikePdf, pdfText } from "./pdfText.js";

/** What a file is, from the outside. */
export type FileKind = "text" | "document" | "pdf" | "image" | "audio" | "video" | "other";

/** How the bytes can be turned into text on this PC ("none" = only Gemini can). */
export type LocalReader = "text" | "docx" | "xlsx" | "pptx" | "epub" | "pdf" | "audio" | "video" | "none";

export interface FileShape {
  kind: FileKind;
  /** Best guess at the MIME type, needed when the file is handed to Gemini. */
  mime: string;
  reader: LocalReader;
  /** True when Gemini can take the bytes itself (Files API / inlineData). */
  native: boolean;
}

/** Characters of text we keep from one file. */
export const FILE_TEXT_MAX_CHARS = 300_000;
/** Bytes we are willing to read as text at all. */
export const FILE_TEXT_MAX_BYTES = 24 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "mdx",
  "rst",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "xml",
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "sass",
  "less",
  "svg",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cs",
  "php",
  "pl",
  "lua",
  "r",
  "m",
  "mm",
  "scala",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "gql",
  "proto",
  "dockerfile",
  "makefile",
  "gitignore",
  "editorconfig",
  "srt",
  "vtt",
  "ass",
  "sub",
  "tex",
  "bib",
  "ris",
  "ics",
  "vcf",
  "diff",
  "patch",
  "rtf",
]);

/** Extensions that are really ZIP archives of XML (or a book). */
const ZIP_READERS: Record<string, LocalReader> = {
  docx: "docx",
  docm: "docx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  pptx: "pptx",
  ppsx: "pptx",
  epub: "epub",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  log: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/json",
  ndjson: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "text/plain",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  env: "text/plain",
  properties: "text/plain",
  xml: "text/xml",
  html: "text/html",
  htm: "text/html",
  xhtml: "text/html",
  css: "text/css",
  scss: "text/plain",
  less: "text/plain",
  svg: "image/svg+xml",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  cc: "text/x-c++",
  hpp: "text/x-c++",
  cs: "text/x-csharp",
  php: "text/x-php",
  sh: "text/x-sh",
  bash: "text/x-sh",
  zsh: "text/x-sh",
  ps1: "text/plain",
  bat: "text/plain",
  cmd: "text/plain",
  sql: "text/plain",
  graphql: "text/plain",
  proto: "text/plain",
  srt: "text/plain",
  vtt: "text/vtt",
  tex: "text/plain",
  rtf: "application/rtf",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  weba: "audio/webm",
  amr: "audio/amr",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  "3gp": "video/3gpp",
  wmv: "video/x-ms-wmv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  epub: "application/epub+zip",
  zip: "application/zip",
};

const extensionOf = (name: string): string => {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? "";
  if (!base.includes(".")) return base; // "dockerfile", "makefile", "license"
  return base.split(".").pop() ?? "";
};

/** A MIME type for a file name, falling back to what the browser said. */
export function mimeFor(name: string, given = ""): string {
  if (given && given !== "application/octet-stream" && !given.startsWith("application/x-")) return given.split(";")[0]!.trim();
  return MIME_BY_EXTENSION[extensionOf(name)] ?? "application/octet-stream";
}

/** Does this look like text a person wrote, rather than bytes that happen to decode? */
function readsAsText(buf: Buffer): boolean {
  if (!buf.length) return true; // an empty file is empty text, not a mystery
  const sample = buf.subarray(0, 8192);
  let binary = 0;
  for (const byte of sample) {
    // NUL and most C0 control bytes never appear in text files.
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) binary += 1;
  }
  return binary / sample.length < 0.02;
}

/**
 * What this file is and how it can be read. `mime` (from the browser) wins over
 * the extension when it is specific, because a phone photo comes in as
 * `image/jpeg` with a name that may not even have an extension.
 */
export function classifyFile(name: string, mime: string, buf: Buffer): FileShape {
  const ext = extensionOf(name);
  const resolved = mimeFor(name, mime);
  const zipReader = ZIP_READERS[ext];

  if (looksLikePdf(buf) || resolved === "application/pdf" || ext === "pdf") {
    return { kind: "pdf", mime: "application/pdf", reader: "pdf", native: true };
  }
  if (zipReader && looksLikeZip(buf)) {
    // Word/Excel/PowerPoint/EPUB are read here — no quota spent. A broken archive
    // that will not open locally is still worth handing to Gemini.
    return { kind: "document", mime: resolved, reader: zipReader, native: false };
  }
  if (resolved.startsWith("image/") && ext !== "svg") return { kind: "image", mime: resolved, reader: "none", native: true };
  if (resolved.startsWith("audio/")) return { kind: "audio", mime: resolved, reader: "audio", native: true };
  if (resolved.startsWith("video/")) return { kind: "video", mime: resolved, reader: "video", native: true };
  // A text extension (or a text MIME) only makes it text if the bytes agree:
  // a PNG that someone renamed to .txt is a picture, and handing its bytes to
  // the model as text would be worse than saying what it really is.
  if (
    (resolved.startsWith("text/") || TEXT_EXTENSIONS.has(ext) || /^application\/(json|xml|yaml|rtf)/.test(resolved)) &&
    readsAsText(buf)
  ) {
    return { kind: "text", mime: resolved, reader: "text", native: false };
  }
  // No extension, nothing useful from the browser: decide by the bytes.
  if (readsAsText(buf))
    return { kind: "text", mime: resolved === "application/octet-stream" ? "text/plain" : resolved, reader: "text", native: false };
  if (ext === "zip") return { kind: "other", mime: resolved, reader: "none", native: false };
  // A binary file wearing a text extension is still just bytes.
  if (TEXT_EXTENSIONS.has(ext)) return { kind: "other", mime: resolved, reader: "none", native: false };
  return { kind: "other", mime: resolved, reader: "none", native: false };
}

export interface ExtractedText {
  text: string;
  /** A sentence for the person: what was read, and what could not be. */
  note: string;
  truncated: boolean;
  /** A PDF with no text layer (a scan) — Gemini can still read its pages. */
  scanned: boolean;
  encrypted: boolean;
}

const empty = (note: string): ExtractedText => ({ text: "", note, truncated: false, scanned: false, encrypted: false });

/** Markdown-ish text out of an HTML file: title, headings, paragraphs, lists. */
function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const body = html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title && !body.startsWith(`# ${title}`) ? `# ${title}\n\n${body}` : body;
}

/** Word's plain-text export: strip the RTF control words. */
function rtfToText(rtf: string): string {
  return rtf
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\tab\b/g, "\t")
    .replace(/\{\\\*[\s\S]*?\}/g, "")
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The bytes as text, with a note about how much was kept. */
function plainText(buf: Buffer, mime: string, name: string): ExtractedText {
  const ext = extensionOf(name);
  // NUL bytes are stripped on purpose: they turn up in exported documents and
  // break the XML the exporter builds later.
  // eslint-disable-next-line no-control-regex -- removing NULs on purpose
  let text = buf
    .subarray(0, FILE_TEXT_MAX_BYTES)
    .toString("utf8")
    .replace(/\r\n/g, "\n")
    // NUL bytes come out of exported documents and break the XML built later.
    // eslint-disable-next-line no-control-regex -- removing NULs on purpose
    .replace(/\u0000/g, "");
  if (mime === "text/html" || ext === "html" || ext === "htm") text = htmlToText(text);
  else if (mime === "application/rtf" || ext === "rtf") text = rtfToText(text);
  else if (ext === "json" || mime === "application/json") {
    // Pretty-print when it parses: a wall of minified JSON is unreadable to a
    // person and no easier for the model.
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not valid JSON — and sometimes that is the point */
    }
  }
  const overBytes = buf.length > FILE_TEXT_MAX_BYTES;
  const truncated = text.length > FILE_TEXT_MAX_CHARS || overBytes;
  if (text.length > FILE_TEXT_MAX_CHARS) text = text.slice(0, FILE_TEXT_MAX_CHARS);
  return { text, note: truncated ? "the beginning of it" : "", truncated, scanned: false, encrypted: false };
}

/**
 * Text out of a file, read on this PC. `shape` comes from classifyFile, so the
 * caller decides *whether* to read (never a 2 GB video through here).
 */
export function extractText(buf: Buffer, shape: FileShape, name = ""): ExtractedText {
  try {
    switch (shape.reader) {
      case "text":
        return plainText(buf, shape.mime, name);
      case "pdf": {
        const pdf = pdfText(buf);
        if (pdf.encrypted)
          return {
            text: "",
            note: "this PDF is password-protected, so nothing could be read from it",
            truncated: false,
            scanned: false,
            encrypted: true,
          };
        if (pdf.scanned)
          return {
            text: "",
            note: "this PDF is a scan — there is no text in the file itself, only page images",
            truncated: false,
            scanned: true,
            encrypted: false,
          };
        return {
          text: pdf.text,
          note: pdf.truncated ? "the first part of it" : "",
          truncated: pdf.truncated,
          scanned: false,
          encrypted: false,
        };
      }
      case "docx": {
        const text = docxText(buf);
        return text ? cut(text, "the document text") : empty("no readable text was found inside this document");
      }
      case "xlsx": {
        const text = xlsxText(buf);
        return text ? cut(text, "the spreadsheet's sheets and rows") : empty("no readable cells were found inside this spreadsheet");
      }
      case "pptx": {
        const text = pptxText(buf);
        return text ? cut(text, "the slides' text") : empty("no readable text was found inside these slides");
      }
      case "epub": {
        const text = epubText(buf);
        return text ? cut(text, "the book's chapters") : empty("no readable chapters were found inside this book");
      }
      case "audio":
        return { ...empty("the recording is being listened to on this PC"), text: "", scanned: false, encrypted: false, truncated: false };
      case "video":
        return { ...empty("the sound is being listened to on this PC"), text: "", scanned: false, encrypted: false, truncated: false };
      default:
        return empty("no text could be read from this file on this PC");
    }
  } catch (err) {
    return empty(`this file couldn't be read (${(err as Error).message.slice(0, 90)})`);
  }
}

function cut(text: string, what: string): ExtractedText {
  const truncated = text.length > FILE_TEXT_MAX_CHARS;
  return {
    text: truncated ? text.slice(0, FILE_TEXT_MAX_CHARS) : text,
    note: truncated ? `${what}, up to the size limit` : what,
    truncated,
    scanned: false,
    encrypted: false,
  };
}

/** "12.4 KB" — how file sizes are written everywhere in the app. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
