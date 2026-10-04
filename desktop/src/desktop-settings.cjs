// Desktop-shell preferences (voice shortcut, tray, start with Windows,
// notifications) and small pure helpers used by src/main.js. Kept free of
// Electron imports so `node --test desktop/test` can check them anywhere.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Shortcuts offered in Settings → Voice & Desktop (Electron accelerators). */
const HOTKEY_CHOICES = Object.freeze([
  { accelerator: "Control+Shift+Space", label: "Ctrl+Shift+Space" },
  { accelerator: "Control+Alt+Space", label: "Ctrl+Alt+Space" },
  { accelerator: "Alt+Space", label: "Alt+Space" },
]);

const DEFAULT_SETTINGS = Object.freeze({
  hotkey: "Control+Shift+Space",
  hotkeyEnabled: true,
  /** Hold the shortcut (or the mic) and talk — released, it sends. */
  pushToTalk: true,
  /** "Hey Soundwave" wakes it while the app runs (recognized on this PC). */
  wakeEnabled: true,
  closeToTray: true,
  openAtLogin: false,
  notifications: true,
  /** The "still running in the tray" notification was shown once. */
  trayHintShown: false,
});

/** Keys the app's Settings page may change. */
const USER_KEYS = ["hotkey", "hotkeyEnabled", "pushToTalk", "wakeEnabled", "closeToTray", "openAtLogin", "notifications"];
const BOOLEAN_KEYS = ["hotkeyEnabled", "pushToTalk", "wakeEnabled", "closeToTray", "openAtLogin", "notifications", "trayHintShown"];

function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return settings;
  if (typeof raw.hotkey === "string" && HOTKEY_CHOICES.some((c) => c.accelerator === raw.hotkey)) settings.hotkey = raw.hotkey;
  for (const key of BOOLEAN_KEYS) if (typeof raw[key] === "boolean") settings[key] = raw[key];
  return settings;
}

function loadSettings(file) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(file, settings) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalizeSettings(settings), null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn(`[soundwave-desktop] could not save settings: ${err.message}`);
    return false;
  }
}

/** Apply a patch from the app (unknown keys and invalid values are ignored). */
function applySettingsPatch(current, patch) {
  const next = { ...current };
  if (patch && typeof patch === "object") {
    for (const key of USER_KEYS) if (key in patch) next[key] = patch[key];
  }
  return normalizeSettings(next);
}

/** "Control+Shift+Space" → "Ctrl+Shift+Space" */
function hotkeyLabel(accelerator) {
  return String(accelerator).replace(/\b(CommandOrControl|CmdOrCtrl|Control)\b/g, "Ctrl");
}

/** The voice bar: centered at the bottom of a display's work area (above the taskbar). */
function overlayBounds(workArea, size, margin = 16) {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - margin),
    width,
    height,
  };
}

/** An in-app route ("/agent?tab=generator") — never a URL or protocol-relative path. */
function safeRoute(route) {
  if (typeof route !== "string" || route.length > 300) return null;
  if (!route.startsWith("/") || route.startsWith("//") || /[\\\r\n\0]/.test(route)) return null;
  return route;
}

/** The notification payload the app may send, trimmed to sane sizes. */
function sanitizeNotification(n) {
  if (!n || typeof n !== "object" || typeof n.title !== "string" || !n.title.trim()) return null;
  return {
    title: n.title.trim().slice(0, 120),
    body: typeof n.body === "string" ? n.body.trim().slice(0, 300) : "",
    route: safeRoute(n.route),
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  HOTKEY_CHOICES,
  applySettingsPatch,
  hotkeyLabel,
  loadSettings,
  normalizeSettings,
  overlayBounds,
  safeRoute,
  sanitizeNotification,
  saveSettings,
};
