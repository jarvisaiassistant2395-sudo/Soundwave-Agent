// Soundwave AI desktop — the bridge the app's own pages get as
// window.soundwaveDesktop (see frontend/src/lib/desktop.ts). Sandboxed
// preload: only contextBridge + ipcRenderer, and only these narrow calls.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") return () => undefined;
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("soundwaveDesktop", {
  isDesktop: true,
  getState: () => ipcRenderer.invoke("soundwave:get-state"),
  updateSettings: (patch) => ipcRenderer.invoke("soundwave:update-settings", patch),
  isAppFocused: () => ipcRenderer.invoke("soundwave:is-app-focused"),
  onVoiceCommand: (callback) => {
    const off = subscribe("soundwave:voice", callback);
    // Tells the shell this window is ready for shortcut presses (queued until then).
    ipcRenderer.send("soundwave:voice-listener");
    return off;
  },
  onNavigate: (callback) => subscribe("soundwave:navigate", callback),
  // "Hey Soundwave": the hidden wake page reports what whisper heard on this PC
  // and the shell decides whether the phrase was in it. The voice bar is told
  // when the phrase was heard with words after it.
  onWakeControl: (callback) => subscribe("soundwave:wake-control", callback),
  wakeState: (payload) => ipcRenderer.send("soundwave:wake-state", payload),
  wakeHeard: (payload) => ipcRenderer.send("soundwave:wake-heard", payload),
  onWakeHit: (callback) => subscribe("soundwave:wake-hit", callback),
  notify: (notification) => ipcRenderer.send("soundwave:notify", notification),
  showApp: (route) => ipcRenderer.send("soundwave:show-app", route),
  hideOverlay: () => ipcRenderer.send("soundwave:hide-overlay"),
  setVoiceState: (state, source) => ipcRenderer.send("soundwave:voice-state", { state, source }),
  openMicrophoneSettings: () => ipcRenderer.send("soundwave:open-mic-settings"),
});
