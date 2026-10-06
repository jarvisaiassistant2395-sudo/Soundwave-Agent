// ── Formatting helpers ──────────────────────────────────────────────────────
// Small, pure, and shown to the customer on nearly every screen (a video's
// length, a clip's size, how much of the month's quota is gone). These are the
// edge cases the UI actually hits: a clip that has not been probed yet (0 or
// NaN duration), and a name with one part.
import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatNumber, formatPercent, initials, truncate } from "./format";

describe("formatDuration", () => {
  it("shows minutes:seconds under an hour, and pads the seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9)).toBe("0:09");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(3599)).toBe("59:59");
  });

  it("shows hours once there is one, with padded minutes", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3725)).toBe("1:02:05");
  });

  it("does not print NaN or negative lengths", () => {
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(formatDuration(-5)).toBe("0:00");
  });
});

describe("formatBytes", () => {
  it("scales and rounds the way a file size should read", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(125 * 1024 * 1024)).toBe("125 MB");
  });

  it("treats a missing size as zero rather than NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatNumber / formatPercent", () => {
  it("groups thousands and rounds", () => {
    expect(formatNumber(1234.6)).toBe("1,235");
  });

  it("turns a fraction into whole percent — including a full quota", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.25)).toBe("25%");
    expect(formatPercent(1)).toBe("100%");
  });
});

describe("truncate / initials", () => {
  it("only adds an ellipsis when it actually cut something", () => {
    expect(truncate("short", 20)).toBe("short");
    expect(truncate("a longer title here", 10)).toBe("a longer\u2026");
    // The result is never longer than `max`, ellipsis included; the cut trims
    // the space it lands on rather than leaving "a longer \u2026".
    // No trailing space before the ellipsis when the cut lands on one.
    expect(truncate("hello world again", 6)).toBe("hello\u2026");
  });

  it("takes one letter from one name and two from two", () => {
    expect(initials("  ")).toBe("?");
    expect(initials("Madonna")).toBe("M");
    expect(initials("Ada Lovelace")).toBe("AL");
    // Middle names are ignored, the surname still counts.
    expect(initials("Ada King Lovelace")).toBe("AL");
  });
});
