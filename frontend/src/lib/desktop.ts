// ── The Windows desktop app's bridge ────────────────────────────────────────
// desktop/src/preload.cjs exposes `window.soundwaveDesktop` (contextBridge) to
// the app's own pages. In a normal browser it's absent and every caller falls
// back to web behaviour.

export interface DesktopSettings {
  /** Electron accelerator for the global voice shortcut, e.g. "Control+Shift+Space". */
  hotkey: string;
  hotkeyEnabled: boolean;
  /** Hold the shortcut and talk — releasing it sends. */
  pushToTalk: boolean;
  /** Say "Hey Soundwave" and it listens (recognized on this PC, nothing uploaded). */
  wakeEnabled: boolean;
  /** Closing the window keeps the app (hotkey, notifications, renders) running in the tray. */
  closeToTray: boolean;
  /** Start with Windows (in the tray). */
  openAtLogin: boolean;
  /** Windows notifications when a short is ready / fails. */
  notifications: boolean;
  /**
   * Opt-in, off by default: when the shell crashes, send the error and the log
   * tail to the vendor's endpoint. Never keys, files or the person's name.
   */
  crashReports: boolean;
  /** Opt-in, off by default: one anonymous line per launch (version, OS — no id). */
  startPing: boolean;
}

/** What the opt-in reporter is doing (desktop/src/reporter.cjs). */
export interface DesktopReportingState {
  /** False when this build (or this machine) has no endpoint to send to. */
  configured: boolean;
  crashReports: boolean;
  startPing: boolean;
  /** Reports written down but not yet delivered; sent on the next launch. */
  queued: number;
  sent: { crash: number; start: number; diagnostics: number; failed: number; queued: number };
}

/** What the hidden wake listener is doing (Settings shows this). */
export interface WakeListenerStatus {
  enabled: boolean;
  running: boolean;
  /** "Hey Soundwave" — the phrases that wake it. */
  phrases: string[];
  paused: boolean;
  state: "starting" | "listening" | "paused" | "off" | "error";
  detail: string | null;
  /** How many utterances were transcribed on this PC, and how many were ignored. */
  heard: number;
  ignored: number;
  lastHeard: string | null;
  lastHit: string | null;
}

/** Hold-to-talk: the Windows key watcher that knows when you let go. */
export interface PushToTalkStatus {
  enabled: boolean;
  supported: boolean;
  ready: boolean;
  down: boolean;
  problem: string | null;
  keys: number[];
}

/** Auto-update, as the shell sees it (desktop/src/update.cjs). */
export interface DesktopUpdateState {
  /** False in a source checkout, for the Dev build with no feed of its own, and when the edition/channel disagree. */
  enabled: boolean;
  edition: "retail" | "personal" | string;
  /** "latest" for the sold build, "dev" for the Dev build — the two never cross. */
  channel: "latest" | "dev" | null;
  feed: string;
  status: "off" | "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "failed";
  version: string | null;
  /** The version being downloaded / waiting for a restart. */
  available: string | null;
  progress: number;
  /** Quiet: offline and "the feed isn't there yet" both land here. */
  error: string | null;
  lastCheck: number | null;
}

export interface DesktopState extends DesktopSettings {
  wake: WakeListenerStatus;
  /** What the opt-in reporter is doing — and whether this build can send at all. */
  reporting: DesktopReportingState;
  /** Null in a browser, or on a shell too old to know about updates. */
  update: DesktopUpdateState | null;
  /** The key watcher's state (the setting itself is `pushToTalk`). */
  pushToTalkStatus: PushToTalkStatus;
  version: string;
  hotkeyLabel: string;
  hotkeyRegistered: boolean;
  hotkeyError: string | null;
  hotkeyChoices: Array<{ accelerator: string; label: string }>;
}

/** Sent by the desktop shell when the voice shortcut / tray "Talk" is used. */
export type VoiceCommand = "toggle" | "start" | "stop" | "cancel";

export interface DesktopNotification {
  title: string;
  body?: string;
  /** In-app route opened when the notification is clicked. */
  route?: string;
}

export interface SoundwaveDesktop {
  readonly isDesktop: true;
  getState(): Promise<DesktopState>;
  updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopState>;
  /** Start the managed local narration/cloning setup on first use. */
  startLocalVoiceSetup(): Promise<boolean>;
  /** Stop the first-use local voice download/install without affecting cloud voices. */
  cancelKokoroSetup(): Promise<boolean>;
  /** Retry or repair local voice setup in this session, reusing verified downloads. */
  retryKokoroSetup(): Promise<boolean>;
  /** The main window is visible and focused. */
  isAppFocused(): Promise<boolean>;
  onVoiceCommand(callback: (command: VoiceCommand) => void): () => void;
  onNavigate(callback: (route: string) => void): () => void;
  /** The shell checked the feed in the background, or a download moved along. */
  onUpdate(callback: (state: DesktopUpdateState) => void): () => void;
  /** Ask the feed by hand — Settings has a button for this. */
  checkForUpdate(): Promise<DesktopUpdateState | null>;
  /** Restart into the downloaded version. False when there is nothing waiting. */
  installUpdate(): Promise<boolean>;
  /** Settings → Help: open the folder holding this install's log files. */
  openLogs(): Promise<boolean>;
  /** Settings → Help: a diagnostics block (versions, state, log tail) for support. */
  copyDiagnostics(): Promise<string | null>;
  /** Settings → Help: post that same block to the developer's endpoint, if this build has one. */
  sendDiagnostics(): Promise<{ sent: boolean; reason: string | null } | null>;
  notify(notification: DesktopNotification): void;
  showApp(route?: string): void;
  hideOverlay(): void;
  /**
   * What this window is doing with the microphone, so the shell can keep the
   * hidden wake listener quiet while Soundwave listens or answers. `source`
   * keeps two independent reporters from cancelling each other: the voice bar
   * ("voice") and the Command Center's own mic ("mic").
   */
  setVoiceState(state: "idle" | "listening" | "working", source?: "voice" | "mic"): void;
  openMicrophoneSettings(): void;
  /**
   * Open a web address in the person's own browser (the default one). Used by
   * sign-in: Google will not sign anyone in inside an embedded window.
   */
  openExternal(url: string): Promise<boolean>;
  /** The wake page: pause/resume the microphone (the shell does it while it talks). */
  onWakeControl(callback: (command: "pause" | "resume") => void): () => void;
  /** The wake page: what it is doing, for Settings and the tray. */
  wakeState(payload: { state: "starting" | "listening" | "paused" | "off" | "error"; detail?: string }): void;
  /** The wake page: what whisper.cpp heard on this PC. Ordinary speech is thrown away. */
  wakeHeard(payload: { text: string }): void;
  /** The voice bar: "Hey Soundwave, <this>" — answer it. */
  onWakeHit(callback: (payload: { text: string }) => void): () => void;
}

declare global {
  interface Window {
    soundwaveDesktop?: SoundwaveDesktop;
  }
}

export function getDesktop(): SoundwaveDesktop | null {
  if (typeof window === "undefined") return null;
  const bridge = window.soundwaveDesktop;
  return bridge && bridge.isDesktop ? bridge : null;
}

/**
 * Open a web address in the person's own browser. Sign-in has to happen there
 * (Google refuses embedded windows), so the desktop shell hands the URL to
 * Windows and a plain browser gets a normal new tab.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  const bridge = getDesktop();
  if (bridge) {
    try {
      return await bridge.openExternal(url);
    } catch {
      /* fall through to the browser's own behaviour */
    }
  }
  if (typeof window === "undefined") return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

export const DEFAULT_HOTKEY = "Control+Shift+Space";

/** "Control+Shift+Space" → "Ctrl+Shift+Space" */
export function hotkeyLabel(accelerator: string): string {
  return accelerator.replace(/\b(CommandOrControl|CmdOrCtrl|Control)\b/g, "Ctrl");
}
