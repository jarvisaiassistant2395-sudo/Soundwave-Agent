// ── Taking your data out, and putting it back ───────────────────────────────
// The desktop app holds someone's memory, drafts, posting schedule and channel
// plans. This is the test for the thing that makes that survivable: an export
// that does not carry secrets, and a restore that cannot be talked into
// writing outside the data folder or over the only copy of anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfig } from "./helpers/config.js";

const { BACKUP_VERSION, MANIFEST_NAME, RestoreError, exportData, restoreData, scrubSecrets } = await import(
  "../src/lib/backup.js"
);

let dir: string;
let undo: (() => void) | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-backup-"));
  undo = setConfig("dataDir", dir);
});

afterEach(() => {
  undo?.();
  undo = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, value: unknown) => {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

describe("scrubbing secrets", () => {
  it("takes the value out of anything named like a credential", () => {
    const { value, removed } = scrubSecrets({
      geminiApiKey: "AIza-REAL",
      nested: { refreshToken: "1//REAL", keepme: "fine" },
      list: [{ password: "hunter2" }],
    });
    const text = JSON.stringify(value);
    expect(text).not.toContain("AIza-REAL");
    expect(text).not.toContain("1//REAL");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("fine");
    expect(removed).toEqual(["geminiApiKey", "nested.refreshToken", "list[0].password"]);
  });

  it("names the path of everything it removed, so nothing disappears silently", () => {
    const { removed } = scrubSecrets({ a: { b: { pairingKey: "x" } } });
    expect(removed).toEqual(["a.b.pairingKey"]);
  });
});

describe("exporting", () => {
  it("writes a zip with a readable manifest and the data files", () => {
    write("store.json", { users: [{ id: "u1", email: "person@example.com" }] });
    write("brain.json", { geminiApiKey: "AIza-SECRET", model: "gemini-2.5-pro" });
    fs.mkdirSync(path.join(dir, "voice-clips"), { recursive: true });
    fs.writeFileSync(path.join(dir, "voice-clips", "ref.wav"), Buffer.from([1, 2, 3, 4]));

    const result = exportData();
    const entries = unzipSync(new Uint8Array(result.data));

    expect(result.files).toContain("store.json");
    expect(result.files).toContain("brain.json");
    expect(result.files).toContain("voice-clips/ref.wav");

    const manifest = JSON.parse(strFromU8(entries[MANIFEST_NAME]!));
    expect(manifest.kind).toBe("soundwave-backup");
    expect(manifest.version).toBe(BACKUP_VERSION);
    expect(manifest.redacted).toContain("brain.geminiApiKey");
  });

  it("does not put a single secret in the archive", () => {
    write("brain.json", { geminiApiKey: "AIza-SUPER-SECRET-VALUE", model: "x" });
    write("companion.json", { pairingKey: "PAIR-SECRET-VALUE", deviceName: "phone" });
    write("store.json", { sessions: [{ id: "s1", refreshToken: "REFRESH-SECRET-VALUE" }] });

    const archive = exportData().data;
    const asText = strFromU8(archive);
    for (const secret of ["AIza-SUPER-SECRET-VALUE", "PAIR-SECRET-VALUE", "REFRESH-SECRET-VALUE"]) {
      expect(archive.includes(Buffer.from(secret)), `the archive still contains ${secret}`).toBe(false);
      expect(asText).not.toContain(secret);
    }
    // …and the archive is still a readable zip afterwards.
    const entries = unzipSync(new Uint8Array(archive));
    expect(JSON.parse(strFromU8(entries["brain.json"]!)).model).toBe("x");
  });

  it("keeps binary files byte for byte", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
    fs.writeFileSync(path.join(dir, "projects", "clip.mp4"), bytes);

    const entries = unzipSync(new Uint8Array(exportData().data));
    expect(Buffer.from(entries["projects/clip.mp4"]!)).toEqual(bytes);
  });

  it("leaves out temp files and quarantined corrupt files", () => {
    write("store.json", { ok: true });
    write("store.json.1234.tmp", { half: "written" });
    write("store.json.corrupt-2026-01-01T00-00-00-000Z", "not json");

    const files = exportData().files;
    expect(files).toContain("store.json");
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(files.some((f) => f.includes(".corrupt-"))).toBe(false);
  });
});

describe("restoring", () => {
  it("round-trips: what was exported comes back", () => {
    write("store.json", { users: [{ id: "u1", email: "person@example.com" }] });
    write("brand.json", { voice: "en-US-AriaNeural" });
    const archive = exportData().data;

    // Someone starts fresh (or on a new PC).
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const result = restoreData(archive);
    expect(result.restored).toContain("store.json");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8"))).toEqual({
      users: [{ id: "u1", email: "person@example.com" }],
    });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8"))).toEqual({ voice: "en-US-AriaNeural" });
  });

  it("moves the old data aside instead of deleting it", () => {
    write("store.json", { generation: "new" });
    const archive = exportData().data;

    // Now the file on disk changes, and the person restores the older export.
    write("store.json", { generation: "newer" });
    const result = restoreData(archive);

    expect(result.movedAside).toBeTruthy();
    const moved = JSON.parse(fs.readFileSync(path.join(result.movedAside!, "store.json"), "utf8"));
    expect(moved).toEqual({ generation: "newer" });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8"))).toEqual({ generation: "new" });
  });

  it("refuses a file that is not a zip at all, and changes nothing", () => {
    write("store.json", { keep: "me" });
    expect(() => restoreData(Buffer.from("this is a text file, not a backup"))).toThrow(RestoreError);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8"))).toEqual({ keep: "me" });
  });

  it("refuses a zip that is not ours", () => {
    const notOurs = Buffer.from(zipSync({ "holiday.jpg": strToU8("photo") }));
    expect(() => restoreData(notOurs)).toThrow(/no Soundwave manifest/i);
  });

  it("refuses a backup from a newer version of the app", () => {
    const future = Buffer.from(
      zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify({ kind: "soundwave-backup", version: BACKUP_VERSION + 5 })) }),
    );
    expect(() => restoreData(future)).toThrow(/newer version/i);
  });

  it("refuses an archive that tries to write outside the data folder", () => {
    // The attack a hand-edited archive would try. zipSync will not create
    // "../" names itself, so the entry is built by hand.
    const evil = Buffer.from(
      zipSync({
        [MANIFEST_NAME]: strToU8(JSON.stringify({ kind: "soundwave-backup", version: 1 })),
        "../escaped.json": strToU8("{}"),
      }),
    );
    expect(() => restoreData(evil)).toThrow(/not a plain file name|outside the data folder/i);
    expect(fs.existsSync(path.join(path.dirname(dir), "escaped.json"))).toBe(false);
  });

  it("refuses an absolute path entry too", () => {
    const evil = Buffer.from(
      zipSync({
        [MANIFEST_NAME]: strToU8(JSON.stringify({ kind: "soundwave-backup", version: 1 })),
        "/tmp/soundwave-escaped.json": strToU8("{}"),
      }),
    );
    expect(() => restoreData(evil)).toThrow(RestoreError);
  });
});
