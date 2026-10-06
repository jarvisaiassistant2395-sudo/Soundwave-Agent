// Reading a dropped-in file on this PC: what it is, and the text inside it.
// The fixtures are built here byte by byte — a real (small) PDF with a Flate
// content stream, and real ZIP-based documents — so the readers are tested
// against the actual formats rather than against a mock of them.
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { classifyFile, extractText, humanBytes, mimeFor } from "../src/lib/docText.js";
import { looksLikePdf, pdfText } from "../src/lib/pdfText.js";
import { docxText, epubText, looksLikeZip, pptxText, xlsxText, zipEntries } from "../src/lib/zipText.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A ZIP from `[name, content]` pairs: deflated entries, real central directory. */
function makeZip(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const deflated = zlib.deflateRawSync(raw);
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of raw) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;

    const local = Buffer.alloc(30);
    local.write("PK\u0003\u0004", 0, "latin1");
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.write("PK\u0001\u0002", 0, "latin1");
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.write("PK\u0005\u0006", 0, "latin1");
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** A one-page PDF whose text is `lines`, with a real Flate content stream. */
function makePdf(lines: string[], opts: { hex?: boolean } = {}): Buffer {
  const operators = lines.map((line) => (opts.hex ? `<${Buffer.from(line, "utf8").toString("hex")}> Tj` : `(${line.replace(/([()\\])/g, "\\$1")}) Tj`)).join(" T* ");
  const content = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 700 Td ${operators} ET`, "latin1"));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n${content.toString("latin1")}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const WORD = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
  <w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>
  <w:p><w:r><w:t>Revenue grew 18% &amp; costs fell.</w:t></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;

const SHEET = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>
  <row r="2"><c t="s"><v>2</v></c><c><v>1250</v></c></row>
</sheetData></worksheet>`;

const SLIDES = `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>
  <p:sp><p:txBody><a:p><a:r><a:t>Launch plan</a:t></a:r></a:p><a:p><a:r><a:t>Ship in June</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

const resolve = (name: string, buf: Buffer) => extractText(buf, classifyFile(name, "", buf), name);

describe("what a dropped-in file is", () => {
  it("recognises the kinds by name and by bytes", () => {
    expect(classifyFile("notes.md", "", Buffer.from("# Hi"))).toMatchObject({ kind: "text", reader: "text" });
    expect(classifyFile("data.csv", "", Buffer.from("a,b\n1,2"))).toMatchObject({ kind: "text", reader: "text" });
    expect(classifyFile("photo.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff]))).toMatchObject({ kind: "image", reader: "none", native: true });
    expect(classifyFile("clip.mp4", "", Buffer.from("...."))).toMatchObject({ kind: "video", native: true, reader: "video" });
    expect(classifyFile("song.mp3", "", Buffer.from("...."))).toMatchObject({ kind: "audio", native: true, reader: "audio" });
    // The bytes decide when the name lies: a PNG called notes.txt is a picture.
    expect(classifyFile("notes.txt", "", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))).toMatchObject({ kind: "other" });
    // No extension at all, but plainly text.
    expect(classifyFile("LICENSE", "", Buffer.from("MIT License\n\nCopyright"))).toMatchObject({ kind: "text" });
    expect(mimeFor("report.PDF")).toBe("application/pdf");
  });

  it("knows which files only Gemini can read", () => {
    expect(classifyFile("report.pdf", "", Buffer.from("%PDF-1.4"))).toMatchObject({ reader: "pdf", native: true });
    expect(classifyFile("sheet.xlsx", "", makeZip([["xl/workbook.xml", "<workbook/>"]]))).toMatchObject({ kind: "document", reader: "xlsx", native: false });
  });
});

describe("PDF text", () => {
  it("reads the text layer of a compressed PDF", () => {
    const buf = makePdf(["Quarterly report", "Revenue grew 18% (unaudited)."]);
    expect(looksLikePdf(buf)).toBe(true);
    const read = pdfText(buf);
    expect(read.encrypted).toBe(false);
    expect(read.scanned).toBe(false);
    expect(read.text).toContain("Quarterly report");
    expect(read.text).toContain("Revenue grew 18% (unaudited).");
    // The T* between the two strings is a line break, not a run-on.
    expect(read.text.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("reads a hex-encoded UTF-16 string", () => {
    // The BOM (FEFF) followed by "Café" as UTF-16BE code units.
    const buf = makePdf(["Café — 42 pages of findings"], { hex: true });
    // A hex string without the BOM is read as UTF-8 bytes.
    expect(pdfText(buf).text).toContain("Café — 42 pages of findings");
  });

  it("says so when a PDF is a scan, and when it is encrypted", () => {
    const imageOnly = makePdf([]);
    expect(pdfText(imageOnly).scanned).toBe(true);
    expect(pdfText(imageOnly).text).toBe("");

    const encrypted = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Encrypt 9 0 R >>\n", "latin1"),
      makePdf(["Secret"]),
    ]);
    expect(pdfText(encrypted).encrypted).toBe(true);
    const read = resolve("secret.pdf", encrypted);
    expect(read.text).toBe("");
    expect(read.note).toMatch(/password-protected/);
  });

  it("hands the scanner's verdict through extractText with an honest note", () => {
    const read = resolve("scan.pdf", makePdf([]));
    expect(read.text).toBe("");
    expect(read.scanned).toBe(true);
    expect(read.note).toMatch(/scan/i);
  });

  it("is bounded: a PDF that is mostly junk does not throw", () => {
    const junk = Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.alloc(200_000, 0x7a), Buffer.from("\nstream\nnot really\nexpected\nendstream\n%%EOF")]);
    const read = pdfText(junk);
    expect(read.text).toBe("");
    expect(read.scanned).toBe(true);
  });
});

describe("ZIP-based documents", () => {
  it("reads a ZIP's entries in order and skips what it was not asked for", () => {
    const zip = makeZip([["a.txt", "first"], ["b.bin", "second"]]);
    expect(looksLikeZip(zip)).toBe(true);
    expect(zipEntries(zip, (n) => n.endsWith(".txt")).map((e) => [e.name, e.data.toString()])).toEqual([["a.txt", "first"]]);
    expect(zipEntries(Buffer.from("not a zip"), () => true)).toEqual([]);
  });

  it("reads Word paragraphs and table cells", () => {
    const text = docxText(makeZip([["word/document.xml", WORD]]));
    expect(text).toContain("Quarterly report");
    expect(text).toContain("Revenue grew 18% & costs fell.");
    expect(text).toContain("Region\tSales");
  });

  it("reads spreadsheets with their sheet names and values", () => {
    const zip = makeZip([
      ["xl/workbook.xml", `<workbook><sheets><sheet name="Q3" sheetId="1"/></sheets></workbook>`],
      ["xl/sharedStrings.xml", `<sst><si><t>Region</t></si><si><t>Sales</t></si><si><t>North</t></si></sst>`],
      ["xl/worksheets/sheet1.xml", SHEET],
    ]);
    const text = xlsxText(zip);
    expect(text).toContain("## Q3");
    expect(text).toContain("Region\tSales");
    expect(text).toContain("North\t1250");
  });

  it("reads slides in order and EPUB chapters by spine", () => {
    expect(pptxText(makeZip([["ppt/slides/slide1.xml", SLIDES]]))).toContain("Launch plan");
    const epub = makeZip([
      ["content.opf", `<package><manifest><item id="c1" href="ch1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>`],
      ["ch1.xhtml", `<html><body><h1>Chapter One</h1><p>${"It was a dark and stormy night in the valley. ".repeat(2)}</p></body></html>`],
    ]);
    const text = epubText(epub);
    expect(text).toContain("Chapter One");
    expect(text).toContain("stormy night");
  });

  it("reads a Word file end to end, and reports an empty one", () => {
    const read = resolve("report.docx", makeZip([["word/document.xml", WORD]]));
    expect(read.text).toContain("Revenue grew");
    expect(read.note).toMatch(/document text/);
    const blank = resolve("blank.docx", makeZip([["word/document.xml", "<w:document><w:body/></w:document>"]]));
    expect(blank.text).toBe("");
    expect(blank.note).toMatch(/no readable text/);
  });
});

describe("plain text files", () => {
  it("reads text, code and subtitles as they are", () => {
    expect(resolve("main.py", Buffer.from("def go():\n    return 1\n")).text).toContain("def go()");
    expect(resolve("captions.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHello\n")).text).toContain("Hello");
    expect(resolve("notes.txt", Buffer.from("line one\r\nline two\r\n")).text).toBe("line one\nline two\n");
  });

  it("pretty-prints JSON, and leaves broken JSON alone", () => {
    expect(resolve("data.json", Buffer.from('{"b":1,"a":[2,3]}')).text).toBe('{\n  "b": 1,\n  "a": [\n    2,\n    3\n  ]\n}');
    expect(resolve("broken.json", Buffer.from("{not json")).text).toBe("{not json");
  });

  it("turns an HTML file into headings and text", () => {
    const html = `<html><head><title>Weekly digest</title><style>p{color:red}</style></head><body><h2>Headlines</h2><p>One &amp; two.</p><ul><li>First</li></ul><script>evil()</script></body></html>`;
    const text = resolve("digest.html", Buffer.from(html)).text;
    expect(text).toContain("# Weekly digest");
    expect(text).toContain("## Headlines");
    expect(text).toContain("One & two.");
    expect(text).toContain("- First");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("color:red");
  });

  it("strips RTF control words", () => {
    const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}\f0\fs24 Hello \b world\b0\par Second line\par}`;
    const text = resolve("letter.rtf", Buffer.from(rtf)).text;
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).toContain("Second line");
    expect(text).not.toContain("fonttbl");
  });

  it("says plainly what it could not read", () => {
    // Audio and video have no text to read here — the sound is listened to
    // instead (whisper on this PC, or Gemini when the file goes there).
    const video = resolve("talk.mp4", Buffer.alloc(2048, 7));
    expect(video.text).toBe("");
    expect(video.note).toMatch(/listened to/i);
    const archive = resolve("archive.zip", Buffer.from("PK\u0003\u0004", "latin1"));
    expect(archive.text).toBe("");
    expect(archive.note).toMatch(/couldn't be read|no text/i);
  });
});

describe("file sizes", () => {
  it("writes sizes the way the app writes them", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2048)).toBe("2.0 KB");
    expect(humanBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(humanBytes(2_500_000_000)).toBe("2.3 GB");
  });
});
