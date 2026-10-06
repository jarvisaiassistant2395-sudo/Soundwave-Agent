/**
 * Soundwave AI — Ghost Operator: multi-step macros that really run.
 *
 * Every step does something real on this PC, through the same capabilities the
 * agent's own tools use (lib/brain/pc.ts, lib/morning.ts, the shorts pipeline,
 * the agent's memory). Nothing is simulated and no numbers are invented: a
 * step's output is what actually happened — the page that opened, the files
 * that were found, the CPU and memory the PC reported, the weather it fetched,
 * the short it started, the clipboard text it really read back.
 *
 * Steps for things Soundwave can't do yet (system volume, screenshots, moving
 * windows, running code) are reported SKIPPED with the reason, never as if
 * they had run. Without the desktop app (a plain server) the PC-only steps say
 * so instead of pretending.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { appendToConversation } from "./conversation.js";
import { chatTime, newMessageId } from "./chatMessages.js";
import { startShortJob, getActiveShortJobs } from "../routes/agentShort.js";
import { desktopNotify, openApp, openWebsite, pcStatus, readClipboard, writeClipboard } from "./brain/pc.js";
import { morningCity, morningWeather, runMorningSetup } from "./morning.js";
import { memoryState } from "./memory.js";
import { DEFAULT_AGENT_VOICE } from "./edgeTts.js";

export interface MacroStep {
  id: string;
  action: string;
  params: Record<string, any>;
  description: string;
  delayMs?: number;
  critical?: boolean;
}

export interface MacroWorkflow {
  id: string;
  name: string;
  description: string;
  category: "creator" | "productivity" | "system" | "custom";
  triggerPhrases: string[];
  steps: MacroStep[];
  icon?: string;
  createdAt: string;
  isBuiltin?: boolean;
}

export interface StepExecutionResult {
  stepId: string;
  action: string;
  description: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  output: string;
  durationMs: number;
}

export interface MacroExecutionReport {
  workflowId: string;
  workflowName: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  allSuccess: boolean;
  stepResults: StepExecutionResult[];
  summary: string;
}

/** What a macro may do on this PC. The server fills this in; tests override it. */
export interface GhostContext {
  userId: string;
  /** The server runs inside the desktop app: it can open things, use the clipboard, notify. */
  desktop: boolean;
  platform: NodeJS.Platform;
  voice: string;
  resolution: "720p" | "1080p";
}

export function defaultGhostContext(overrides: Partial<GhostContext> = {}): GhostContext {
  return {
    userId: "local-user",
    desktop: config.desktopApp,
    platform: process.platform,
    voice: DEFAULT_AGENT_VOICE,
    resolution: "1080p",
    ...overrides,
  };
}

// ── Built-in workflows (real steps only) ────────────────────────────────────
// (Morning Setup is real now — lib/morning.ts — and no longer a macro.)
export const BUILTIN_MACROS: MacroWorkflow[] = [
  {
    id: "viral_production_autopilot",
    name: "🎬 1-Click Viral Short",
    description:
      "Starts a real short (script, Soundwave voice, subtitles, an unused Orbital NCG background) and sets a reminder to review it. The finished video is posted in the chat by itself.",
    category: "creator",
    triggerPhrases: ["viral autopilot", "produce short", "make viral video", "render short"],
    icon: "Flame",
    createdAt: "2026-09-19T00:00:00.000Z",
    isBuiltin: true,
    steps: [
      {
        id: "step-1",
        action: "soundwave_shorts",
        params: { topic: "a mind-blowing fact" },
        description: "Start making the short",
        delayMs: 200,
      },
      {
        id: "step-2",
        action: "reminder",
        params: { seconds: 150, message: "Your short is rendering — it will be posted in the chat when it's ready." },
        description: "Remind me to check it in a couple of minutes",
        delayMs: 100,
      },
    ],
  },
  {
    id: "workspace_cleanup_diagnostics",
    name: "🧹 Workspace & System Diagnostics",
    description:
      "Scans the Soundwave data folder (size, biggest files, what hasn't been touched in 30+ days), reports this PC's real CPU/memory/disk/uptime, and reads the agent's memory. Nothing is deleted.",
    category: "system",
    triggerPhrases: ["system check", "diagnostics", "clean workspace", "health check"],
    icon: "Activity",
    createdAt: "2026-09-19T00:00:00.000Z",
    isBuiltin: true,
    steps: [
      {
        id: "step-1",
        action: "file_processor",
        params: {},
        description: "Scan the Soundwave data folder",
        delayMs: 100,
      },
      {
        id: "step-2",
        action: "system_monitor",
        params: {},
        description: "Read live CPU, memory, disk and uptime",
        delayMs: 100,
      },
      {
        id: "step-3",
        action: "memory_notes",
        params: {},
        description: "Read the agent's memory and briefing plan",
        delayMs: 100,
      },
    ],
  },
];

// ── What Soundwave can really do, and what it can't (yet) ───────────────────
/** Actions with a real implementation behind them. */
export const REAL_ACTIONS = [
  "open_website",
  "browser_control",
  "open_app",
  "web_search",
  "system_monitor",
  "file_processor",
  "memory_notes",
  "weather_report",
  "clipboard",
  "reminder",
  "soundwave_shorts",
  "morning_setup",
] as const;

/** Recognised actions Soundwave can't do yet — each step is SKIPPED with this reason. */
export const NOT_BUILT_YET: Record<string, string> = {
  computer_settings:
    "A macro can't contain a volume step yet — the agent itself changes the volume and mutes in chat (\"mute it\", \"turn it down to 30%\"). For a macro, the PC's own volume keys are the way.",
  computer_control: "A macro can't move or minimise windows yet.",
  screen_processor:
    "A macro can't take a screenshot step yet — the agent itself can look at your screen in chat: ask it \"what does this error say?\".",
  code_helper: "Soundwave doesn't run code or Python scripts.",
};

// ── Persistence Helpers ─────────────────────────────────────────────────────
function macrosDir(userId: string): string {
  const safe = (userId || "local-user").replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(config.dataDir, "macros", safe);
}

function macrosPath(userId: string): string {
  return path.join(macrosDir(userId), "workflows.json");
}

export async function listMacros(userId: string): Promise<MacroWorkflow[]> {
  try {
    const p = macrosPath(userId);
    if (!fs.existsSync(p)) {
      return [...BUILTIN_MACROS];
    }
    const raw = await fsp.readFile(p, "utf-8");
    const userMacros: MacroWorkflow[] = JSON.parse(raw);
    return [...BUILTIN_MACROS, ...userMacros];
  } catch {
    return [...BUILTIN_MACROS];
  }
}

export async function saveCustomMacro(
  userId: string,
  macro: Omit<MacroWorkflow, "id" | "createdAt" | "isBuiltin">
): Promise<MacroWorkflow> {
  const newMacro: MacroWorkflow = {
    ...macro,
    id: `macro_${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    isBuiltin: false,
    steps: macro.steps.map((s, idx) => ({
      ...s,
      id: s.id || `step-${idx + 1}`,
      delayMs: s.delayMs ?? 250,
    })),
  };

  const p = macrosPath(userId);
  await fsp.mkdir(path.dirname(p), { recursive: true });

  let existing: MacroWorkflow[] = [];
  try {
    if (fs.existsSync(p)) {
      existing = JSON.parse(await fsp.readFile(p, "utf-8"));
    }
  } catch {}

  existing.push(newMacro);
  await fsp.writeFile(p, JSON.stringify(existing, null, 2), "utf-8");
  return newMacro;
}

export async function deleteCustomMacro(userId: string, macroId: string): Promise<boolean> {
  const p = macrosPath(userId);
  if (!fs.existsSync(p)) return false;
  try {
    const existing: MacroWorkflow[] = JSON.parse(await fsp.readFile(p, "utf-8"));
    const filtered = existing.filter((m) => m.id !== macroId);
    await fsp.writeFile(p, JSON.stringify(filtered, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ── Natural Language Workflow Decomposer ─────────────────────────────────────
/**
 * Takes complex multi-action English commands and decomposes them into a chain
 * of concrete steps — only real ones. Things Soundwave can't do (changing the
 * volume, screenshots, running code) come back as `unsupported` steps so the
 * report can say why nothing happened instead of inventing a result.
 * e.g. "open chrome, set a 5 minute timer and check system stats"
 */
export function decomposeNaturalLanguage(instruction: string): MacroStep[] {
  const text = instruction.trim();
  if (!text) return [];

  // Split clauses on transitions: "and then", "then", "and", ";", or ","
  const clauses = text
    .split(/\b(?:and then|then|after that|next)\b|[;,]|\band\b/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const steps: MacroStep[] = [];
  const push = (idx: number, action: string, params: Record<string, any>, description: string, delayMs = 200) =>
    steps.push({ id: `step-${idx + 1}`, action, params, description, delayMs });

  clauses.forEach((rawClause, idx) => {
    const q = rawClause.toLowerCase();

    const unsupported = (reason: string) => push(idx, "unsupported", { reason, request: rawClause }, reason);
    const notYet = (action: string) => unsupported(NOT_BUILT_YET[action]!);

    // 1. Volume / mute — not built yet (be honest, don't fake it)
    if (q.includes("mute") || q.includes("volume")) {
      notYet("computer_settings");
      return;
    }

    // 2. Screenshot / vision
    if (q.includes("screenshot") || q.includes("capture screen") || q.includes("snapshot") || q.includes("see screen")) {
      notYet("screen_processor");
      return;
    }

    // 3. Windows on the desktop
    if (q.includes("minimize") || q.includes("minimise") || q.includes("show desktop") || q.includes("clear windows")) {
      notYet("computer_control");
      return;
    }

    // 4. Running code — there is no code runner (it was removed with Deep Focus)
    if (q.includes("python") || /\bscript\b/.test(q) || /^(run|exec|eval)\b/.test(q)) {
      notYet("code_helper");
      return;
    }

    // 5. Open a page or an app — but "start a timer", "start a short" and
    //    "open my briefing" are other intents: they fall through to their steps.
    const opensSomething = /^(open|launch|start)\s+/.test(q);
    const anotherIntent = /\b(timer|remind|reminder|alarm|short|video|viral|briefing|agenda|weather|forecast)\b/.test(q);
    if (opensSomething && !anotherIntent) {
      const target = rawClause.replace(/^(open|launch|start)\s+/i, "").trim();
      if (/^(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/i.test(target)) {
        push(idx, "open_website", { url: target }, `Open ${target} in the browser`, 300);
      } else {
        push(idx, "open_app", { name: target }, `Open the app “${target}”`, 300);
      }
      return;
    }

    // 6. Weather
    if (q.includes("weather") || q.includes("temperature") || q.includes("forecast")) {
      const m = rawClause.match(/\bin\s+([a-zA-Z\u00C0-\u024F\s]+)/i);
      push(idx, "weather_report", { city: m ? m[1]!.trim() : "" }, `Check the live weather${m ? ` in ${m[1]!.trim()}` : ""}`, 200);
      return;
    }

    // 7. System stats / vitals
    if (q.includes("stat") || q.includes("cpu") || q.includes("ram") || q.includes("vitals") || q.includes("hardware") || q.includes("memory")) {
      push(idx, "system_monitor", {}, "Read live CPU, memory, disk and uptime", 200);
      return;
    }

    // 8. Files / the workspace
    if (q.includes("file") || q.includes("folder") || q.includes("workspace") || q.includes("directory") || q.includes("disk space")) {
      const m = rawClause.match(/\bin\s+([A-Za-z]:\\[^,;]+|\/[^\s,;]+)/);
      push(idx, "file_processor", m ? { path: m[1]!.trim() } : {}, `Scan ${m ? m[1]!.trim() : "the Soundwave data folder"}`, 200);
      return;
    }

    // 9. Clipboard
    if (q.includes("clipboard") || q.includes("copy") || q.includes("paste")) {
      const copyMatch = rawClause.match(/copy\s+["']?([^"']+)["']?/i);
      if (copyMatch && copyMatch[1]) {
        const value = copyMatch[1].trim();
        push(idx, "clipboard", { operation: "set", text: value }, `Copy “${value.slice(0, 60)}” to the clipboard`, 200);
      } else {
        push(idx, "clipboard", { operation: "get" }, "Read the clipboard", 200);
      }
      return;
    }

    // 10. Timers & reminders
    if (q.includes("timer") || q.includes("remind") || q.includes("alarm")) {
      const secMatch = q.match(/(\d+)\s*(min|minute|sec|second|hour)/i);
      let secs = 60;
      if (secMatch && secMatch[1]) {
        const val = parseInt(secMatch[1]!, 10);
        const unit = (secMatch[2] ?? "sec").toLowerCase();
        secs = unit.startsWith("min") ? val * 60 : unit.startsWith("hour") ? val * 3600 : val;
      }
      const message = rawClause.replace(/^(set|start)\s+/i, "").replace(/^(a|an)\s+/i, "").trim();
      push(idx, "reminder", { seconds: secs, message: message || "Reminder" }, `Remind me in ${secs}s: “${message}”`, 200);
      return;
    }

    // 11. Shorts
    if (q.includes("short") || q.includes("video") || q.includes("viral")) {
      const topic = rawClause.match(/about\s+(.+)$/i)?.[1]?.trim();
      let niche = "a mind-blowing fact";
      for (const n of ["facts", "history", "finance", "ai", "motivation", "horror", "psychology"]) {
        if (q.includes(n)) {
          niche = n;
          break;
        }
      }
      push(idx, "soundwave_shorts", { topic: topic || niche }, `Start making a short about “${topic || niche}”`, 400);
      return;
    }

    // 12. Briefing / agenda → the real Morning Setup
    if (q.includes("briefing") || q.includes("agenda") || q.includes("morning") || q.includes("check in")) {
      push(idx, "morning_setup", {}, "Run Morning Setup (opens the morning items, briefs from real facts)", 200);
      return;
    }

    // 13. Anything else is a web search — which we really do, in the browser
    push(idx, "web_search", { query: rawClause }, `Search the web for “${rawClause}”`, 200);
  });

  return steps;
}

// ── Real step implementations ───────────────────────────────────────────────
type Outcome = { status: "SUCCESS" | "FAILED" | "SKIPPED"; output: string };

const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

const fmtBytes = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function durationWords(seconds: number): string {
  if (seconds >= 3600) return `${Math.round((seconds / 3600) * 10) / 10} hours`;
  if (seconds >= 60) return `${Math.round((seconds / 60) * 10) / 10} minutes`;
  return `${seconds} seconds`;
}

/** Directory scan (read-only — the macro never deletes anything). */
async function scanFiles(input: string): Promise<Outcome> {
  const raw = input.trim();
  const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  const target = path.resolve(expanded || config.dataDir);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch (err) {
    return { status: "FAILED", output: `Couldn't read ${target}: ${(err as Error).message}` };
  }

  const MAX = 400;
  let files = 0;
  let folders = 0;
  let bytes = 0;
  let stale = 0;
  const byType = new Map<string, number>();
  const biggest: Array<{ name: string; size: number }> = [];
  const now = Date.now();
  const scanned: string[] = [];

  for (const entry of entries) {
    if (files + folders >= MAX) break;
    scanned.push(entry.name);
    if (entry.isDirectory()) {
      folders += 1;
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const st = await fsp.stat(path.join(target, entry.name));
      files += 1;
      bytes += st.size;
      const ext = path.extname(entry.name).toLowerCase() || "(no extension)";
      byType.set(ext, (byType.get(ext) ?? 0) + 1);
      if (now - st.mtimeMs > 30 * 86_400_000) stale += 1;
      biggest.push({ name: entry.name, size: st.size });
      biggest.sort((a, b) => b.size - a.size);
      if (biggest.length > 3) biggest.length = 3;
    } catch {
      // An entry we can't stat (locked or gone) — it just doesn't count.
    }
  }

  const types = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([ext, n]) => `${ext} ×${n}`)
    .join(", ");
  const parts = [
    `Scanned ${target}: ${files} file(s) (${fmtBytes(bytes)}) and ${folders} folder(s)`,
    biggest.length ? `biggest: ${biggest.map((b) => `${b.name} (${fmtBytes(b.size)})`).join(", ")}` : "",
    types ? `by type: ${types}` : "",
    `not touched in 30+ days: ${stale}`,
    entries.length > scanned.length ? `${entries.length - scanned.length} more entries weren't scanned` : "",
    "nothing was deleted",
  ].filter(Boolean);
  return { status: "SUCCESS", output: `${parts.join("; ")}.` };
}

function memoryFacts(): Outcome {
  const state = memoryState();
  const notes = state.notes;
  const newest = notes[notes.length - 1];
  const plan = state.briefing;
  const lastMorning = state.lastMorningAt ? `${Math.round((Date.now() - state.lastMorningAt) / 60_000)} min ago` : "never";
  const parts = [
    `${notes.length} note(s)${newest ? `, newest: “${newest.text.slice(0, 90)}”` : ""}`,
    state.summary ? `a conversation summary (${state.summary.text.length} characters, written ${Math.max(0, Math.round((Date.now() - state.summary.updatedAt) / 60_000))} min ago)` : "no conversation summary yet",
    plan.topics.length
      ? `morning briefing at ${plan.time} on ${plan.topics.length} topic(s)${plan.auto ? "" : " (manual only)"}`
      : "no morning briefing topics set",
    `last Morning Setup: ${lastMorning}`,
  ];
  return { status: "SUCCESS", output: `The agent's memory: ${parts.join("; ")}.` };
}

async function weatherStep(city: string): Promise<Outcome> {
  const target = city || morningCity().city;
  const { weather, note } = await morningWeather(target);
  if (!weather) {
    return { status: "SKIPPED", output: note ?? `No weather available${target ? ` for ${target}` : ""}.` };
  }
  const high = weather.highC != null ? `${weather.highC}°C` : "—";
  const low = weather.lowC != null ? `${weather.lowC}°C` : "—";
  const rain = weather.rainChance != null ? `${weather.rainChance}%` : "—";
  return {
    status: "SUCCESS",
    output: `Weather in ${weather.place}${weather.country ? `, ${weather.country}` : ""}: ${weather.tempC ?? "—"}°C, ${weather.description} (today ${low}–${high}, rain ${rain}) — live from Open-Meteo.`,
  };
}

function clipboardStep(step: MacroStep): Outcome {
  const operation = str(step.params.operation) || "get";
  if (operation === "set") {
    const text = typeof step.params.text === "string" ? step.params.text : String(step.params.text ?? "");
    if (!text) return { status: "SKIPPED", output: "There was no text to copy." };
    const r = writeClipboard(text);
    if (!r.ok) return { status: "SKIPPED", output: `Didn't copy anything: ${r.error}.` };
    return { status: "SUCCESS", output: `Copied ${r.chars} character(s) to this PC's clipboard: “${text.slice(0, 120)}”.` };
  }
  const r = readClipboard();
  if (!r.ok) return { status: "SKIPPED", output: `Didn't read the clipboard: ${r.error}.` };
  return {
    status: "SUCCESS",
    output: r.text ? `This PC's clipboard (${r.text.length} character(s)): “${r.text.slice(0, 300)}”.` : "This PC's clipboard is empty.",
  };
}

/** Real reminders: a chat message now, a Windows notification when it's due. */
const pendingReminders = new Set<NodeJS.Timeout>();

function reminderStep(step: MacroStep, ctx: GhostContext): Outcome {
  const seconds = Math.min(86_400, Math.max(1, Math.round(Number(step.params.seconds) || 60)));
  const message = str(step.params.message, 300) || "Reminder";
  const timer = setTimeout(() => {
    pendingReminders.delete(timer);
    try {
      appendToConversation({
        id: newMessageId(),
        sender: "assistant",
        text: `⏰ Reminder: ${message}`,
        time: chatTime(),
        tag: "SYS",
        at: Date.now(),
      });
    } catch {
      // No conversation to write to (a bare server) — the notification still goes out.
    }
    if (ctx.desktop) desktopNotify({ title: "Soundwave reminder", body: message, route: "/agent" });
  }, seconds * 1000);
  timer.unref?.();
  pendingReminders.add(timer);
  return {
    status: "SUCCESS",
    output: `Reminder set for ${durationWords(seconds)} from now: “${message}”. It appears in the chat${ctx.desktop ? " and as a Windows notification" : ""}.`,
  };
}

/** Cancels pending reminders (tests, and a clean shutdown). */
export function clearReminders(): void {
  for (const timer of pendingReminders) clearTimeout(timer);
  pendingReminders.clear();
}

async function shortsStep(step: MacroStep, ctx: GhostContext): Promise<Outcome> {
  const active = getActiveShortJobs()[0];
  if (active) {
    return { status: "SKIPPED", output: `A short is already rendering (“${active.topic}”) — only one at a time. Run this again once it's posted.` };
  }
  const topic = str(step.params.topic, 200) || str(step.params.niche, 200) || "a mind-blowing fact";
  const details = str(step.params.details, 800);
  try {
    const { jobId } = await startShortJob({
      topic,
      ...(details ? { scriptBrief: details } : {}),
      voice: ctx.voice,
      resolution: ctx.resolution,
      userId: ctx.userId,
    });
    return {
      status: "SUCCESS",
      output: `Started making a short about “${topic}” (job ${jobId}) — it renders in the background and is posted in this chat when it's done.`,
    };
  } catch (err) {
    return { status: "FAILED", output: `Couldn't start the short: ${(err as Error).message}` };
  }
}

async function runStep(step: MacroStep, ctx: GhostContext): Promise<Outcome> {
  switch (step.action) {
    case "open_website":
    case "browser_control": {
      const raw = str(step.params.url) || str(step.params.query);
      if (!raw) return { status: "SKIPPED", output: "No web address in this step." };
      const r = await openWebsite(raw);
      return r.ok ? { status: "SUCCESS", output: `Opened ${r.url} in this PC's browser.` } : { status: "FAILED", output: r.error };
    }

    case "web_search": {
      const query = str(step.params.query) || str(step.params.text);
      if (!query) return { status: "SKIPPED", output: "No search query in this step." };
      const r = await openWebsite(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
      return r.ok
        ? { status: "SUCCESS", output: `Opened a Google search for “${query}” in this PC's browser.` }
        : { status: "FAILED", output: r.error };
    }

    case "open_app": {
      const name = str(step.params.name, 120) || str(step.params.app_name, 120);
      if (!name) return { status: "SKIPPED", output: "No app name in this step." };
      if (ctx.platform !== "win32") {
        return { status: "SKIPPED", output: "Opening apps from the Start menu works in the Windows desktop app." };
      }
      const r = await openApp(name);
      return r.ok ? { status: "SUCCESS", output: `Opened ${r.name} on this PC.` } : { status: "FAILED", output: r.error };
    }

    case "system_monitor": {
      const st = await pcStatus();
      const load = st.cpu.loadPercent == null ? "unknown load" : `${st.cpu.loadPercent}% load`;
      const disk = st.disk ? `, ${st.disk.freeGB} GB free of ${st.disk.totalGB} GB on ${st.disk.path}` : "";
      return {
        status: "SUCCESS",
        output: `${st.computerName} — ${st.os}; ${st.cpu.model} (${st.cpu.cores} cores, ${load}); memory ${st.memory.usedGB} of ${st.memory.totalGB} GB in use (${st.memory.usedPercent}%)${disk}; up ${st.uptime}.`,
      };
    }

    case "file_processor":
      return scanFiles(str(step.params.path, 500));

    case "memory_notes":
      return memoryFacts();

    case "weather_report":
      return weatherStep(str(step.params.city, 120));

    case "clipboard":
      return clipboardStep(step);

    case "reminder":
      return reminderStep(step, ctx);

    case "soundwave_shorts":
      return shortsStep(step, ctx);

    case "morning_setup": {
      try {
        const reply = await runMorningSetup({ via: "pc" });
        const text = (reply.reply ?? "").trim();
        return { status: "SUCCESS", output: text ? `Morning Setup ran: ${text.slice(0, 900)}` : "Morning Setup ran." };
      } catch (err) {
        return { status: "FAILED", output: `Morning Setup failed: ${(err as Error).message}` };
      }
    }

    case "unsupported":
      return { status: "SKIPPED", output: str(step.params.reason, 400) || "Soundwave can't do that yet." };

    default: {
      const notYet = NOT_BUILT_YET[step.action];
      if (notYet) return { status: "SKIPPED", output: notYet };
      return {
        status: "SKIPPED",
        output: `“${step.action}” isn't something Soundwave can do. Real actions: ${REAL_ACTIONS.join(", ")}.`,
      };
    }
  }
}

// ── Action step executor ────────────────────────────────────────────────────
/**
 * Runs one macro step for real and reports what happened. Nothing here invents
 * a result: successes carry the facts the action produced, gaps say what
 * Soundwave can't do yet, and failures carry the real error.
 */
export async function executeStep(step: MacroStep, ctx: GhostContext = defaultGhostContext()): Promise<StepExecutionResult> {
  const start = Date.now();
  let outcome: Outcome;
  try {
    outcome = await runStep(step, ctx);
  } catch (err) {
    outcome = { status: "FAILED", output: `Execution failed: ${(err as Error).message || String(err)}` };
  }
  return {
    stepId: step.id,
    action: step.action,
    description: step.description,
    status: outcome.status,
    output: outcome.output,
    durationMs: Date.now() - start,
  };
}

/**
 * Execute an entire macro workflow sequentially, for real.
 */
export async function executeWorkflow(
  workflow: MacroWorkflow,
  ctx: GhostContext = defaultGhostContext(),
  onStepProgress?: (stepIndex: number, result: StepExecutionResult) => void
): Promise<MacroExecutionReport> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const results: StepExecutionResult[] = [];

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]!;
    const wait = Math.min(Math.max(step.delayMs ?? 0, 0), 2000);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const stepResult = await executeStep(step, ctx);
    results.push(stepResult);
    onStepProgress?.(i, stepResult);
  }

  const completedAt = new Date().toISOString();
  const totalDurationMs = Date.now() - startTime;
  const ran = results.filter((r) => r.status === "SUCCESS").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;
  const failed = results.filter((r) => r.status === "FAILED").length;
  const allSuccess = failed === 0;

  const seconds = (totalDurationMs / 1000).toFixed(1);
  const parts = [`${ran} of ${results.length} steps ran`];
  if (skipped) parts.push(`${skipped} skipped (Soundwave can't do those yet — the reason is on each step)`);
  if (failed) parts.push(`${failed} failed`);
  const summary = `${workflow.name}: ${parts.join(", ")} in ${seconds}s.`;

  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    startedAt,
    completedAt,
    totalDurationMs,
    allSuccess,
    stepResults: results,
    summary,
  };
}
