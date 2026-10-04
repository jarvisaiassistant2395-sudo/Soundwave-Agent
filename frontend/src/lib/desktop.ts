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

export interface DesktopState extends DesktopSettings {
  wake: WakeListenerStatus;
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
  /** Stop the first-run Kokoro download/install without affecting Soundwave voices. */
  cancelKokoroSetup(): Promise<boolean>;
  /** Retry or repair Kokoro setup in this session, reusing verified downloads. */
  retryKokoroSetup(): Promise<boolean>;
  /** The main window is visible and focused. */
  isAppFocused(): Promise<boolean>;
  onVoiceCommand(callback: (command: VoiceCommand) => void): () => void;
  onNavigate(callback: (route: string) => void): () => void;
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

export const DEFAULT_HOTKEY = "Control+Shift+Space";

/** "Control+Shift+Space" → "Ctrl+Shift+Space" */
export function hotkeyLabel(accelerator: string): string {
  return accelerator.replace(/\b(CommandOrControl|CmdOrCtrl|Control)\b/g, "Ctrl");
}
