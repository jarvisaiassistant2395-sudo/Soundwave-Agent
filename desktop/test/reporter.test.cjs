// The opt-in reporter (desktop/src/reporter.cjs). Every test here is about the
// two things that could go wrong with a feature like this: sending something
// without consent, and sending something that identifies the person.
//
// The endpoint is a real HTTP server on 127.0.0.1, so "was it sent" means "the
// bytes arrived", not "a mock was called".
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const reporter = require("../src/reporter.cjs");

/** A local collector standing in for the vendor's endpoint. */
function collector(t, { status = 200 } = {}) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        /* recorded as text below */
      }
      bodies.push({ raw, json });
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ url: `http://127.0.0.1:${server.address().port}/report`, bodies });
    });
  });
}

/** A port that nothing is listening on: the send fails, the queue keeps it. */
function deadEndpoint() {
  const server = http.createServer(() => undefined);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(`http://127.0.0.1:${port}/report`));
    });
  });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-reports-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("only a real http(s) address is an endpoint", () => {
  assert.equal(reporter.isEndpoint("https://reports.example.com/soundwave"), true);
  assert.equal(reporter.isEndpoint("http://127.0.0.1:8080/x"), true);
  assert.equal(reporter.isEndpoint("file:///etc/passwd"), false);
  assert.equal(reporter.isEndpoint("javascript:alert(1)"), false);
  assert.equal(reporter.isEndpoint(""), false);
  assert.equal(reporter.isEndpoint("not a url"), false);
});

test("the endpoint comes from the environment or a config file, never a guess", (t) => {
  const appRoot = tempDir(t);
  const userData = tempDir(t);

  assert.deepEqual(reporter.loadReportingConfig(appRoot, userData, {}), { url: "", source: null });

  fs.mkdirSync(path.join(appRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "config", "reporting.json"), JSON.stringify({ url: "https://baked.example.com/r" }));
  assert.deepEqual(reporter.loadReportingConfig(appRoot, userData, {}), {
    url: "https://baked.example.com/r",
    source: path.join(appRoot, "config", "reporting.json"),
  });

  // The person's own copy wins over the baked one…
  fs.writeFileSync(path.join(userData, "reporting.json"), JSON.stringify({ url: "https://mine.example.com/r" }));
  assert.equal(reporter.loadReportingConfig(appRoot, userData, {}).url, "https://mine.example.com/r");
  // …and the environment wins over both.
  assert.equal(
    reporter.loadReportingConfig(appRoot, userData, { SOUNDWAVE_REPORT_URL: "https://env.example.com/r" }).url,
    "https://env.example.com/r",
  );

  // A config file with a nonsense url is ignored rather than throwing.
  fs.writeFileSync(path.join(userData, "reporting.json"), "not json at all");
  assert.equal(reporter.loadReportingConfig(appRoot, userData, {}).url, "https://baked.example.com/r");
});

test("with the switches off, nothing is sent and nothing is queued", async (t) => {
  const { url, bodies } = await collector(t);
  const queueDir = tempDir(t);
  reporter.reset();
  reporter.configure({ url, crashReports: false, startPing: false, queueDir, version: "1.7.0", edition: "retail" });

  assert.equal(await reporter.reportCrash(new Error("should not leave this machine")), false);
  assert.equal(await reporter.reportStart(), false);
  assert.equal(bodies.length, 0, "the endpoint heard nothing");
  assert.deepEqual(reporter.pendingFiles(), [], "and nothing was written down");
});

test("a crash report carries the error and the versions, and the queue is emptied once it lands", async (t) => {
  const { url, bodies } = await collector(t);
  const queueDir = tempDir(t);
  reporter.reset();
  reporter.configure({ url, crashReports: true, startPing: false, queueDir, version: "1.7.0", edition: "retail" });

  const ok = await reporter.reportCrash(new Error("the renderer died mid-render"), { kind: "uncaughtException" });

  assert.equal(ok, true);
  assert.equal(bodies.length, 1);
  const body = bodies[0].json;
  assert.equal(body.kind, "crash");
  assert.equal(body.version, "1.7.0");
  assert.equal(body.edition, "retail");
  assert.equal(body.platform, process.platform);
  assert.equal(body.error.message, "the renderer died mid-render");
  assert.equal(body.context.kind, "uncaughtException");
  assert.ok(!("id" in body), "no install id: two reports cannot be tied to one person");
  assert.deepEqual(reporter.pendingFiles(), [], "a delivered report is not kept");
});

test("a crash report carries the log tail — that is most of its value", async (t) => {
  const { url, bodies } = await collector(t);
  const queueDir = tempDir(t);
  const logDir = tempDir(t);
  const diagnostics = require("../src/diagnostics.cjs");
  diagnostics.install(logDir);
  diagnostics.log("info", "[test] the last thing that happened before the crash");

  reporter.reset();
  reporter.configure({ url, crashReports: true, queueDir, version: "1.7.0" });
  await reporter.reportCrash(new Error("and then it stopped"));

  assert.equal(bodies.length, 1);
  assert.match(bodies[0].json.log, /the last thing that happened before the crash/);
});

test("secrets and the person's own name never leave", async (t) => {
  const { url, bodies } = await collector(t);
  const queueDir = tempDir(t);
  reporter.reset();
  reporter.configure({ url, crashReports: true, queueDir, version: "1.7.0" });

  const error = new Error(
    "failed for C:\\Users\\Strahinja\\AppData\\Roaming\\soundwave\\store.json with key AIzaSyA1234567890abcdefghijklmnop " +
      "and sk_live_abcdefgh12345678 at /home/strahinja/soundwave/store.json — mail strahinja@example.com",
  );
  await reporter.reportCrash(error, {
    log: "opened C:\\Users\\Strahinja\\Videos\\take.mp4\ntoken eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij",
  });

  assert.equal(bodies.length, 1);
  const raw = bodies[0].raw;
  for (const secret of ["Strahinja", "strahinja@example.com", "AIzaSyA1234567890abcdefghijklmnop", "sk_live_abcdefgh12345678"]) {
    assert.ok(!raw.includes(secret), `the report must not contain ${secret}`);
  }
  assert.match(raw, /<user>/);
  assert.match(raw, /<email>/);
  assert.match(raw, /\(redacted/);
});

test("moving a switch leaves the endpoint alone", async (t) => {
  const { url, bodies } = await collector(t);
  reporter.reset();
  reporter.configure({ url, crashReports: true, startPing: false, queueDir: tempDir(t), version: "1.7.0" });
  // The Settings page sends one switch at a time; the endpoint has to survive.
  reporter.configure({ crashReports: true });
  assert.equal(reporter.state().configured, true, "the endpoint is still there");
  assert.equal(await reporter.reportCrash(new Error("still deliverable")), true);
  assert.equal(bodies.length, 1);
  // An explicit empty string is how a caller clears it.
  reporter.configure({ url: "" });
  assert.equal(reporter.state().configured, false);
});

test("a crash loop is one report, not one per crash", async (t) => {
  const { url, bodies } = await collector(t);
  const queueDir = tempDir(t);
  reporter.reset();
  reporter.configure({ url, crashReports: true, queueDir, version: "1.7.0" });

  const make = () => new Error("the same crash every frame");
  assert.equal(await reporter.reportCrash(make()), true);
  assert.equal(await reporter.reportCrash(make()), false, "the second identical crash is dropped");
  assert.equal(await reporter.reportCrash(make()), false);
  assert.equal(bodies.length, 1);
});

test("a report that could not be sent waits for the next launch", async (t) => {
  const { url, bodies } = await collector(t);
  const dead = await deadEndpoint();
  const queueDir = tempDir(t);
  reporter.reset();

  // This run: the endpoint is down (or the exit beats the request).
  reporter.configure({ url: dead, crashReports: true, queueDir, version: "1.7.0" });
  assert.equal(await reporter.reportCrash(new Error("delivered on the next start")), false);
  assert.equal(reporter.pendingFiles().length, 1, "the report is on disk, waiting");

  // The next launch: same consent, a working endpoint.
  reporter.configure({ url, crashReports: true, queueDir, version: "1.7.0" });
  assert.equal(await reporter.flushPending(), 1);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].json.error.message, "delivered on the next start");
  assert.deepEqual(reporter.pendingFiles(), [], "and the queue is empty again");
});

test("turning crash reports off throws away what was waiting", async (t) => {
  const { url, bodies } = await collector(t);
  const dead = await deadEndpoint();
  const queueDir = tempDir(t);
  reporter.reset();

  reporter.configure({ url: dead, crashReports: true, queueDir, version: "1.7.0" });
  await reporter.reportCrash(new Error("should never be sent"));
  assert.equal(reporter.pendingFiles().length, 1);

  reporter.configure({ url, crashReports: false, queueDir });

  assert.deepEqual(reporter.pendingFiles(), [], "off means gone, not waiting");
  assert.equal(await reporter.flushPending(), 0);
  assert.equal(bodies.length, 0);
});

test("the start ping says nothing about the person", async (t) => {
  const { url, bodies } = await collector(t);
  reporter.reset();
  reporter.configure({ url, startPing: true, crashReports: false, queueDir: tempDir(t), version: "1.7.0", edition: "retail" });

  assert.equal(await reporter.reportStart(), true);
  assert.equal(bodies.length, 1);
  const body = bodies[0].json;
  assert.equal(body.kind, "start");
  assert.equal(body.version, "1.7.0");
  assert.ok(!("error" in body) && !("id" in body) && !("diagnostics" in body));
  assert.ok(!bodies[0].raw.includes(os.hostname()), "no machine name");
  const username = os.userInfo().username;
  if (username && username.length > 3) assert.ok(!bodies[0].raw.includes(username), "no account name");
});

test("sending diagnostics by hand needs no switch — the press is the consent", async (t) => {
  const { url, bodies } = await collector(t);
  reporter.reset();
  reporter.configure({ url, crashReports: false, startPing: false, queueDir: tempDir(t), version: "1.7.0" });

  assert.equal(await reporter.reportDiagnostics("Soundwave AI 1.7.0\n--- log ---\nall quiet"), true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].json.kind, "diagnostics");
  assert.match(bodies[0].json.diagnostics, /all quiet/);
});

test("no endpoint, a dead endpoint or a bad one: never throws, never hangs", async (t) => {
  // No endpoint at all.
  reporter.configure({ url: "", crashReports: true, queueDir: tempDir(t) });
  assert.equal(await reporter.reportDiagnostics("x"), false);
  assert.equal(await reporter.reportCrash(new Error("x")), false);
  assert.equal(reporter.state().configured, false);

  // A nonsense endpoint is refused at configure time rather than at send time.
  reporter.configure({ url: "file:///etc/passwd", crashReports: true, queueDir: tempDir(t) });
  assert.equal(reporter.state().configured, false);
  assert.equal(await reporter.reportDiagnostics("x"), false);

  // A refused connection is a false, not an exception.
  const dead = await deadEndpoint();
  reporter.configure({ url: dead, crashReports: false, startPing: false, queueDir: tempDir(t) });
  assert.equal(await reporter.reportDiagnostics("x"), false);
  assert.equal(reporter.state().sent.failed >= 1, true, "the failure is counted, and logged as one line");
});

test("the queue does not grow without limit", async (t) => {
  const dead = await deadEndpoint();
  const queueDir = tempDir(t);
  reporter.reset();
  reporter.configure({ url: dead, crashReports: true, queueDir, version: "1.7.0" });

  for (let i = 0; i < 8; i += 1) await reporter.reportCrash(new Error(`crash number ${i}`));

  assert.equal(reporter.pendingFiles().length <= 5, true, `a crash loop must not fill the disk (found ${reporter.pendingFiles().length})`);
});
