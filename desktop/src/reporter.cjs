// ── Opt-in reports: crashes and a version ping ──────────────────────────────
// Soundwave's promise is that someone's memory, drafts and recordings stay on
// their own PC, and this module exists inside that promise, not around it:
//
//   * nothing is sent unless the person turned it on in Settings → Voice &
//     Desktop, and both switches ship off;
//   * a report is versions, the error, and the log tail — scrubbed. No keys, no
//     file contents, no documents, and the person's own name is taken out of
//     the paths (`C:\Users\Strahinja\…` becomes `C:\Users\<user>\…`);
//   * there is no install id, so two reports cannot be tied to one person;
//   * the endpoint is the vendor's, set at build time (or by the person's own
//     `reporting.json`). With no endpoint there is nowhere to send, and the
//     switches say so instead of pretending.
//
// The crash path needs care: the shell exits immediately after handling one, so
// a request in flight will often be cut off. Every report is therefore written
// to `<userData>/reports/` *synchronously* first and deleted once the send
// succeeds — a report that did not make it out is sent on the next launch.
// Turning the switch off deletes whatever is still queued.
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { log, redactText, tail } = require("./diagnostics.cjs");

const TIMEOUT_MS = 6000;
/** Queued reports kept for the next launch. Small on purpose. */
const MAX_QUEUE = 5;
const MAX_TAIL_LINES = 200;
const MAX_FIELD = 20000;

const PRODUCT = "Soundwave AI";

let config = {
  url: "",
  crashReports: false,
  startPing: false,
  version: "",
  edition: "",
  queueDir: "",
  product: PRODUCT,
};

/** Counts for the Settings page and the log ("sent: 3"). */
const counters = { crash: 0, start: 0, diagnostics: 0, failed: 0, queued: 0 };
/** Crash fingerprints already handled in this run: a crash loop is one report. */
const seen = new Set();

/**
 * The vendor's endpoint. Two places, first one wins — the same shape as the
 * baked Google client (desktop/src/server-env.cjs):
 *   <userDataDir>/reporting.json     the person's own override
 *   <appRoot>/config/reporting.json  what the build shipped (gitignored)
 * `SOUNDWAVE_REPORT_URL` from the environment beats both, which is what makes
 * this testable and lets a support build point somewhere else without a rebuild.
 */
function loadReportingConfig(appRoot, userDataDir = null, env = process.env) {
  const fromEnv = String(env?.SOUNDWAVE_REPORT_URL ?? "").trim();
  if (isEndpoint(fromEnv)) return { url: fromEnv, source: "environment" };
  const places = [
    userDataDir && path.join(userDataDir, "reporting.json"),
    appRoot && path.join(appRoot, "config", "reporting.json"),
  ].filter(Boolean);
  for (const file of places) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const url = String(raw?.url ?? "").trim();
      if (isEndpoint(url)) return { url, source: file };
    } catch {
      /* not here (or not usable) — try the next place */
    }
  }
  return { url: "", source: null };
}

/** http(s) only, and sane. A file:, data: or javascript: endpoint is a bug. */
function isEndpoint(value) {
  try {
    const parsed = new URL(String(value));
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Point the reporter at an endpoint and set the two consents. Called at startup
 * and again whenever the switches move. Turning crash reports off discards
 * anything queued but not yet sent — "off" has to mean the reports are gone,
 * not waiting.
 */
function configure(next = {}) {
  const before = config;
  config = {
    // `undefined` keeps whatever was configured — the Settings page moves one
    // switch at a time and must not knock out the endpoint doing it. An empty
    // string clears it on purpose.
    url: next.url === undefined ? before.url : isEndpoint(next.url) ? String(next.url) : "",
    crashReports: next.crashReports === true,
    startPing: next.startPing === true,
    version: String(next.version ?? before.version ?? ""),
    edition: String(next.edition ?? before.edition ?? ""),
    queueDir: String(next.queueDir ?? before.queueDir ?? ""),
    product: String(next.product ?? before.product ?? PRODUCT),
  };
  // "Off" has to empty the queue even if the queue itself just moved.
  if (!config.crashReports && before.crashReports) clearPending(before.queueDir);
  return state();
}

function state() {
  return {
    configured: Boolean(config.url),
    crashReports: config.crashReports,
    startPing: config.startPing,
    queued: pendingFiles().length,
    sent: { ...counters },
  };
}

/** For the tests, and for a fresh session in the same process. */
function reset() {
  counters.crash = 0;
  counters.start = 0;
  counters.diagnostics = 0;
  counters.failed = 0;
  counters.queued = 0;
  seen.clear();
}

/**
 * Take the secrets out, then take the person out: their account name is in
 * every path in the log and a crash report does not need it.
 */
function scrub(value) {
  let text = redactText(value);
  text = text.replace(/\b([A-Za-z]:[\\/]Users[\\/])[^\\/\s"']+/gi, "$1<user>");
  text = text.replace(/\/(?:home|Users)\/[^/\s"']+/g, (m) => `${m.split("/").slice(0, 2).join("/")}/<user>`);
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
  return text.slice(0, MAX_FIELD);
}

/**
 * Scrub a whole structure, value by value.
 *
 * Not `JSON.parse(scrub(JSON.stringify(x)))`: inside a JSON string every
 * backslash is doubled, so `C:\\Users\\Strahinja` reaches the path pattern as
 * `C:\\\\Users\\\\Strahinja` and slides straight past it. Scrubbing the
 * values first and serialising afterwards has no escaping to hide behind.
 */
function scrubDeep(value, depth = 0) {
  if (typeof value === "string") return scrub(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 4) return "<too deep>";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubDeep(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) out[key] = scrubDeep(item, depth + 1);
    return out;
  }
  return scrub(String(value));
}

function buildPayload(kind, { error = null, context = null, text = null, extra = null } = {}) {
  const payload = {
    kind,
    product: config.product,
    version: config.version || "unknown",
    edition: config.edition || null,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    electron: process.versions?.electron ?? null,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    at: new Date().toISOString(),
  };
  if (error) {
    payload.error = {
      name: scrub(error?.name ?? "Error"),
      message: scrub(error?.message ?? error),
      stack: error?.stack ? scrub(error.stack) : null,
    };
  }
  if (context) payload.context = scrubDeep(context);
  // The last few hundred lines are most of the value of a crash report: what was
  // happening right before it. Scrubbed, like everything else.
  if (error) payload.log = scrub(tail(MAX_TAIL_LINES));
  if (text) payload.diagnostics = scrub(text);
  if (extra) payload.extra = scrubDeep(extra);
  return payload;
}

/** POST it and forget it. Never throws, never blocks a shutdown, always says. */
function post(payload) {
  return new Promise((resolve) => {
    if (!config.url) {
      resolve(false);
      return;
    }
    let body;
    try {
      body = JSON.stringify(payload);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      if (!ok) counters.failed += 1;
      resolve(ok);
      // One line, and never the body: the log is a file on the person's disk
      // and a report is not worth leaking into it.
      log(ok ? "info" : "warn", `[reporter] ${payload.kind} report ${ok ? "sent" : "not sent"}${detail ? ` (${detail})` : ""}`);
    };
    try {
      const target = new URL(config.url);
      const client = target.protocol === "https:" ? https : http;
      const request = client.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "user-agent": `${PRODUCT.replace(/\s+/g, "-")}/${config.version || "unknown"}`,
            connection: "close",
          },
          timeout: TIMEOUT_MS,
        },
        (response) => {
          response.resume();
          const status = response.statusCode ?? 0;
          done(status >= 200 && status < 300, `HTTP ${status}`);
        },
      );
      request.on("timeout", () => request.destroy(new Error("timed out")));
      request.on("error", (err) => done(false, err?.message ?? "network error"));
      request.end(body);
    } catch (err) {
      done(false, err?.message ?? "could not build the request");
    }
  });
}

function fingerprint(error) {
  const name = error?.name ?? "Error";
  const message = error?.message ?? String(error);
  const frame =
    String(error?.stack ?? "")
      .split("\n")
      .find((line) => line.includes("at ")) ?? "";
  return `${name}|${message}|${frame}`.slice(0, 300);
}

function queueFile() {
  return path.join(config.queueDir, `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
}

function pendingFiles(dir = config.queueDir) {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /^report-\d+-[a-z0-9]+\.json$/.test(name))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** Synchronous on purpose: on the crash path there is no later. */
function queue(payload) {
  if (!config.queueDir) return null;
  try {
    fs.mkdirSync(config.queueDir, { recursive: true });
    const files = pendingFiles();
    // Oldest first out: a crash loop should not fill the disk.
    while (files.length >= MAX_QUEUE) fs.rmSync(files.shift(), { force: true });
    const file = queueFile();
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
    counters.queued += 1;
    return file;
  } catch (err) {
    log("warn", `[reporter] could not write the report to disk: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * A crash. Queue first (the exit can cut the request off), send, and drop the
 * queued copy only once it is really gone.
 */
async function reportCrash(error, context = null) {
  if (!config.crashReports || !config.url) return false;
  const print = fingerprint(error);
  if (seen.has(print)) return false;
  seen.add(print);
  const payload = buildPayload("crash", { error, context });
  const file = queue(payload);
  const ok = await post(payload);
  if (ok) {
    counters.crash += 1;
    if (file) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* the flush on the next launch will try again */
      }
    }
  }
  return ok;
}

/** One anonymous line per launch: a version, an OS, nothing about a person. */
async function reportStart() {
  if (!config.startPing || !config.url) return false;
  const ok = await post(buildPayload("start"));
  if (ok) counters.start += 1;
  return ok;
}

/**
 * The person pressed "Send diagnostics" — the press is the consent, so this
 * works with both switches off. Everything is scrubbed the same way.
 */
async function reportDiagnostics(text, extra = null) {
  if (!config.url) return false;
  const ok = await post(buildPayload("diagnostics", { text, extra }));
  if (ok) counters.diagnostics += 1;
  return ok;
}

/**
 * Startup: anything the last run could not deliver. Only with consent still
 * given, and a report the server rejected outright (4xx) is dropped rather
 * than retried forever.
 */
async function flushPending() {
  if (!config.crashReports || !config.url) return 0;
  let sent = 0;
  for (const file of pendingFiles()) {
    let payload = null;
    try {
      payload = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fs.rmSync(file, { force: true });
      continue;
    }
    const ok = await post(payload);
    if (ok) sent += 1;
    if (ok) counters.crash += 1;
    if (ok) fs.rmSync(file, { force: true });
  }
  return sent;
}

function clearPending(dir = config.queueDir) {
  for (const file of pendingFiles(dir)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* nothing to do about it */
    }
  }
}

module.exports = {
  clearPending,
  configure,
  flushPending,
  isEndpoint,
  loadReportingConfig,
  pendingFiles,
  reportCrash,
  reportDiagnostics,
  reportStart,
  reset,
  scrub,
  scrubDeep,
  state,
};
