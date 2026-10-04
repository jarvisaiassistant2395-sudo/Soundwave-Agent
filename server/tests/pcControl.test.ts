// ── The volume control: the exact PowerShell, and the real read-back ────────
// CI runs on Linux, the app on Windows — so the script and the parsing are
// pure and driven through an injected runner. The important assertion is the
// honesty one: an unreadable answer must fail instead of reporting a number.

import { describe, expect, it, vi } from "vitest";
import {
  clampPercent,
  describeVolume,
  getVolume,
  parseVolumeReport,
  setMuted,
  setVolume,
  volumeScript,
  volumeSupported,
} from "../src/lib/pcControl.js";

describe("what the machine can do", () => {
  it("offers the volume only on Windows", () => {
    expect(volumeSupported("win32")).toBe(true);
    expect(volumeSupported("darwin")).toBe(false);
    expect(volumeSupported("linux")).toBe(false);
  });

  it("keeps a level inside 0–100", () => {
    expect(clampPercent(120)).toBe(100);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(30.6)).toBe(31);
    expect(clampPercent(Number.NaN)).toBe(50);
  });
});

describe("the PowerShell it runs", () => {
  it("sets the level as a scalar and reads it straight back", () => {
    const script = volumeScript({ kind: "level", percent: 30 });
    expect(script).toContain("SetLevel([float]0.3000)");
    expect(script).toContain("[SoundwaveAudio]::Report()");
    expect(script).toContain("Add-Type -TypeDefinition");
  });

  it("mutes and unmutes", () => {
    expect(volumeScript({ kind: "mute", muted: true })).toContain("SetMute($true)");
    expect(volumeScript({ kind: "mute", muted: false })).toContain("SetMute($false)");
  });

  it("reads without changing anything", () => {
    // The C# interface declares SetMute/SetChannelVolumeLevel, so the check is
    // on what is actually invoked (the lines after the type definition).
    const action = (script: string) => script.slice(script.indexOf("'@ }") + 4);
    expect(action(volumeScript({ kind: "read" }))).toContain("Report()");
    expect(action(volumeScript({ kind: "read" }))).not.toContain("SetLevel(");
    expect(action(volumeScript({ kind: "read" }))).not.toContain("SetMute(");
    expect(action(volumeScript({ kind: "mute", muted: true }))).not.toContain("SetLevel(");
    expect(action(volumeScript({ kind: "level", percent: 30 }))).not.toContain("SetMute(");
  });
});

describe("reading the answer", () => {
  it("parses the real level and mute flag", () => {
    expect(parseVolumeReport("62|0")).toEqual({ level: 62, muted: false });
    expect(parseVolumeReport(" 7 | 1 \n")).toEqual({ level: 7, muted: true });
  });

  it("treats anything unreadable as a failure, not as zero", () => {
    expect(parseVolumeReport("")).toBeNull();
    expect(parseVolumeReport("Windows PowerShell error")).toBeNull();
    expect(parseVolumeReport("150|0")).toBeNull();
  });

  it("reports the value Windows gives back, never the one it asked for", async () => {
    const runner = vi.fn(async () => "42|0");
    expect(await setVolume(80, runner)).toEqual({ level: 42, muted: false });
    expect(runner.mock.calls[0]?.[0]).toContain("SetLevel([float]0.8000)");
  });

  it("does the mute and the read in one pass", async () => {
    const runner = vi.fn(async () => "55|1");
    expect(await setMuted(true, runner)).toEqual({ level: 55, muted: true });
    expect(runner.mock.calls[0]?.[0]).toContain("SetMute($true)");
  });

  it("fails loudly when PowerShell says nothing useful", async () => {
    const runner = async () => "something went wrong";
    await expect(getVolume(runner)).rejects.toThrow(/didn't report a sound level/i);
  });

  it("words the state for a person", () => {
    expect(describeVolume({ level: 40, muted: false })).toBe("The sound is at 40%.");
    expect(describeVolume({ level: 40, muted: true })).toBe("The sound is muted (it was at 40%).");
    expect(describeVolume({ level: 0, muted: false })).toBe("The sound is at 0% — nothing would be heard.");
  });
});
