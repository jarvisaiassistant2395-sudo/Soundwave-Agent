// ── The shell's log file, and the bundle a person can send ──────────────────
// The desktop app is a Windows GUI: no console, no crash report, nothing to
// look at. This is the piece that makes a failure debuggable, so it is tested
// the way it fails: a directory that cannot be written, a value that cannot be
// serialised, and a key that must not end up in text somebody pastes in public.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sw-diagnostics-"));
}

/** A fresh module instance, since install() is once-per-process by design. */
function freshModule() {
  const file = require.resolve("../src/diagnostics.cjs");
  delete require.cache[file];
  return require("../src/diagnostics.cjs");
}

test("writes JSON lines to the log file, and tail() reads them back", () => {
  const dir = tempDir();
  const d = freshModule();
  try {
    const file = d.install(dir);
    assert.equal(file, path.join(dir, `soundwave-${new Date().toISOString().slice(0, 10)}.log`));

    d.log("info", "[desktop] hello", { port: 47800 });
    d.log("error", "[desktop] it broke", new Error("boom"));

    const tail = d.tail(50);
    // Every line is one JSON object, which is how a support tool reads it back.
    const records = tail.split("\n").map((line) => JSON.parse(line));
    for (const parsed of records) {
      assert.equal(typeof parsed.t, "string");
      assert.equal(parsed.src, "desktop");
    }
    assert.match(records[0].msg, /\[desktop\] hello \{"port":47800\}/);
    assert.match(records[1].msg, /it broke Error: boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prunes logs older than a week and leaves the recent ones", () => {
  const dir = tempDir();
  const d = freshModule();
  try {
    const old = path.join(dir, "soundwave-2026-01-01.log");
    fs.writeFileSync(old, "{}\n");
    const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(old, longAgo / 1000, longAgo / 1000);
    fs.writeFileSync(path.join(dir, "notes.txt"), "not ours");

    d.install(dir);
    assert.equal(fs.existsSync(old), false, "an old log should be gone");
    assert.equal(fs.existsSync(path.join(dir, "notes.txt")), true, "only our own files are pruned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a log that cannot be written never takes the app down with it", () => {
  const d = freshModule();
  const dir = path.join(tempDir(), "nested", "deeper");
  try {
    // The parent exists, so install itself succeeds; then the file is replaced
    // by a directory underneath us — every later append must fail quietly.
    const file = d.install(dir);
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    assert.doesNotThrow(() => d.log("error", "[desktop] this cannot land anywhere"));
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("redacts anything that looks like a key before it can be pasted in public", () => {
  const d = freshModule();
  const text = d.redact(
    "key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345 stripe sk_live_abcdef123456ghijkl and pk_test_abcdefghijklmnop " +
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c " +
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  );
  assert.doesNotMatch(text, /AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345/);
  assert.doesNotMatch(text, /sk_live_abcdef123456ghijkl/);
  assert.doesNotMatch(text, /pk_test_abcdefghijklmnop/);
  assert.doesNotMatch(text, /eyJhbGciOiJIUzI1NiJ9/);
  assert.doesNotMatch(text, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/);
  assert.match(text, /redacted/i);
});

test("the diagnostics bundle carries versions, state and the log — never a key", () => {
  const dir = tempDir();
  const d = freshModule();
  try {
    d.install(dir);
    d.log("info", "[desktop] shell started");
    const app = { getPath: () => dir, getVersion: () => "1.6.6" };
    const text = d.diagnostics({
      app,
      version: "1.6.6",
      edition: "retail",
      extra: { api: { ok: true, store: "json" }, geminiKey: "AIzaSyABCDEFGHIJKLMNOPQRSTUV0123456789" },
    });
    assert.match(text, /Soundwave AI 1\.6\.6 \(retail\)/);
    assert.match(text, /OS /);
    assert.match(text, /--- app state ---/);
    assert.match(text, /"store":"json"/);
    assert.match(text, /--- log \(most recent last\) ---/);
    assert.match(text, /shell started/);
    assert.doesNotMatch(text, /AIzaSyABCDEFGHIJKLMNOPQRSTUV0123456789/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a dead window process is written down and reloaded, not left blank", () => {
  const dir = tempDir();
  const d = freshModule();
  try {
    d.install(dir);
    const handlers = {};
    const reloads = [];
    const shown = [];
    const app = {
      getPath: () => dir,
      on: (name, fn) => {
        handlers[name] = fn;
      },
      exit: (code) => shown.push(code),
    };
    const electron = {
      crashReporter: { start: () => {} },
      dialog: { showErrorBox: () => {} },
    };
    d.installCrashHandlers({ app, electron, version: "1.6.6" });

    const webContents = { isDestroyed: () => false, getURL: () => "http://127.0.0.1:5000/agent", reload: () => reloads.push(1) };
    handlers["render-process-gone"]({}, webContents, { reason: "crashed", exitCode: 5 });
    assert.equal(reloads.length, 1, "a crashed window is reloaded");
    const afterCrash = d
      .tail(20)
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.match(afterCrash.at(-1).msg, /window process gone.*\{"reason":"crashed","exitCode":5/);

    handlers["child-process-gone"]({}, { type: "Utility", reason: "killed", exitCode: 9 });
    const afterChild = d
      .tail(20)
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.match(afterChild.at(-1).msg, /child process gone.*"reason":"killed"/);

    // A window the person closed themselves is not a crash and must not reload.
    d.log("info", "reset");
    handlers["render-process-gone"]({}, { isDestroyed: () => true, getURL: () => "http://127.0.0.1:5000/" }, { reason: "clean-exit" });
    assert.equal(reloads.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an exception in the shell is logged, explained and fatal", () => {
  const dir = tempDir();
  const d = freshModule();
  const before = process.listeners("uncaughtException");
  try {
    d.install(dir);
    const exits = [];
    const boxes = [];
    const app = {
      getPath: () => dir,
      on: () => {},
      exit: (code) => exits.push(code),
    };
    const electron = {
      crashReporter: { start: () => {} },
      dialog: {
        showErrorBox: (title, body) => {
          boxes.push({ title, body });
        },
      },
    };
    d.installCrashHandlers({ app, electron, version: "1.6.6" });

    const handler = process.listeners("uncaughtException").find((fn) => !before.includes(fn));
    assert.ok(handler, "the shell installs an uncaughtException handler");
    handler(new Error("kaboom"));

    assert.deepEqual(exits, [1], "the shell exits rather than running on half-dead");
    assert.equal(boxes.length, 1);
    assert.match(boxes[0].body, /kaboom/);
    assert.match(boxes[0].body, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 20)));
    assert.match(d.tail(20), /kaboom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
