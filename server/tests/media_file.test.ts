import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { isReadableMediaFile } from "../src/lib/mediaFile.js";

function box(type: string, body: Buffer): Buffer {
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32BE(8 + body.length, 0);
  b.write(type, 4, "ascii");
  body.copy(b, 8);
  return b;
}

const dir = mkdtempSync(path.join(os.tmpdir(), "sw-mediafile-"));
function write(name: string, data: Buffer): string {
  const p = path.join(dir, name);
  writeFileSync(p, data);
  return p;
}

describe("isReadableMediaFile", () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects missing files", () => {
    expect(isReadableMediaFile(path.join(dir, "nope.mp4"))).toBe(false);
  });

  it("rejects tiny files", () => {
    const p = write("tiny.mp4", Buffer.from("abc"));
    expect(isReadableMediaFile(p)).toBe(false);
  });

  it("rejects garbage bytes with an mp4 extension", () => {
    const p = write("garbage.mp4", Buffer.alloc(4096, 0x7f));
    expect(isReadableMediaFile(p)).toBe(false);
  });

  it("accepts a minimal well-formed ftyp+moov mp4", () => {
    const ftyp = box("ftyp", Buffer.from("isomabcdisom"));
    const mvhd = box("mvhd", Buffer.alloc(1000, 0));
    const moov = box("moov", mvhd);
    const p = write("good.mp4", Buffer.concat([ftyp, moov]));
    expect(isReadableMediaFile(p)).toBe(true);
  });

  it("rejects an mp4 whose mdat claims to extend past EOF (truncated file)", () => {
    const ftyp = box("ftyp", Buffer.from("isomabcdisom"));
    const mdat = Buffer.alloc(8);
    mdat.writeUInt32BE(10_000_000, 0); // size claims 10 MB but the file ends here
    mdat.write("mdat", 4, "ascii");
    const p = write("truncated.mp4", Buffer.concat([ftyp, mdat]));
    expect(isReadableMediaFile(p)).toBe(false);
  });

  it("accepts EBML/webm magic", () => {
    const buf = Buffer.alloc(1200, 0);
    buf.writeUInt32BE(0x1a45dfa3, 0);
    const p = write("good.webm", buf);
    expect(isReadableMediaFile(p)).toBe(true);
    const bad = write("bad.webm", Buffer.alloc(1200, 0x7f));
    expect(isReadableMediaFile(bad)).toBe(false);
  });
});
