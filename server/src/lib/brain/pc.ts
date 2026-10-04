// ── What the agent can see and do on this PC (desktop app only) ─────────────
// Real actions, no pretending: live system facts, opening a web page in the
// default browser, and opening an app from the Start menu. The desktop shell
// (desktop/src/main.js) hands us Electron's shell.openExternal/openPath as
// globalThis.__soundwaveDesktopHost — the server runs inside the app.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { config } from "../../config.js";

interface DesktopHost {
  openExternal(url: string): Promise<void>;
  openPath(target: string): Promise<string>;
  /** Electron's clipboard (the Ghost Operator macros copy and read back text). */
  readClipboard?(): string;
  writeClipboard?(text: string): void;
  /** A Windows notification from the app itself. Returns false when they're turned off. */
  notify?(opts: { title: string; body: string; route?: string }): boolean;
  /** One PNG of the screen the app is on — the agent's eyes (lib/screen.ts reads it). */
  captureScreen?(): Promise<
    | { png: Uint8Array | ArrayBuffer | string; width?: number; height?: number; display?: string }
    | Uint8Array
    | ArrayBuffer
    | string
    | null
  >;
}

function desktopHost(): DesktopHost | null {
  const h = (globalThis as { __soundwaveDesktopHost?: Partial<DesktopHost> }).__soundwaveDesktopHost;
  return h && typeof h.openExternal === "function" && typeof h.openPath === "function" ? (h as DesktopHost) : null;
}

/** Without Electron (smoke test, development): the platform's own opener. */
function openWithSystem(target: string): void {
  const opts = { detached: true, stdio: "ignore" as const, windowsHide: true };
  const child =
    process.platform === "win32"
      ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", target], opts)
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [target], opts);
  child.on("error", () => undefined);
  child.unref();
}

// ── System facts ────────────────────────────────────────────────────────────

function cpuTimes(): { idle: number; total: number } {
  return os.cpus().reduce(
    (acc, c) => {
      const t = c.times;
      acc.idle += t.idle;
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );
}

function osName(): string {
  if (process.platform === "win32") {
    const build = Number(os.release().split(".")[2] ?? 0);
    const version = os.version(); // "Windows 10 Pro" (also on 11), "Windows Server 2025 Datacenter"
    if (/server/i.test(version)) return `${version} (build ${build || os.release()})`;
    const generation = build >= 22000 ? "11" : "10";
    const edition = /Windows \d+\s*(.*)$/i.exec(version)?.[1]?.trim();
    return `Windows ${generation}${edition ? ` ${edition}` : ""} (build ${build || os.release()})`;
  }
  if (process.platform === "darwin") return `macOS (Darwin ${os.release()})`;
  return `${os.type()} ${os.release()}`;
}

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d ? `${d} d` : "", h ? `${h} h` : "", `${m} min`].filter(Boolean).join(" ");
}

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

export interface PcStatus {
  os: string;
  computerName: string;
  cpu: { model: string; cores: number; loadPercent: number | null };
  memory: { totalGB: number; usedGB: number; usedPercent: number };
  disk: { path: string; freeGB: number; totalGB: number } | null;
  uptime: string;
  uptimeSeconds: number;
  localTime: string;
}

export async function pcStatus(sampleMs = 400): Promise<PcStatus> {
  const before = cpuTimes();
  await new Promise((r) => setTimeout(r, sampleMs));
  const after = cpuTimes();
  const total = after.total - before.total;
  const loadPercent = total > 0 ? Math.round((1 - (after.idle - before.idle) / total) * 100) : null;

  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();

  let disk: PcStatus["disk"] = null;
  const diskPath = process.platform === "win32" ? path.parse(config.dataDir).root || "C:\\" : "/";
  try {
    const s = fs.statfsSync(diskPath);
    disk = { path: diskPath, freeGB: gb(s.bavail * s.bsize), totalGB: gb(s.blocks * s.bsize) };
  } catch {
    disk = null;
  }

  return {
    os: osName(),
    computerName: os.hostname(),
    cpu: { model: (cpus[0]?.model ?? "unknown").replace(/\s+/g, " ").trim(), cores: cpus.length, loadPercent },
    memory: { totalGB: gb(totalMem), usedGB: gb(usedMem), usedPercent: Math.round((usedMem / totalMem) * 100) },
    disk,
    uptime: duration(os.uptime()),
    uptimeSeconds: Math.round(os.uptime()),
    localTime: new Date().toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" }),
  };
}

// ── Web pages ───────────────────────────────────────────────────────────────

/** "youtube.com" → "https://youtube.com/"; only http(s) pages, never file: or javascript:. */
export function normalizeUrl(input: string): string | null {
  let raw = String(input ?? "").trim();
  // Spaces in a search query are fine (the URL parser encodes them); line breaks aren't.
  if (!raw || /[\r\n\t]/.test(raw) || raw.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw.replace(/^\/+/, "")}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || (!url.hostname.includes(".") && url.hostname !== "localhost")) return null;
  return url.toString();
}

export async function openWebsite(input: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const url = normalizeUrl(input);
  if (!url) return { ok: false, error: `“${String(input).slice(0, 200)}” isn't a web address I can open (only http/https pages).` };
  const host = desktopHost();
  try {
    if (host) await host.openExternal(url);
    else openWithSystem(url);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: `The browser didn't open: ${(err as Error).message}` };
  }
}

// ── Apps (Windows Start menu) ───────────────────────────────────────────────

export interface StartApp {
  name: string;
  /** Start menu AppID (Get-StartApps) — opened via shell:AppsFolder. */
  appId?: string;
  /** A Start menu shortcut (.lnk) when PowerShell isn't available. */
  shortcut?: string;
}

const APPS_TTL_MS = 10 * 60_000;
let appsCache: { at: number; apps: StartApp[]; source: "start-apps" | "shortcuts" } | null = null;

const GET_START_APPS =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress";

export function parseStartApps(json: string): StartApp[] {
  let data: unknown;
  try {
    data = JSON.parse(json.replace(/^\uFEFF/, "").trim() || "[]");
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const seen = new Set<string>();
  const out: StartApp[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    const name = typeof item?.Name === "string" ? item.Name.trim() : "";
    const appId = typeof item?.AppID === "string" ? item.AppID.trim() : "";
    if (!name || !appId || /[\r\n"]/.test(appId) || seen.has(appId)) continue;
    seen.add(appId);
    out.push({ name, appId });
  }
  return out;
}

function startAppsViaPowerShell(): Promise<StartApp[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", GET_START_APPS],
      { timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        if (err) return reject(err);
        const apps = parseStartApps(stdout);
        if (apps.length === 0) return reject(new Error("Get-StartApps returned no apps"));
        resolve(apps);
      },
    );
  });
}

function startMenuShortcuts(): StartApp[] {
  const roots = [
    path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs"),
  ];
  const out: StartApp[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(lnk|url|appref-ms)$/i.test(e.name)) out.push({ name: e.name.replace(/\.(lnk|url|appref-ms)$/i, ""), shortcut: full });
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** Apps in this PC's Start menu (cached for a few minutes). Windows only. */
export async function listStartApps(force = false): Promise<{ apps: StartApp[]; source: "start-apps" | "shortcuts" | "none" }> {
  if (process.platform !== "win32") return { apps: [], source: "none" };
  if (!force && appsCache && Date.now() - appsCache.at < APPS_TTL_MS) return { apps: appsCache.apps, source: appsCache.source };
  try {
    const apps = await startAppsViaPowerShell();
    appsCache = { at: Date.now(), apps, source: "start-apps" };
  } catch (err) {
    console.warn(`[brain] Get-StartApps failed (${(err as Error).message}); falling back to Start menu shortcuts`);
    appsCache = { at: Date.now(), apps: startMenuShortcuts(), source: "shortcuts" };
  }
  return { apps: appsCache.apps, source: appsCache.source };
}

function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\+/g, " plus ") // "Notepad++" ≠ "Notepad"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** What people say → what the Start menu calls it. */
const ALIASES: Record<string, string[]> = {
  "google chrome": ["chrome"],
  "microsoft edge": ["edge"],
  "mozilla firefox": ["firefox"],
  "visual studio code": ["vs code", "vscode"],
  "file explorer": ["explorer", "files", "file manager", "this pc", "my computer"],
  calculator: ["calc"],
  "command prompt": ["cmd", "command line"],
  "windows powershell": ["powershell"],
  terminal: ["windows terminal"],
  "task manager": ["taskmgr"],
  settings: ["windows settings", "pc settings"],
  "microsoft store": ["store", "app store"],
  "snipping tool": ["snip", "screenshot tool"],
  paint: ["ms paint", "mspaint"],
  "obs studio": ["obs"],
  word: ["microsoft word"],
  excel: ["microsoft excel"],
  powerpoint: ["microsoft powerpoint"],
  outlook: ["microsoft outlook", "mail"],
};

const NOT_THE_APP = /\b(uninstall|uninstaller|readme|read me|release notes|license|documentation|manual|website|web site|help)\b/i;
const FILLER = /\b(the|app|application|program|please|my|for me|on (?:my|the|this) (?:pc|computer))\b/gi;

export function scoreApp(appName: string, query: string): number {
  const a = norm(appName);
  const q = norm(query.replace(FILLER, " "));
  if (!a || !q) return 0;
  let score = 0;
  if (a === q) score = 100;
  else if ((ALIASES[a] ?? []).includes(q)) score = 96;
  else {
    const aw = a.split(" ");
    const qw = q.split(" ");
    if (qw.every((w) => aw.includes(w))) score = 85 - Math.min(20, (aw.length - qw.length) * 4);
    else if (` ${a} `.includes(` ${q} `)) score = 75;
    else if (a.includes(q) && q.length >= 3) score = 62;
    else if (q.includes(a) && a.length >= 4) score = 58;
    else {
      const hits = qw.filter((w) => w.length >= 3 && aw.some((x) => x.startsWith(w))).length;
      if (hits) score = 30 + Math.round((25 * hits) / Math.max(qw.length, aw.length));
    }
  }
  if (score && NOT_THE_APP.test(appName) && !NOT_THE_APP.test(query)) score -= 45;
  return score;
}

export function findApp(apps: StartApp[], query: string): { best: StartApp | null; alternatives: string[] } {
  const ranked = apps
    .map((app) => ({ app, score: scoreApp(app.name, query) }))
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score || x.app.name.length - y.app.name.length);
  const best = ranked[0] && ranked[0].score >= 55 ? ranked[0].app : null;
  const alternatives = ranked
    .filter((r) => r.app !== best && r.score >= 30)
    .slice(0, 5)
    .map((r) => r.app.name);
  return { best, alternatives };
}

export async function openApp(query: string): Promise<{ ok: true; name: string } | { ok: false; error: string; suggestions?: string[] }> {
  const name = String(query ?? "").trim().slice(0, 120);
  if (!name) return { ok: false, error: "Which app?" };
  if (process.platform !== "win32") return { ok: false, error: "Opening apps works in the Windows desktop app." };
  const { apps } = await listStartApps();
  const { best, alternatives } = findApp(apps, name);
  if (!best) {
    return {
      ok: false,
      error: `There's no app called “${name}” in this PC's Start menu.`,
      ...(alternatives.length ? { suggestions: alternatives } : {}),
    };
  }
  try {
    if (best.appId) {
      // Exactly how the Start menu launches it (desktop apps, Store apps, links).
      const child = spawn("explorer.exe", [`shell:AppsFolder\\${best.appId}`], { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => undefined);
      child.unref();
    } else if (best.shortcut) {
      const host = desktopHost();
      if (host) {
        const problem = await host.openPath(best.shortcut);
        if (problem) return { ok: false, error: `Windows couldn't open ${best.name}: ${problem}` };
      } else openWithSystem(best.shortcut);
    }
    return { ok: true, name: best.name };
  } catch (err) {
    return { ok: false, error: `Windows couldn't open ${best.name}: ${(err as Error).message}` };
  }
}

export function resetPcForTests(): void {
  appsCache = null;
}

// ── Clipboard and notifications (the Ghost Operator macros) ─────────────────
// Both go through Electron's own modules: reading somebody's clipboard from a
// plain Node process is impossible on Windows, so without the desktop host the
// caller gets an honest "only inside the desktop app" instead of silence.

export type ClipboardResult = { ok: true; text: string } | { ok: false; error: string };

/** The text on this PC's clipboard (desktop app only). */
export function readClipboard(): ClipboardResult {
  const host = desktopHost();
  if (!host?.readClipboard) return { ok: false, error: "the clipboard can only be read inside the Soundwave desktop app" };
  try {
    return { ok: true, text: String(host.readClipboard() ?? "") };
  } catch (err) {
    return { ok: false, error: `the clipboard couldn't be read: ${(err as Error).message}` };
  }
}

/** Puts text on this PC's clipboard (desktop app only). */
export function writeClipboard(text: string): { ok: true; chars: number } | { ok: false; error: string } {
  const host = desktopHost();
  if (!host?.writeClipboard) return { ok: false, error: "the clipboard can only be written inside the Soundwave desktop app" };
  const value = String(text ?? "");
  try {
    host.writeClipboard(value);
    return { ok: true, chars: value.length };
  } catch (err) {
    return { ok: false, error: `the clipboard couldn't be written: ${(err as Error).message}` };
  }
}

/** A Windows notification from the app (desktop app only; off when the user turned notifications off). */
export function desktopNotify(opts: { title: string; body: string; route?: string }): { ok: true } | { ok: false; error: string } {
  const host = desktopHost();
  if (!host?.notify) return { ok: false, error: "notifications need the Soundwave desktop app" };
  try {
    return host.notify(opts) === false
      ? { ok: false, error: "notifications are turned off in Settings → Voice & Desktop" }
      : { ok: true };
  } catch (err) {
    return { ok: false, error: `the notification couldn't be shown: ${(err as Error).message}` };
  }
}
