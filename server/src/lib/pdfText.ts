// ── The text inside a PDF, without a PDF library ─────────────────────────────
// A PDF's text lives in content streams, usually compressed with zlib, inside
// `BT … ET` blocks whose strings are written by `Tj`/`TJ` operators. That is all
// this reads: the text layer. It is enough for the documents people actually
// drop in (reports, articles, contracts, exported notes) because those were
// produced by a word processor, which always writes a text layer.
//
// It is not a PDF renderer and does not pretend to be one: a *scanned* PDF is
// one big image with no text layer at all, and the honest answer for that is
// "there is no text in this file" — which is what `scanned` reports, so the
// caller can send the file to Gemini (which reads pages as images) or say so
// plainly. Same for encrypted PDFs: unreadable, reported as such.
//
// Everything here is pure (buffer in, text out) and bounded (streams, pages and
// characters are capped), so a hostile 900-page PDF cannot eat the server.

import zlib from "node:zlib";

/** How many content streams we will inflate. Reports rarely exceed this. */
export const PDF_MAX_STREAMS = 400;
/** Inflated size of one stream we will accept (a stream that decompresses to
 *  more than this is skipped rather than stored). */
export const PDF_MAX_STREAM_BYTES = 8 * 1024 * 1024;
/** Characters kept from the whole document. */
export const PDF_MAX_CHARS = 400_000;

export interface PdfText {
  text: string;
  /** Compressed content streams that produced text. */
  streams: number;
  /** True when the file is a PDF with no text layer at all (a scan). */
  scanned: boolean;
  /** The file is password-protected (`/Encrypt`) — nothing can be read. */
  encrypted: boolean;
  truncated: boolean;
}

const latin1 = (buf: Buffer) => buf.toString("latin1");

/**
 * Undo PDF string escapes and the encodings a text-layer string can be in.
 *
 * PDFs store text either as PDFDocEncoding-ish single bytes (Windows-1252 in
 * practice, which is what word processors emit) or as UTF-16BE with a BOM. Both
 * are handled; anything else is left as the bytes were written.
 */
export function decodePdfString(raw: string): string {
  if (raw.startsWith("\u00fe\u00ff")) {
    // UTF-16BE with the BOM: pairs of bytes, high first.
    let out = "";
    for (let i = 2; i + 1 < raw.length; i += 2) {
      const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
      if (code) out += String.fromCharCode(code);
    }
    return out;
  }
  const bytes = Buffer.from(raw, "latin1");
  // WinAnsi (cp1252) is a superset of latin-1 in the printable range; the only
  // differences that matter for reading are the 0x80–0x9f punctuation marks.
  const high: Record<number, string> = {
    0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
    0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘",
    0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜",
    0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
  };
  let out = "";
  for (const byte of bytes) {
    if (byte >= 0x80 && byte <= 0x9f) out += high[byte] ?? " ";
    else out += String.fromCharCode(byte);
  }
  return out;
}

/** Every string literal in one content stream, in reading order. */
function stringsIn(content: string): string {
  const pieces: string[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "(") {
      // A literal string: escapes, and balanced ( ) inside.
      let depth = 1;
      let raw = "";
      i += 1;
      while (i < content.length && depth > 0) {
        const c = content[i]!;
        if (c === "\\") {
          const next = content[i + 1] ?? "";
          i += 2;
          switch (next) {
            case "n": raw += "\n"; break;
            case "r": raw += "\r"; break;
            case "t": raw += "\t"; break;
            case "b": raw += "\b"; break;
            case "f": raw += "\f"; break;
            case "(": raw += "("; break;
            case ")": raw += ")"; break;
            case "\\": raw += "\\"; break;
            default:
              // Octal escape (\053) or a plain escaped character.
              if (/[0-7]/.test(next)) {
                let oct = next;
                while (oct.length < 3 && /[0-7]/.test(content[i] ?? "")) oct += content[i++];
                raw += String.fromCharCode(parseInt(oct, 8));
              } else raw += next;
          }
          continue;
        }
        if (c === "(") depth += 1;
        else if (c === ")") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        raw += c;
        i += 1;
      }
      pieces.push(decodePdfString(raw));
      continue;
    }
    if (ch === "<" && content[i + 1] !== "<") {
      // A hex string: <48656c6c6f> (UTF-16BE or bytes, by BOM/length).
      const end = content.indexOf(">", i);
      if (end < 0) break;
      const hex = content.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, "");
      const even = hex.length % 2 ? `${hex}0` : hex;
      const bytes = Buffer.from(even, "hex");
      pieces.push(bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? decodePdfString(bytes.subarray(2).toString("latin1")) : bytes.toString("utf8"));
      i = end + 1;
      continue;
    }
    // A new line on the operators that move the cursor down the page.
    if (ch === "T" && ["Td", "TD", "T*"].includes(content.slice(i, i + 2))) {
      pieces.push("\n");
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') pieces.push("\n");
    i += 1;
  }
  return pieces.join("");
}

/** The inside of every `stream … endstream`, decompressed when it is Flate. */
function contentStreams(pdf: Buffer): string[] {
  const out: string[] = [];
  const body = latin1(pdf);
  let from = 0;
  while (out.length < PDF_MAX_STREAMS) {
    const start = body.indexOf("stream", from);
    if (start < 0) break;
    let i = start + "stream".length;
    // The keyword is followed by CRLF or LF.
    if (body[i] === "\r") i += 1;
    if (body[i] === "\n") i += 1;
    const end = body.indexOf("endstream", i);
    if (end < 0) break;
    from = end + "endstream".length;
    // Trim the EOL that precedes `endstream`.
    let stop = end;
    if (body[stop - 1] === "\n") stop -= 1;
    if (body[stop - 1] === "\r") stop -= 1;
    const raw = pdf.subarray(i, stop);
    // The dictionary right before the stream tells us how it is encoded.
    const dictStart = body.lastIndexOf("<<", start);
    const dict = dictStart >= 0 ? body.slice(dictStart, start) : "";
    if (/\/Filter\s*(\/FlateDecode|\[[^\]]*\/FlateDecode)/.test(dict) && !/\/FlateDecode[^\]]*\/FlateDecode/.test(dict)) {
      try {
        const inflated = zlib.inflateSync(raw, { maxOutputLength: PDF_MAX_STREAM_BYTES });
        out.push(latin1(inflated));
      } catch {
        // Some writers make the /Length wrong or use a raw deflate; try both.
        try {
          out.push(latin1(zlib.inflateRawSync(raw, { maxOutputLength: PDF_MAX_STREAM_BYTES })));
        } catch {
          /* unreadable stream — skip it, the rest of the file still reads */
        }
      }
      continue;
    }
    // Uncompressed content streams are plain text operators.
    out.push(latin1(raw));
  }
  return out;
}

/** True when the buffer starts with a PDF header (`%PDF-`). */
export function looksLikePdf(buf: Buffer): boolean {
  return latin1(buf.subarray(0, 5)) === "%PDF-";
}

/**
 * The text of a PDF. Text is collected from each content stream in file order
 * (which is document order for every writer in practice) and normalised: soft
 * hyphenation at line ends is rejoined, runs of blank space collapse, and lines
 * that are really one sentence are joined back together.
 */
export function pdfText(buf: Buffer): PdfText {
  const body = latin1(buf);
  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(body) || /\/Encrypt\s*<</.test(body);
  if (encrypted) return { text: "", streams: 0, scanned: false, encrypted: true, truncated: false };

  let streams = 0;
  const pages: string[] = [];
  for (const content of contentStreams(buf)) {
    if (!/(^|[\s>])BT[\s<]/.test(content)) continue;
    const text = stringsIn(content);
    if (text.replace(/[\s\0]/g, "").length < 2) continue;
    streams += 1;
    pages.push(text);
    if (pages.join("\n").length > PDF_MAX_CHARS * 1.5) break;
  }

  let text = pages.join("\n\n");
  text = text
    // A line ending in a hyphen was broken mid-word by the layout.
    .replace(/([A-Za-zÀ-ÿ])-\n([a-zà-ÿ])/g, "$1$2")
    // A line break straight after a word and before a lowercase word is a wrap.
    .replace(/([^\n.!?:;])\n(?=[a-zà-ÿ(])/g, "$1 ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const truncated = text.length > PDF_MAX_CHARS;
  if (truncated) text = text.slice(0, PDF_MAX_CHARS);

  // Nothing that looks like words: no text layer (a scan), or only one odd
  // glyph run. Either way it is not text we can hand to the model.
  // A scan has no text at all; a short but real document (a one-line invoice)
  // must not be mistaken for one, so the bar is a handful of characters that
  // the operator scan produced — not a word count.
  const letters = text.replace(/[^A-Za-zÀ-ÿ0-9]/g, "").length;
  const scanned = !text || letters < 8;
  return { text: scanned ? "" : text, streams, scanned, encrypted: false, truncated };
}
