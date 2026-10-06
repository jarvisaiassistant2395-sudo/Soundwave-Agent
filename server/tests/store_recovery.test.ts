// ── The store must never quietly eat the person's data ──────────────────────
// store.json is the whole account on a desktop install (there is no database
// there): the sign-in, the projects, the export jobs, the API keys. The way it
// used to fail was silent — an unreadable file was caught, the app started on
// an empty store, and 150 ms later that emptiness was written over the real
// one. These tests are about the three things that replace that:
//
//   1. a write is atomic (tmp → fsync → rename), so a reader never sees half a file,
//   2. an unreadable file is set aside, never overwritten,
//   3. the data comes back from a backup when there is one.
//
// Real files on a real disk in a temp dir — the point is the filesystem.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "../src/lib/store.js";
import { dailyBackup, listBackups, readJsonFile, writeJsonFile } from "../src/lib/jsonFile.js";
import { setConfig } from "./helpers/config.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-store-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A store pointed at this test's own directory (config is read at construct). */
async function storeIn(d: string): Promise<JsonStore> {
  const undo = setConfig("dataDir", d);
  try {
    const store = new JsonStore();
    await store.init();
    return store;
  } finally {
    undo();
  }
}

const user = (email: string) => ({
  email,
  name: "Test Person",
  avatarUrl: null,
  plan: "PRO" as const,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
});

describe("the JSON store's file", () => {
  it("starts fresh when there is nothing there, and says so", async () => {
    const store = await storeIn(dir);
    expect(store.describe().status).toBe("fresh");
    expect(store.describe().lastWriteError).toBeNull();
  });

  it("stamps a version, so a later change has somewhere to migrate from", async () => {
    const store = await storeIn(dir);
    await store.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8"));
    expect(onDisk.version).toBe(1);
  });

  it("keeps what was written, across a restart", async () => {
    const first = await storeIn(dir);
    await first.createUser(user("kept@example.com"));
    await first.flush();

    const second = await storeIn(dir);
    expect((await second.findUserByEmail("kept@example.com"))?.plan).toBe("PRO");
    expect(second.describe().status).toBe("ok");
  });

  it("survives a truncated file: the bytes are kept, the app still runs", async () => {
    const store = await storeIn(dir);
    await store.createUser(user("gone@example.com"));
    await store.flush();

    // A half-written file — the thing a power cut or a hard kill produces.
    const file = path.join(dir, "store.json");
    const whole = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));

    const reopened = await storeIn(dir);
    const health = reopened.describe();
    expect(health.status === "recovered" || health.status === "lost").toBe(true);
    // Whatever happened, the unreadable bytes are somewhere — not deleted.
    expect(health.quarantine).toBeTruthy();
    expect(fs.existsSync(health.quarantine!)).toBe(true);
    expect(fs.readFileSync(health.quarantine!, "utf8")).toContain("gone@example.com");
    // …and the store is usable, not a crash loop.
    await reopened.createUser(user("new@example.com"));
    await reopened.flush();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).users.length).toBeGreaterThan(0);
  });

  it("brings the data back from the daily backup when the live file is unusable", async () => {
    const first = await storeIn(dir);
    await first.createUser(user("recover-me@example.com"));
    await first.flush();

    // A backup as of today, taken from the good file — what a normal launch leaves.
    expect(dailyBackup(path.join(dir, "store.json"))).toBeTruthy();

    // Now the live file is destroyed outright.
    fs.writeFileSync(path.join(dir, "store.json"), "{ this is not json");

    const reopened = await storeIn(dir);
    const health = reopened.describe();
    expect(health.status).toBe("recovered");
    expect(health.recoveredFrom).toBeTruthy();
    // The account came back rather than the person being told they never signed up.
    expect(await reopened.findUserByEmail("recover-me@example.com")).not.toBeNull();
  });

  it("never overwrites the unreadable file, even with no backup to fall back on", async () => {
    const store = await storeIn(dir);
    await store.createUser(user("only-copy@example.com"));
    await store.flush();
    // Remove the backup so the recovery path has nowhere to go.
    for (const b of listBackups(path.join(dir, "store.json"))) fs.rmSync(b, { force: true });
    fs.writeFileSync(path.join(dir, "store.json"), "]]] not json [[[");

    const reopened = await storeIn(dir);
    expect(reopened.describe().status).toBe("lost");
    const quarantined = fs.readdirSync(dir).filter((n) => n.includes(".corrupt-"));
    expect(quarantined.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, quarantined[0]!), "utf8")).toBe("]]] not json [[[");
  });

  it("reports a disk that refuses writes instead of pretending to have saved", async () => {
    const store = await storeIn(dir);
    // A directory where the store file goes: open() will fail every time.
    const file = path.join(dir, "store.json");
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);

    await store.createUser(user("cannot-save@example.com"));
    await store.flush();
    expect(store.describe().lastWriteError).toBeTruthy();
  });

  it("flushes immediately, without waiting out the debounce", async () => {
    const store = await storeIn(dir);
    await store.createUser(user("flushed@example.com"));
    await store.flush();
    expect(fs.readFileSync(path.join(dir, "store.json"), "utf8")).toContain("flushed@example.com");
  });
});

describe("the JSON file helper", () => {
  it("tells missing apart from corrupt", () => {
    const file = path.join(dir, "thing.json");
    expect(readJsonFile(file, () => ({ ok: 1 })).status).toBe("missing");

    fs.writeFileSync(file, "not json at all");
    const read = readJsonFile<{ ok: number }>(file, () => ({ ok: 1 }));
    expect(read.status).toBe("corrupt");
    expect(read.value).toEqual({ ok: 1 });
    expect(read.status === "corrupt" && fs.existsSync(read.quarantine!)).toBe(true);
  });

  it("leaves no half-written file behind and no temp files lying around", () => {
    const file = path.join(dir, "atomic.json");
    writeJsonFile(file, { hello: "world" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ hello: "world" });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);

    // A value that cannot be serialised must leave the previous file intact.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeJsonFile(file, circular)).toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ hello: "world" });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps a week of backups, newest first, and one per day", () => {
    const file = path.join(dir, "kept.json");
    writeJsonFile(file, { n: 1 });
    const first = dailyBackup(file);
    expect(first).toBeTruthy();
    // A second call on the same day does not make a second copy.
    expect(dailyBackup(file)).toBe(first);

    // Seven more days' worth, written by hand (the clock is not ours to move).
    for (let day = 1; day <= 7; day++) {
      fs.writeFileSync(path.join(dir, `kept.backup-2026-09-0${day}.json`), "{}");
    }
    dailyBackup(file, 7);
    const kept = listBackups(file);
    expect(kept.length).toBe(7);
    // Newest first: the recovery path takes the most recent good copy.
    const [newest, next] = kept;
    expect(newest!.endsWith(".json")).toBe(true);
    expect(newest! >= next!).toBe(true);
  });
});
