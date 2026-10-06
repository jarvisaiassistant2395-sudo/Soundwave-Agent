// ── What is inside a .docx / .xlsx / .pptx / .epub ───────────────────────────
// All four are ZIP archives with XML inside. Reading them needs no dependency:
// the central directory at the end of the file lists every entry, and an entry
// is either stored as-is or deflated — and Node ships inflateRaw. So a Word
// document becomes its paragraphs, a spreadsheet its rows, a deck its slides and
// a book its chapters, with nothing installed.
//
// Bounded on purpose: entry count, total inflated size and per-entry size are all
// capped, so a "document" that unzips to ten gigabytes stops before it starts.

import zlib from "node:zlib";

export const ZIP_MAX_ENTRIES = 2_000;
export const ZIP_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const ZIP_MAX_TOTAL_BYTES = 48 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** True when the buffer starts with a ZIP local-file header (`PK\x03\x04`). */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length > 4 && buf.toString("latin1", 0, 4) === "PK\u0003\u0004";
}

/**
 * The entries of a ZIP whose names pass `wanted`, in archive order. Reads the
 * central directory (authoritative, handles data descriptors) rather than
 * walking local headers.
 */
export function zipEntries(buf: Buffer, wanted: (name: string) => boolean): ZipEntry[] {
  // Find the End Of Central Directory record: the last "PK\x05\x06" in the file.
  const eocd = buf.lastIndexOf(Buffer.from("PK\u0005\u0006", "latin1"));
  if (eocd < 0 || eocd + 22 > buf.length) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  let totalBytes = 0;
  for (let i = 0; i < Math.min(count, ZIP_MAX_ENTRIES); i += 1) {
    if (offset + 46 > buf.length) break;
    if (buf.toString("latin1", offset, offset + 4) !== "PK\u0001\u0002") break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name) || compressedSize > ZIP_MAX_ENTRY_BYTES || totalBytes + compressedSize > ZIP_MAX_TOTAL_BYTES) continue;
    if (localOffset + 30 > buf.length) continue;
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const slice = buf.subarray(dataStart, dataStart + compressedSize);
    if (slice.length < compressedSize) continue;
    try {
      const data = method === 0 ? Buffer.from(slice) : zlib.inflateRawSync(slice, { maxOutputLength: ZIP_MAX_ENTRY_BYTES });
      totalBytes += data.length;
      out.push({ name, data });
    } catch {
      /* a truncated or oddly-encoded entry: the rest of the archive still reads */
    }
  }
  return out;
}

/** Strip tags, decode the five entities that matter, and tidy whitespace. */
function xmlText(xml: string): string {
  return xml
    .replace(/<w:p\b[^>]*\/>/g, "\n")
    .replace(/<w:p\b[^>]*>/g, "\n")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/\n\t/g, "\t")
    .replace(/\t\n/g, "\t")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Word: every paragraph, in document order. */
export function docxText(buf: Buffer): string {
  const parts = zipEntries(buf, (n) => n === "word/document.xml" || /^word\/(header|footer)\d*\.xml$/.test(n) || n === "word/footnotes.xml");
  const document = parts.find((p) => p.name === "word/document.xml");
  if (!document) return "";
  const headers = parts.filter((p) => p.name !== "word/document.xml").map((p) => xmlText(p.data.toString("utf8")));
  const body = xmlText(document.data.toString("utf8"));
  return [body, ...headers.filter(Boolean)].filter(Boolean).join("\n\n");
}

/** Excel: the shared strings, then each sheet's rows as tab-separated values. */
export function xlsxText(buf: Buffer): string {
  const parts = zipEntries(buf, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n) || n === "xl/workbook.xml");
  const workbook = parts.find((p) => p.name === "xl/workbook.xml");
  const shared: string[] = [];
  const sharedXml = parts.find((p) => p.name === "xl/sharedStrings.xml");
  if (sharedXml) {
    for (const match of sharedXml.data.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText(match[1]!));
  }
  const sheetNames = workbook ? [...workbook.data.toString("utf8").matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1]!) : [];
  const sheets = parts.filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const out: string[] = [];
  sheets.forEach((sheet, index) => {
    const rows: string[] = [];
    const xml = sheet.data.toString("utf8");
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const isShared = /\bt="s"/.test(cell[1]!);
        const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2]!)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2]!)?.[1] ?? "";
        cells.push(isShared ? (shared[Number(value)] ?? "") : xmlText(value));
      }
      if (cells.some((c) => c.trim())) rows.push(cells.join("\t"));
    }
    if (!rows.length) return;
    out.push(`## ${sheetNames[index] ?? sheet.name.replace("xl/worksheets/", "").replace(".xml", "")}\n${rows.join("\n")}`);
  });
  return out.join("\n\n");
}

/** PowerPoint: each slide's text, one slide after another. */
export function pptxText(buf: Buffer): string {
  const slides = zipEntries(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return slides
    .map((slide, index) => {
      const runs = [...slide.data.toString("utf8").matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]!.trim()).filter(Boolean);
      if (!runs.length) return "";
      return `## Slide ${index + 1}\n${runs.join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

/** EPUB: the spine's XHTML chapters, tags stripped (a real book, in order). */
export function epubText(buf: Buffer): string {
  const parts = zipEntries(buf, (n) => /\.x?html?$/i.test(n) || n === "content.opf");
  const opf = parts.find((p) => p.name === "content.opf");
  let order = parts.filter((p) => /\.x?html?$/i.test(p.name)).map((p) => p.name);
  if (opf) {
    const manifest = new Map<string, string>();
    for (const item of opf.data.toString("utf8").matchAll(/<item\b[^>]*>/g)) {
      const id = /\bid="([^"]+)"/.exec(item[0])?.[1];
      const href = /\bhref="([^"]+)"/.exec(item[0])?.[1];
      if (id && href) manifest.set(id, href.split("/").pop()!);
    }
    const spine = [...opf.data.toString("utf8").matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => manifest.get(m[1]!)).filter((n): n is string => Boolean(n));
    if (spine.length) order = spine;
  }
  const byName = new Map(parts.map((p) => [p.name.split("/").pop()!, p.data.toString("utf8")]));
  return order
    .map((name) => byName.get(name.split("/").pop()!))
    .filter((html): html is string => Boolean(html))
    .map((html) => xmlText(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")))
    .filter((text) => text.length > 40)
    .join("\n\n");
}
