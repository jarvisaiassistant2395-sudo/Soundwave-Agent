// node --test desktop/test — pure helpers of the desktop shell (no Electron needed).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
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
} = require("../src/desktop-settings.cjs");

test("defaults: Ctrl+Shift+Space, tray on, not at login, notifications on", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.hotkey, "Control+Shift+Space");
  assert.ok(HOTKEY_CHOICES.some((c) => c.accelerator === DEFAULT_SETTINGS.hotkey));
});

test("only offered shortcuts and real booleans are accepted", () => {
  const s = normalizeSettings({ hotkey: "Control+Alt+Delete", closeToTray: "yes", openAtLogin: true, extra: 1 });
  assert.equal(s.hotkey, DEFAULT_SETTINGS.hotkey);
  assert.equal(s.closeToTray, true);
  assert.equal(s.openAtLogin, true);
  assert.equal("extra" in s, false);
});

test("patches from the app can't touch internal flags", () => {
  const s = applySettingsPatch(DEFAULT_SETTINGS, { hotkey: "Alt+Space", trayHintShown: true, notifications: false });
  assert.equal(s.hotkey, "Alt+Space");
  assert.equal(s.notifications, false);
  assert.equal(s.trayHintShown, false);
});

test("settings survive a save/load round trip; a broken file falls back to defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-desktop-"));
  const file = path.join(dir, "nested", "desktop-settings.json");
  const custom = applySettingsPatch(DEFAULT_SETTINGS, { hotkey: "Control+Alt+Space", closeToTray: false });
  assert.equal(saveSettings(file, custom), true);
  assert.deepEqual(loadSettings(file), custom);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(loadSettings(file), DEFAULT_SETTINGS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("shortcut labels read like Windows", () => {
  assert.equal(hotkeyLabel("Control+Shift+Space"), "Ctrl+Shift+Space");
  assert.equal(hotkeyLabel("CommandOrControl+Alt+Space"), "Ctrl+Alt+Space");
  for (const c of HOTKEY_CHOICES) assert.equal(hotkeyLabel(c.accelerator), c.label);
});

test("the voice bar sits centered above the taskbar of the display", () => {
  const b = overlayBounds({ x: 1920, y: 0, width: 2560, height: 1392 }, { width: 480, height: 150 });
  assert.deepEqual(b, { x: 1920 + 1040, y: 1392 - 150 - 16, width: 480, height: 150 });
  const tiny = overlayBounds({ x: 0, y: 0, width: 400, height: 100 }, { width: 480, height: 150 }, 0);
  assert.deepEqual(tiny, { x: 0, y: 0, width: 400, height: 100 });
});

test("only in-app routes are navigable from notifications", () => {
  assert.equal(safeRoute("/agent?tab=generator"), "/agent?tab=generator");
  assert.equal(safeRoute("//evil.example"), null);
  assert.equal(safeRoute("https://evil.example"), null);
  assert.equal(safeRoute("/\\evil"), null);
  assert.equal(safeRoute(42), null);
});

test("notification payloads are trimmed and validated", () => {
  assert.equal(sanitizeNotification({ body: "no title" }), null);
  const n = sanitizeNotification({ title: "  Ready ", body: "x".repeat(500), route: "javascript:alert(1)" });
  assert.equal(n.title, "Ready");
  assert.equal(n.body.length, 300);
  assert.equal(n.route, null);
});
