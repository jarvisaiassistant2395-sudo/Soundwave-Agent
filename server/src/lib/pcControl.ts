// ── The PC's own settings the agent can really change: the sound ────────────
// Windows only, and honestly so: the volume/mute control is the same CoreAudio
// interface the taskbar's speaker icon uses (IAudioEndpointVolume, reached
// through PowerShell with an inline C# definition — no extra download, no
// third-party program). Absolute level and mute are exact; the agent reads the
// real value back after setting it, so "turned it down to 30%" is never a
// guess. On macOS/Linux the tool isn't offered at all and the agent says the
// sound can't be changed from here.
//
// The PowerShell source is built by a pure function so the exact call can be
// tested without Windows (CI runs on Linux, the packaged app on Windows).

import { execFile } from "node:child_process";

export interface VolumeState {
  /** 0–100, the real master level. */
  level: number;
  muted: boolean;
}

export function volumeSupported(platform: string = process.platform): boolean {
  return platform === "win32";
}

export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 50;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

const CSHARP = `
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr p);
  int UnregisterControlChangeNotify(IntPtr p);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float level, ref Guid ctx);
  int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float level, ref Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float level);
  int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  int GetMute(out bool mute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl1();
  int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

public static class SoundwaveAudio {
  static IAudioEndpointVolume Endpoint() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice device;
    if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0) throw new Exception("no audio device");
    var iid = typeof(IAudioEndpointVolume).GUID;
    object iface;
    if (device.Activate(ref iid, 1, IntPtr.Zero, out iface) != 0) throw new Exception("audio endpoint refused");
    return (IAudioEndpointVolume)iface;
  }
  public static void SetLevel(float scalar) { var g = Guid.Empty; var v = Endpoint(); if (v.SetMasterVolumeLevelScalar(scalar, ref g) != 0) throw new Exception("level refused"); }
  public static void SetMute(bool mute) { var g = Guid.Empty; var v = Endpoint(); if (v.SetMute(mute, ref g) != 0) throw new Exception("mute refused"); }
  public static string Report() {
    var v = Endpoint();
    float level;
    if (v.GetMasterVolumeLevelScalar(out level) != 0) throw new Exception("level unreadable");
    bool muted;
    if (v.GetMute(out muted) != 0) throw new Exception("mute unreadable");
    return (int)Math.Round(level * 100) + "|" + (muted ? "1" : "0");
  }
}
`.trim();

export type VolumeOp = { kind: "level"; percent: number } | { kind: "mute"; muted: boolean } | { kind: "read" };

/**
 * The exact PowerShell that runs. `-NoProfile -NonInteractive` keeps a person's
 * profile out of it; the C# is only compiled when it isn't loaded yet, which is
 * what keeps repeated calls fast.
 */
export function volumeScript(op: VolumeOp): string {
  const load = `if (-not ("SoundwaveAudio" -as [type])) { Add-Type -TypeDefinition @'\n${CSHARP}\n'@ }`;
  if (op.kind === "level") {
    const scalar = (clampPercent(op.percent) / 100).toFixed(4);
    return `${load}\n[SoundwaveAudio]::SetLevel([float]${scalar})\nWrite-Output ([SoundwaveAudio]::Report())`;
  }
  if (op.kind === "mute") {
    return `${load}\n[SoundwaveAudio]::SetMute($${op.muted ? "true" : "false"})\nWrite-Output ([SoundwaveAudio]::Report())`;
  }
  return `${load}\nWrite-Output ([SoundwaveAudio]::Report())`;
}

/** "62|0" → { level: 62, muted: false }. Anything else is a failure, not a zero. */
export function parseVolumeReport(raw: string): VolumeState | null {
  const m = /(\d{1,3})\s*\|\s*([01])/.exec(String(raw ?? ""));
  if (!m) return null;
  const level = Number(m[1]);
  if (!Number.isFinite(level) || level < 0 || level > 100) return null;
  return { level, muted: m[2] === "1" };
}

let powershell: string | null = null;

export function powershellPath(): string {
  if (powershell) return powershell;
  // Windows PowerShell is on every supported Windows; pwsh (PowerShell 7) when
  // it's installed is used first because it starts faster.
  powershell = process.env.SOUNDWAVE_POWERSHELL || "powershell.exe";
  return powershell;
}

export type VolumeRunner = (script: string) => Promise<string>;

const defaultRunner: VolumeRunner = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 20_000, windowsHide: true, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (String(stderr || err.message || "").trim().split("\n")[0] ?? "").slice(0, 160);
          reject(new Error(detail || "the sound control didn't answer"));
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });

/**
 * Runs one change and reads the result back. `runner` exists so the tests can
 * drive it without Windows: they assert the script and the parsing, and that an
 * unreadable answer fails instead of reporting a made-up level.
 */
export async function applyVolume(op: VolumeOp, runner: VolumeRunner = defaultRunner): Promise<VolumeState> {
  const out = await runner(volumeScript(op));
  const state = parseVolumeReport(out);
  if (!state) throw new Error("Windows didn't report a sound level back — nothing was changed as far as I can tell.");
  return state;
}

export function getVolume(runner: VolumeRunner = defaultRunner): Promise<VolumeState> {
  return applyVolume({ kind: "read" }, runner);
}

export function setVolume(percent: number, runner: VolumeRunner = defaultRunner): Promise<VolumeState> {
  return applyVolume({ kind: "level", percent }, runner);
}

export function setMuted(muted: boolean, runner: VolumeRunner = defaultRunner): Promise<VolumeState> {
  return applyVolume({ kind: "mute", muted }, runner);
}

/** A line a person reads: "the sound is at 40%", "…and it's muted". */
export function describeVolume(state: VolumeState): string {
  if (state.muted) return `The sound is muted (it was at ${state.level}%).`;
  if (state.level === 0) return "The sound is at 0% — nothing would be heard.";
  return `The sound is at ${state.level}%.`;
}
