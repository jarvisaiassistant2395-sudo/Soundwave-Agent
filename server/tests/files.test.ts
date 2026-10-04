// ── Reading a file or a folder the person pointed at ────────────────────────
// Real paths on a real disk: a text file comes back whole (and says when it was
// cut), a folder lists, a binary refuses, a missing path says exactly that, and
// a path more than a year of walking away from home isn't followed nowhere.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandPath, listFolderAt, readFileAt, readPath } from "../src/lib/files.js";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-files-"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\nline three\n");
  fs.writeFileSync(path.join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  fs.mkdirSync(path.join(dir, "Downloads"));
  fs.writeFileSync(path.join(dir, "Downloads", "clip.mp4"), Buffer.alloc(2048, 1));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("expandPath", () => {
  it("understands ~ and quotes, and leaves real paths alone", () => {
    expect(expandPath("~")).toBe(os.homedir());
    expect(expandPath("~/notes.txt")).toBe(path.join(os.homedir(), "notes.txt"));
    expect(expandPath('"C:\\Users\\me\\notes.txt"')).toBe(path.resolve("C:\\Users\\me\\notes.txt"));
    expect(expandPath("")).toBe("");
  });
});

describe("reading a file", () => {
  it("gives back the words, with size and line count", () => {
    const result = readFileAt(path.join(dir, "notes.txt"));
    if (!result.ok) throw new Error(result.reason);
    expect(result.kind).toBe("file");
    expect(result.text).toBe("line one\nline two\nline three\n");
    expect(result.lines).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.name).toBe("notes.txt");
  });

  it("cuts a long file and says it was cut", () => {
    const long = readFileAt(path.join(dir, "notes.txt"), 8);
    if (!long.ok) throw new Error(long.reason);
    expect(long.text).toBe("line one");
    expect(long.truncated).toBe(true);
    expect(long.bytes).toBe(29); // the real size, not the part that was read
  });

  it("refuses a binary by name instead of returning noise", () => {
    const result = readFileAt(path.join(dir, "shot.png"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should refuse");
    expect(result.reason).toMatch(/binary file/i);
  });

  it("says there's no file there when the path is wrong", () => {
    const result = readFileAt(path.join(dir, "nope.txt"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should fail");
    expect(result.reason).toMatch(/no file at/i);
  });

  it("points a folder at the listing instead", () => {
    const result = readFileAt(path.join(dir, "Downloads"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should fail");
    expect(result.reason).toMatch(/is a folder, not a file/i);
  });
});

describe("listing a folder", () => {
  it("shows folders first, with sizes on files", () => {
    const listing = listFolderAt(dir);
    if (!listing.ok) throw new Error(listing.reason);
    const names = listing.entries.map((e) => e.name);
    expect(names[0]).toBe("Downloads");
    expect(names).toContain("notes.txt");
    const clip = listing.entries.find((e) => e.name === "notes.txt");
    expect(clip?.kind).toBe("file");
    expect(clip?.bytes).toBe(29);
    expect(clip?.modified).toMatch(/^\d{4}-/);
  });

  it("says there's no folder there when the path is wrong", () => {
    const listing = listFolderAt(path.join(dir, "nothing-here"));
    expect(listing.ok).toBe(false);
    if (listing.ok) throw new Error("should fail");
    expect(listing.reason).toMatch(/no folder at/i);
  });
});

describe("readPath — one entry point for both", () => {
  it("follows a file, a folder and a miss", () => {
    const file = readPath(path.join(dir, "notes.txt"));
    expect(file.ok && file.kind).toBe("file");
    const folder = readPath(path.join(dir, "Downloads"));
    expect(folder.ok && folder.kind).toBe("folder");
    const miss = readPath(path.join(dir, "ghost.txt"));
    expect(miss.ok).toBe(false);
  });

  it("asks which one when the path is empty", () => {
    const empty = readPath("   ");
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("should fail");
    expect(empty.reason).toMatch(/full path/i);
  });
});
