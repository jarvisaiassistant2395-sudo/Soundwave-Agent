// Soundwave AI — desktop shell.
//
// Boots the bundled Express server IN-PROCESS (all dependencies are pure JS),
// then opens the Command Center in a native window. No terminal, .bat, or admin
// prompt. The optional Kokoro narrator provisions its CPU-only Python runtime
// and model under user data on first launch, invisibly; yt-dlp also keeps its
// writable user-data copy current (YouTube breaks old builds). yt-dlp's
// JavaScript runtime is this very binary running as Node (ELECTRON_RUN_AS_NODE
// — see server/src/lib/jsRuntime.ts).
//
// Voice: a system-wide shortcut (Ctrl+Shift+Space by default) opens a small
// always-on-top voice bar (/overlay) that listens, asks the agent and speaks
// the answer; speech is recognized locally by the bundled whisper.cpp. The app
// lives in the tray (closing the window keeps it running), can start with
// Windows, and posts Windows notifications when a short is ready.
"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { applyServerEnv, getFreePort } = require("./server-env.cjs");
const { createManagedKokoro } = require("./kokoro-manager.cjs");
const { createKeyWatcher } = require("./keywatch.cjs");
const { DEFAULT_WAKE_PHRASES, vkCodesFor, wakeHit } = require("./wake.cjs");
const { currentEdition } = require("./edition.cjs");
const { createAutoUpdater } = require("./update.cjs");
const {
  HOTKEY_CHOICES,
  applySettingsPatch,
  hotkeyLabel,
  loadSettings,
  overlayBounds,
  safeRoute,
  sanitizeNotification,
  saveSettings,
} = require("./desktop-settings.cjs");

// ── Child-process hygiene ────────────────────────────────────────────────────
// The server spawns ffmpeg / yt-dlp / whisper helpers. A GUI app on Windows
// would flash a console window for each of those unless windowsHide is set —
// patch the builtins ONCE, before the server is imported. (ESM named imports
// of node:child_process reflect the patched CJS exports.)
const cp = require("node:child_process");
const wrapHide = (fn) =>
  function (...args) {
    const last = args.length - 1;
    if (last >= 0 && args[last] && typeof args[last] === "object" && !Array.isArray(args[last])) {
      args[last] = { windowsHide: true, ...args[last] };
    }
    return fn.apply(this, args);
  };
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  if (typeof cp[name] === "function") cp[name] = wrapHide(cp[name]);
}

/**
 * Which build this is (src/edition.cjs): the sold app or the owner's own.
 * The appId must equal electron-builder's for this edition — Windows attributes
 * notifications to it — and the user-data folder is set explicitly rather than
 * derived from the product name, so the two editions can never share one folder
 * (their settings, secrets and data must stay apart).
 */
const EDITION = currentEdition();
const APP_ID = EDITION.appId;
const APP_NAME = EDITION.displayName;
// Set before the app is ready, which is the only time Electron honours it. If
// anything here fails, the app keeps working in the default folder — a person's
// app must not refuse to start over a directory name.
let USER_DATA_DIR = null;
try {
  USER_DATA_DIR = path.join(app.getPath("appData"), EDITION.userDataFolder);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  app.setPath("userData", USER_DATA_DIR);
} catch (err) {
  console.warn(`[soundwave-desktop] could not use its own data folder: ${err.message}`);
}
/** Started by Windows at sign-in ("Start with Windows"): stay in the tray. */
const START_HIDDEN = process.argv.includes("--hidden");
const OVERLAY_SIZE = { width: 480, height: 150 };
const BUILD_DIR = path.join(__dirname, "..", "build");
const ICON_PNG = path.join(BUILD_DIR, "icon.png");
const ICON_ICO = path.join(BUILD_DIR, "icon.ico");
const PRELOAD = path.join(__dirname, "preload.cjs");

let mainWindow = null;
let overlayWindow = null;
/** The hidden window that listens for "Hey Soundwave" (frontend /wake). */
let wakeWindow = null;
const WAKE_SIZE = { width: 360, height: 120 };
/** What the wake listener has heard, for Settings and the tests. */
let wakeInfo = { state: "starting", detail: null, heard: 0, ignored: 0, lastHeard: null, lastHit: null, hitAt: null };
/** Reasons the wake listener is paused (holding a set: overlap-safe). */
const wakePaused = new Set();
let wakeResumeTimer = null;
/** The Windows key watcher that turns the shortcut into hold-to-talk. */
let keyWatcher = null;
/** A wake command that arrived before the voice bar was ready to receive it. */
let pendingWake = null;
/** The voice bar's page subscribed to shortcut presses (earlier presses wait in pendingVoice). */
let overlayListening = false;
let pendingVoice = [];
let tray = null;
let isQuitting = false;
let serverStarted = false;
let kokoroManager = null;
let serverUrl = "";
let appOrigin = "";
let settings = null;
let settingsFile = "";
let hotkeyState = { registered: false, error: null };
const liveNotifications = new Set();

// ── Helpers ──────────────────────────────────────────────────────────────────

function pollHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(`${url}/api/health`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 300);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function isAppUrl(url) {
  try {
    return Boolean(appOrigin) && new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}

/** IPC only from the app's own pages. */
function trusted(event) {
  return isAppUrl((event.senderFrame && event.senderFrame.url) || "");
}

function alive(win) {
  return Boolean(win) && !win.isDestroyed();
}

/** Never let a window wander off-origin or open arbitrary windows. */
function lockNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:") {
        shell.openExternal(url);
      }
    } catch {
      /* ignore malformed urls */
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
}

function loginItemOptions() {
  // The portable build runs from a temporary extraction; start the real exe.
  return { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ["--hidden"] };
}

function supportsLoginItems() {
  return process.platform === "win32" || process.platform === "darwin";
}

// ── Settings ─────────────────────────────────────────────────────────────────

function publicState() {
  return {
    ...settings,
    wake: {
      enabled: settings.wakeEnabled,
      running: alive(wakeWindow),
      phrases: [...DEFAULT_WAKE_PHRASES],
      paused: wakePaused.size > 0,
      state: wakeInfo.state,
      detail: wakeInfo.detail,
      heard: wakeInfo.heard,
      ignored: wakeInfo.ignored,
      lastHeard: wakeInfo.lastHeard,
      lastHit: wakeInfo.lastHit,
    },
    pushToTalkStatus: {
      enabled: settings.pushToTalk && settings.hotkeyEnabled,
      ...(keyWatcher ? keyWatcher.info() : { supported: false, ready: false, down: false, problem: "off", keys: [] }),
    },
    version: app.getVersion(),
    update: updater ? { ...updater.state } : null,
    hotkeyLabel: hotkeyLabel(settings.hotkey),
    hotkeyRegistered: hotkeyState.registered,
    hotkeyError: hotkeyState.error,
    hotkeyChoices: HOTKEY_CHOICES.map((c) => ({ ...c })),
  };
}

function updateSettings(patch) {
  const before = settings;
  settings = applySettingsPatch(settings, patch);
  if (settings.hotkey !== before.hotkey || settings.hotkeyEnabled !== before.hotkeyEnabled) applyHotkey();
  if (settings.pushToTalk !== before.pushToTalk || settings.hotkey !== before.hotkey || settings.hotkeyEnabled !== before.hotkeyEnabled) applyPushToTalk();
  if (settings.wakeEnabled !== before.wakeEnabled) applyWakeSetting();
  if (settings.openAtLogin !== before.openAtLogin && supportsLoginItems()) {
    try {
      app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, ...loginItemOptions() });
    } catch (err) {
      console.warn("[soundwave-desktop] could not change the login item:", err.message);
    }
  }
  saveSettings(settingsFile, settings);
  refreshTrayMenu();
  return publicState();
}

// ── Main window ──────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: "#0a0e17",
    title: APP_NAME,
    autoHideMenuBar: true,
    icon: ICON_PNG,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Hidden in the tray the page is throttled like any background tab (no
      // wasted CPU); render progress arrives over SSE regardless.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  mainWindow.setMenuBarVisibility(false);
  // The page's own <title> would rename the window ("… — Command Center"). The
  // owner's build says which build it is and keeps saying it; the sold build
  // keeps the page's own title, exactly as it always has.
  if (EDITION.id !== "retail") mainWindow.on("page-title-updated", (e) => e.preventDefault());
  lockNavigation(mainWindow);

  // Closing the window keeps Soundwave in the tray (shortcut, renders and
  // notifications keep working) unless that's turned off.
  mainWindow.on("close", (event) => {
    if (isQuitting || !settings.closeToTray || !tray) return;
    event.preventDefault();
    mainWindow.hide();
    if (!settings.trayHintShown) {
      settings = { ...settings, trayHintShown: true };
      saveSettings(settingsFile, settings);
      notify({
        title: `${APP_NAME} is still running`,
        body: settings.hotkeyEnabled
          ? `Press ${hotkeyLabel(settings.hotkey)} to talk to it from any app. Right-click the tray icon to quit.`
          : "It keeps working in the tray. Right-click the tray icon to quit.",
      });
    }
  });
  // Windows is signing out / shutting down: really close (don't hide to the tray).
  mainWindow.on("session-end", () => {
    isQuitting = true;
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    // Tray mode off (or quitting): closing the window ends the app.
    if (!isQuitting) app.quit();
  });
  return mainWindow;
}

function showMainWindow(route) {
  if (!alive(mainWindow)) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  const target = safeRoute(route);
  if (target) mainWindow.webContents.send("soundwave:navigate", target);
}

// ── Voice bar (overlay) ──────────────────────────────────────────────────────

function createOverlayWindow() {
  if (alive(overlayWindow) || !serverUrl) return;
  overlayListening = false;
  overlayWindow = new BrowserWindow({
    width: OVERLAY_SIZE.width,
    height: OVERLAY_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never steals focus from the app you're in (clicks still work).
    focusable: false,
    hasShadow: false,
    title: `${APP_NAME} — Voice`,
    icon: ICON_PNG,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  lockNavigation(overlayWindow);
  overlayWindow.on("closed", () => {
    overlayWindow = null;
    overlayListening = false;
  });
  overlayWindow.webContents.on("render-process-gone", () => {
    // Rebuilt on the next shortcut press.
    if (alive(overlayWindow)) overlayWindow.destroy();
  });
  overlayWindow.loadURL(`${serverUrl}/overlay`).catch((err) => console.warn("[soundwave-desktop] voice bar failed to load:", err.message));
}

function positionOverlay() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  overlayWindow.setBounds(overlayBounds(display.workArea, OVERLAY_SIZE));
}

function sendToOverlay(command) {
  if (overlayListening && alive(overlayWindow)) overlayWindow.webContents.send("soundwave:voice", command);
  else pendingVoice.push(command);
}

/** The wake phrase was heard with words after it: hand the overlay something to ask. */
function sendWakeHit(payload) {
  // The overlay may still be loading (first wake after startup): keep the last
  // one until it says it's ready.
  if (!alive(overlayWindow) || !overlayListening) {
    pendingWake = payload;
    return;
  }
  try {
    overlayWindow.webContents.send("soundwave:wake-hit", payload);
  } catch {
    /* window going away */
  }
}

function toggleVoiceBar() {
  if (!alive(overlayWindow)) createOverlayWindow();
  if (!alive(overlayWindow)) return;
  if (!overlayWindow.isVisible()) {
    positionOverlay();
    overlayWindow.showInactive();
  }
  sendToOverlay("toggle");
}

function hideOverlay() {
  if (alive(overlayWindow) && overlayWindow.isVisible()) overlayWindow.hide();
  setTrayTooltip("idle");
  // The bar is away: the wake listener may listen again (with a short grace).
  setWakePaused("voice", false);
}

/** Show the voice bar without telling it anything yet. */
function showVoiceBar() {
  if (!alive(overlayWindow)) createOverlayWindow();
  if (!alive(overlayWindow)) return false;
  if (!overlayWindow.isVisible()) {
    positionOverlay();
    overlayWindow.showInactive();
  }
  return true;
}

// ── "Hey Soundwave" — the hidden listener ────────────────────────────────────

function createWakeWindow() {
  if (alive(wakeWindow) || !serverUrl) return;
  wakeWindow = new BrowserWindow({
    ...WAKE_SIZE,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: `${APP_NAME} — wake word`,
    icon: ICON_PNG,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: "no-user-gesture-required",
      // A hidden window must keep its microphone running — no timer throttling.
      backgroundThrottling: false,
    },
  });
  lockNavigation(wakeWindow);
  wakeInfo = { state: "starting", detail: null, heard: 0, ignored: 0, lastHeard: null, lastHit: null, hitAt: null };
  wakeWindow.on("closed", () => {
    wakeWindow = null;
  });
  wakeWindow.webContents.on("render-process-gone", () => {
    if (alive(wakeWindow)) wakeWindow.destroy();
  });
  wakeWindow.loadURL(`${serverUrl}/wake`).catch((err) => console.warn("[soundwave-desktop] wake listener failed to load:", err.message));
}

function destroyWakeWindow() {
  const win = wakeWindow;
  wakeWindow = null;
  wakePaused.clear();
  if (wakeResumeTimer) clearTimeout(wakeResumeTimer);
  wakeResumeTimer = null;
  if (alive(win)) win.destroy();
}

/** Pause/resume the listener: never listen while it is itself talking or recording. */
function setWakePaused(reason, paused) {
  const before = wakePaused.size > 0;
  if (paused) wakePaused.add(reason);
  else wakePaused.delete(reason);
  const now = wakePaused.size > 0;
  if (now === before) return;
  if (wakeResumeTimer) clearTimeout(wakeResumeTimer);
  wakeResumeTimer = null;
  if (now) {
    sendToWake("pause");
    return;
  }
  // A moment's grace so the tail of the assistant's own voice isn't transcribed.
  wakeResumeTimer = setTimeout(() => sendToWake("resume"), 1200);
  wakeResumeTimer.unref?.();
}

function sendToWake(command) {
  if (alive(wakeWindow)) {
    try {
      wakeWindow.webContents.send("soundwave:wake-control", command);
    } catch {
      /* window going away */
    }
  }
}

/** The setting decides whether the listener exists at all. */
function applyWakeSetting() {
  if (settings.wakeEnabled) createWakeWindow();
  else destroyWakeWindow();
}

/** What the wake listener said it heard (from the hidden page, after whisper). */
function onWakeHeard(text) {
  const said = String(text ?? "").trim().slice(0, 600);
  if (!said) return;
  wakeInfo.heard += 1;
  wakeInfo.lastHeard = said.slice(0, 200);
  const hit = wakeHit(said);
  if (!hit.hit) {
    wakeInfo.ignored += 1;
    return; // ordinary speech: transcribed on this PC, then thrown away
  }
  // If the bar is already up (the person is holding the shortcut, or the agent
  // is answering), the phrase was aimed at that conversation — not a new wake.
  if (overlayWindow && alive(overlayWindow) && overlayWindow.isVisible()) {
    wakeInfo.ignored += 1;
    return;
  }
  if (wakePaused.size > 0) {
    wakeInfo.ignored += 1;
    return;
  }
  wakeInfo.lastHit = hit.command ? `“${hit.command}”` : "“Hey Soundwave”";
  wakeInfo.hitAt = Date.now();
  if (!showVoiceBar()) return;
  if (hit.command) sendWakeHit({ text: hit.command });
  else sendToOverlay("wake-listen");
}

// ── Push-to-talk: hold the shortcut (or the mic) and speak ───────────────────

/** The shortcut was tapped (or the watcher isn't there): listen, then send by itself. */
function tapVoiceShortcut() {
  if (!showVoiceBar()) return;
  sendToOverlay("hold-start");
  setTimeout(() => {
    // A real hold is still down — its own release is coming, leave it alone.
    if (keyWatcher && keyWatcher.isDown()) return;
    sendToOverlay("hold-end");
  }, 250).unref?.();
}

function startPushToTalk() {
  if (!showVoiceBar()) return;
  sendToOverlay("hold-start");
}

function endPushToTalk() {
  sendToOverlay("hold-end");
}

/** Arm or disarm the key watcher for the current settings. */
function applyPushToTalk() {
  const wanted = settings.pushToTalk && settings.hotkeyEnabled;
  const codes = wanted ? vkCodesFor(settings.hotkey) : null;
  if (keyWatcher && (!wanted || keyWatcher.info().keys.join(",") !== (codes ?? []).join(","))) {
    keyWatcher.stop();
    keyWatcher = null;
  }
  if (!wanted || keyWatcher) return;
  keyWatcher = createKeyWatcher({
    accelerator: settings.hotkey,
    onDown: () => startPushToTalk(),
    onUp: () => endPushToTalk(),
    onProblem: (message) => console.warn(`[soundwave-desktop] hold-to-talk: ${message}`),
  });
  keyWatcher.start();
}

/** The voice shortcut: the key watcher when hold-to-talk is on, otherwise a tap. */
function onVoiceShortcut() {
  if (keyWatcher?.info().supported) {
    if (keyWatcher.isDown()) return; // the watcher's own press/release drives it
    tapVoiceShortcut();
    return;
  }
  if (alive(mainWindow) && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized()) {
    mainWindow.webContents.send("soundwave:voice", "toggle");
    return;
  }
  toggleVoiceBar();
}

function applyHotkey() {
  globalShortcut.unregisterAll();
  hotkeyState = { registered: false, error: null };
  if (!settings.hotkeyEnabled) return;
  const label = hotkeyLabel(settings.hotkey);
  try {
    const ok = globalShortcut.register(settings.hotkey, onVoiceShortcut);
    hotkeyState = ok
      ? { registered: true, error: null }
      : { registered: false, error: `${label} is already used by another app. Pick a different shortcut in Settings → Voice & Desktop.` };
  } catch (err) {
    hotkeyState = { registered: false, error: `${label} can't be used as a shortcut (${err.message}).` };
  }
}

// ── Tray ─────────────────────────────────────────────────────────────────────

function setTrayTooltip(state) {
  if (!tray) return;
  tray.setToolTip(
    state === "listening"
      ? `${APP_NAME} — listening…`
      : state === "working"
        ? `${APP_NAME} — thinking…`
        : settings.wakeEnabled
          ? `${APP_NAME} — say “${DEFAULT_WAKE_PHRASES[0]}”`
          : APP_NAME,
  );
}

function refreshTrayMenu() {
  if (!tray) return;
  const shortcut = settings.hotkeyEnabled && hotkeyState.registered ? `  (${hotkeyLabel(settings.hotkey)})` : "";
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => showMainWindow() },
      { label: `Talk to Soundwave${shortcut}`, click: () => toggleVoiceBar() },
      { label: "Generate a short", click: () => showMainWindow("/agent?tab=generator") },
      { type: "separator" },
      ...(supportsLoginItems()
        ? [{ label: "Start with Windows", type: "checkbox", checked: settings.openAtLogin, click: (item) => updateSettings({ openAtLogin: item.checked }) }]
        : []),
      {
        label: "Keep running in the tray when closed",
        type: "checkbox",
        checked: settings.closeToTray,
        click: (item) => updateSettings({ closeToTray: item.checked }),
      },
      {
        label: `Hold ${hotkeyLabel(settings.hotkey)} to talk`,
        type: "checkbox",
        checked: settings.pushToTalk && settings.hotkeyEnabled,
        enabled: settings.hotkeyEnabled,
        click: (item) => updateSettings({ pushToTalk: item.checked }),
      },
      {
        label: `Wake word — “${DEFAULT_WAKE_PHRASES[0]}”`,
        type: "checkbox",
        checked: settings.wakeEnabled,
        click: (item) => updateSettings({ wakeEnabled: item.checked }),
      },
      { label: "Voice & desktop settings…", click: () => showMainWindow("/settings/voice") },
      { label: "Connect your phone…", click: () => showMainWindow("/settings/phone") },
      { type: "separator" },
      {
        label: `Quit ${APP_NAME}`,
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  try {
    const image = nativeImage.createFromPath(process.platform === "win32" ? ICON_ICO : ICON_PNG);
    tray = new Tray(image.isEmpty() ? nativeImage.createFromPath(ICON_PNG) : image);
  } catch (err) {
    console.warn("[soundwave-desktop] no tray icon:", err.message);
    tray = null;
    return;
  }
  setTrayTooltip("idle");
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
  refreshTrayMenu();
}

// ── Notifications ────────────────────────────────────────────────────────────

function notify({ title, body, route }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body || "", icon: ICON_PNG, silent: false });
  // Keep a reference until it's dismissed — otherwise the click handler can be
  // garbage-collected on Windows.
  liveNotifications.add(n);
  const release = () => liveNotifications.delete(n);
  n.on("click", () => {
    release();
    showMainWindow(route || undefined);
  });
  n.on("close", release);
  n.on("failed", release);
  n.show();
  setTimeout(release, 10 * 60_000).unref?.();
}

// ── Updates ─────────────────────────────────────────────────────────────────
// Edition-aware and quiet (src/update.cjs): the sold build follows the public
// `latest` feed, the Dev build its own `dev` channel, and neither can be
// pointed at the other. Nobody is ever interrupted — the window is told, and
// the restart is theirs to choose.

let updater = null;

function startUpdates() {
  try {
    updater = createAutoUpdater({ app, editionId: currentEdition().id });
  } catch (err) {
    console.warn("[soundwave-desktop] updates are off:", err && err.message ? err.message : err);
    updater = null;
    return;
  }
  if (!updater) return;
  updater.onStatus((state) => {
    if (!alive(mainWindow)) return;
    try {
      mainWindow.webContents.send("soundwave:update", state);
    } catch {
      /* the window went away between the check and the send */
    }
    // One notification, the first time a download lands — not on every tick.
    if (state.status === "ready" && settings.notifications && state.available && lastReadyVersion !== state.available) {
      lastReadyVersion = state.available;
      notify({ title: `${APP_NAME} ${state.available} is ready`, body: "It goes in the next time you restart — or press Restart now in Settings.", route: "/settings/preferences" });
    }
  });
  updater.start();
}

let lastReadyVersion = null;

// ── IPC from the app's pages (preload.cjs) ──────────────────────────────────

function registerIpc() {
  ipcMain.handle("soundwave:get-state", (event) => (trusted(event) ? publicState() : null));
  ipcMain.handle("soundwave:check-update", async (event) => {
    if (!trusted(event) || !updater) return null;
    await updater.checkNow();
    return { ...updater.state };
  });
  // Restarting into the new version is deliberate, so it comes from a press.
  ipcMain.handle("soundwave:install-update", (event) => (trusted(event) ? Boolean(updater && updater.installNow()) : false));
  ipcMain.handle("soundwave:update-settings", (event, patch) => (trusted(event) ? updateSettings(patch) : null));
  ipcMain.handle("soundwave:start-local-voice-setup", (event) => {
    if (!trusted(event) || !kokoroManager) return false;
    void kokoroManager.start();
    return true;
  });
  ipcMain.handle("soundwave:cancel-kokoro-setup", (event) => (trusted(event) ? Boolean(kokoroManager?.cancelSetup()) : false));
  ipcMain.handle("soundwave:retry-kokoro-setup", (event) => (trusted(event) ? (kokoroManager?.retrySetup() ?? false) : false));
  // Sign-in: open the Google page in the person's own browser (never an
  // embedded window — Google blocks those). http(s) only.
  ipcMain.handle("soundwave:open-external", async (event, url) => {
    if (!trusted(event)) return false;
    try {
      const parsed = new URL(String(url));
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      await shell.openExternal(parsed.toString());
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle("soundwave:is-app-focused", (event) => {
    if (!trusted(event)) return false;
    return alive(mainWindow) && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized();
  });
  ipcMain.on("soundwave:voice-listener", (event) => {
    if (!trusted(event) || !alive(overlayWindow) || event.sender !== overlayWindow.webContents) return;
    overlayListening = true;
    const queued = pendingVoice;
    pendingVoice = [];
    for (const command of queued) overlayWindow.webContents.send("soundwave:voice", command);
    if (pendingWake) {
      const payload = pendingWake;
      pendingWake = null;
      overlayWindow.webContents.send("soundwave:wake-hit", payload);
    }
  });
  ipcMain.on("soundwave:notify", (event, payload) => {
    if (!trusted(event) || !settings.notifications) return;
    const n = sanitizeNotification(payload);
    if (n) notify(n);
  });
  ipcMain.on("soundwave:show-app", (event, route) => {
    if (trusted(event)) showMainWindow(route);
  });
  ipcMain.on("soundwave:hide-overlay", (event) => {
    if (trusted(event)) hideOverlay();
  });
  ipcMain.on("soundwave:voice-state", (event, payload) => {
    if (!trusted(event)) return;
    // Older senders passed the state as a bare string; the shape is tolerated
    // either way so a window and the shell can never disagree about a version.
    const state = typeof payload === "string" ? payload : payload?.state;
    const source = typeof payload === "string" ? "voice" : payload?.source;
    if (state !== "idle" && state !== "listening" && state !== "working") return;
    setTrayTooltip(state);
    // While Soundwave is listening or answering, the wake listener stays quiet:
    // it must never transcribe the person's own push-to-talk, or its own voice.
    // Two windows report this independently — the voice bar ("voice", which also
    // covers the speaking that follows) and the Command Center's own mic
    // ("mic") — so each keeps its own reason and neither cancels the other.
    setWakePaused(source === "mic" ? "mic" : "voice", state !== "idle");
  });
  ipcMain.on("soundwave:wake-state", (event, payload) => {
    if (!trusted(event) || !alive(wakeWindow) || event.sender !== wakeWindow.webContents) return;
    const state = payload && typeof payload.state === "string" ? payload.state : "unknown";
    wakeInfo.state = state.slice(0, 40);
    wakeInfo.detail = payload && typeof payload.detail === "string" ? payload.detail.slice(0, 300) : null;
    refreshTrayMenu();
  });
  ipcMain.on("soundwave:wake-heard", (event, payload) => {
    if (!trusted(event) || !alive(wakeWindow) || event.sender !== wakeWindow.webContents) return;
    onWakeHeard(payload && payload.text);
  });
  ipcMain.on("soundwave:open-mic-settings", (event) => {
    if (!trusted(event)) return;
    if (process.platform === "win32") shell.openExternal("ms-settings:privacy-microphone").catch(() => {});
  });
}

/** Microphone (audio only), notifications etc. — for the app's own origin only. */
function restrictPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || webContents.getURL();
    if (!isAppUrl(url)) return callback(false);
    if (permission === "media") {
      const types = (details && details.mediaTypes) || [];
      return callback(types.every((t) => t === "audio"));
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_webContents, _permission, requestingOrigin) => isAppUrl(requestingOrigin || ""));
}

// ── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  // Single instance — a second launch shows the running window.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showMainWindow());
  if (process.platform === "win32") app.setAppUserModelId(APP_ID);

  const appRoot = path.join(__dirname, "..", "app");
  const binDir = app.isPackaged ? path.join(process.resourcesPath, "bin") : path.join(__dirname, "..", "bin");
  const userDataDir = app.getPath("userData");

  settingsFile = path.join(userDataDir, "desktop-settings.json");
  settings = loadSettings(settingsFile);
  if (supportsLoginItems()) {
    try {
      settings = { ...settings, openAtLogin: app.getLoginItemSettings(loginItemOptions()).openAtLogin };
    } catch {
      /* keep the saved value */
    }
  }

  const { appUrl, port: appPort } = await applyServerEnv({ appRoot, binDir, userDataDir, autoUpdateYtDlp: true });

  // The packaged Windows app owns a hidden CPU-only voice sidecar: Kokoro
  // narration plus MOSS-TTS-Nano cloning. Setup starts automatically a few
  // seconds after launch and runs invisibly; an explicitly configured service is never replaced. Keep its
  // port distinct from the app API's already-allocated loopback port.
  try {
    kokoroManager = await createManagedKokoro({
      enabled: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      env: process.env,
      resourcesDir: app.isPackaged ? path.join(process.resourcesPath, "voiceclone") : path.join(__dirname, "..", "..", "voiceclone"),
      userDataDir,
      getFreePort: async () => {
        for (let attempt = 0; attempt < 10; attempt++) {
          const candidate = await getFreePort();
          if (candidate !== appPort) return candidate;
        }
        throw new Error("Could not allocate a separate loopback port for the local voice service.");
      },
    });
    if (kokoroManager) {
      process.env.LOCAL_VOICE_URL = kokoroManager.url;
      process.env.LOCAL_VOICE_TOKEN = kokoroManager.token;
      process.env.LOCAL_VOICE_STATUS_FILE = kokoroManager.statusFile;
      process.env.VOICECLONE_URL = kokoroManager.url;
      process.env.VOICECLONE_TOKEN = kokoroManager.token;
    }
  } catch (err) {
    // On-device narration/cloning are optional; a setup-manager hiccup must
    // not stop the desktop app or its regular Microsoft neural voices.
    console.warn("[soundwave-desktop] could not prepare the local voice service:", err.message);
    kokoroManager = null;
  }

  serverUrl = appUrl;
  appOrigin = new URL(appUrl).origin;
  restrictPermissions();
  registerIpc();

  // Updates (src/update.cjs): the first check is a minute out, so it never
  // competes with start-up, and nobody is ever interrupted mid-edit.
  startUpdates();

  // Set up the on-device voices (Kokoro narration + voice cloning) in the
  // background — including the first launch straight after the installer —
  // instead of waiting for someone to find the voice page, and restart the
  // service on every later launch. Nobody has to press anything; failures
  // retry by themselves (see kokoro-manager.cjs). A short delay keeps window
  // creation and the server's own start-up ahead of the Python work.
  if (kokoroManager) {
    setTimeout(() => {
      if (kokoroManager) void kokoroManager.start();
    }, 1_200).unref?.();
  }

  // The agent's hands on this PC (server/src/lib/brain/pc.ts): it opens web
  // pages in the default browser, Start menu shortcuts, and — for the Ghost
  // Operator macros — the clipboard and Windows notifications. http(s) only,
  // the server checks before asking.
  globalThis.__soundwaveDesktopHost = {
    openExternal: (url) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("only web pages can be opened");
      return shell.openExternal(parsed.toString());
    },
    openPath: (target) => shell.openPath(target),
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(String(text ?? "")),
    // Returns false when the user turned notifications off (Settings → Voice & Desktop).
    notify: (payload) => {
      if (!settings.notifications) return false;
      const n = sanitizeNotification(payload);
      if (!n) return false;
      notify(n);
      return true;
    },
    showWindow: () => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) {
        if (typeof win.showInactive === "function") win.showInactive();
        else win.show();
      }
    },
    /**
     * The agent's eyes (server/src/lib/screen.ts): one PNG of the screen the
     * Soundwave window is on, plus which display it was. This is what answers
     * "what does this error say?". Read-only — nothing is clicked, nothing is
     * written to disk — and the picture is only ever sent to the person's own
     * Gemini key for that one question. A locked screen or a refused permission
     * comes back empty and the agent says so instead of guessing.
     */
    captureScreen: async () => {
      const win = mainWindow;
      const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
      const size = display.size;
      // Gemini reads a ~2 MP picture as well as a 4K one, and faster: scale the
      // long edge down to 1920 px at most, keeping the aspect ratio.
      const scale = Math.min(1, 1920 / Math.max(size.width, size.height));
      const thumbnailSize = {
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      };
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
      if (!sources || !sources.length) return null;
      const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      const png = source.thumbnail.toPNG();
      if (!png || png.length < 1000) return null;
      const read = source.thumbnail.getSize();
      return {
        png,
        width: read.width,
        height: read.height,
        display: `${source.name ? String(source.name) : `Display ${display.id}`} (${size.width}×${size.height})`,
      };
    },
  };

  // Import the bundled server (ESM) — this starts listening on loopback.
  await import(pathToFileURL(path.join(appRoot, "server", "dist", "index.js")).href);
  serverStarted = true;

  createTray();
  applyHotkey();
  refreshTrayMenu();

  const win = createMainWindow();
  const healthy = await pollHealth(appUrl, 45_000);
  if (!healthy) {
    console.error("[soundwave-desktop] server health check timed out; loading anyway");
  }
  await win.loadURL(appUrl);
  if (!START_HIDDEN || !tray) win.show();

  // Get the voice bar ready in the background so the first shortcut press is instant.
  setTimeout(createOverlayWindow, 1500);
  // "Hey Soundwave" and hold-to-talk: both need their machinery warm (the
  // listener's microphone, the key watcher's compiled key-state call).
  applyWakeSetting();
  applyPushToTalk();

  if (settings.hotkeyEnabled && !hotkeyState.registered && hotkeyState.error) {
    notify({ title: "Voice shortcut unavailable", body: hotkeyState.error, route: "/settings/voice" });
  }
}

// Debug/test handle for the main process (desktop/e2e.mjs drives it through
// Playwright's electronApp.evaluate). Not reachable from web pages.
globalThis.__soundwaveShell = {
  voiceShortcut: () => onVoiceShortcut(),
  toggleVoiceBar: () => toggleVoiceBar(),
  state: () => ({
    serverUrl,
    tray: Boolean(tray),
    hotkey: publicState(),
    mainVisible: alive(mainWindow) && mainWindow.isVisible(),
    overlayVisible: alive(overlayWindow) && overlayWindow.isVisible(),
    overlayListening,
    wake: {
      enabled: settings.wakeEnabled,
      running: alive(wakeWindow),
      phrases: [...DEFAULT_WAKE_PHRASES],
      paused: wakePaused.size > 0,
      ...wakeInfo,
    },
    pushToTalkStatus: {
      enabled: settings.pushToTalk && settings.hotkeyEnabled,
      ...(keyWatcher ? keyWatcher.info() : { supported: false, ready: false, down: false, problem: "off", keys: [] }),
    },
  }),
  mainWindow: () => mainWindow,
  overlayWindow: () => overlayWindow,
  wakeWindow: () => wakeWindow,
  /** Tests: pretend the wake listener heard this (already transcribed on the PC). */
  heardWake: (text) => onWakeHeard(text),
};

app.whenReady().then(() =>
  main().catch((err) => {
    console.error("[soundwave-desktop] fatal:", err);
    dialog.showErrorBox(
      `${APP_NAME} couldn't start`,
      `${err && err.message ? err.message : String(err)}\n\n` +
        "Try restarting the app. If it keeps happening, reinstalling the app usually fixes it.",
    );
    isQuitting = true;
    app.quit();
  }),
);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  // Stop the supervised local service when Soundwave quits; setup downloads and
  // the service itself never keep running as an orphan process.
  kokoroManager?.stop();
  // Server runs in-process — quitting the app stops the API with it.
  if (serverStarted) console.log("[soundwave-desktop] shutting down");
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  keyWatcher?.stop();
  keyWatcher = null;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
