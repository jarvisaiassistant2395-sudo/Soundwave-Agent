// The phone's own voice points at the emulator's stand-in only when the test
// put one in the app's own storage; a real phone (and the shipped app) always
// talks to Microsoft. These cover the seam, including a storage that throws.
import { afterEach, describe, expect, it } from "vitest";
import { testTtsUrl } from "./phoneVoice";

const KEY = "soundwave.test.ttsUrl";
const setStorage = (value: string | null | "throws") => {
  (globalThis as { localStorage?: unknown }).localStorage =
    value === "throws"
      ? { getItem: () => { throw new Error("storage is locked"); } }
      : { getItem: (k: string) => (k === KEY ? value : null) };
};

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the phone voice's test seam", () => {
  it("is off unless the test set it", () => {
    setStorage(null);
    expect(testTtsUrl()).toBeUndefined();
  });

  it("points the voice at the stand-in the emulator run started", () => {
    setStorage("ws://10.0.2.2:4200/consumer/speech/synthesize/readaloud/edge/v1");
    expect(testTtsUrl()).toBe("ws://10.0.2.2:4200/consumer/speech/synthesize/readaloud/edge/v1");
  });

  it("stays out of the way when there is no storage at all", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(testTtsUrl()).toBeUndefined();
    setStorage("throws");
    expect(testTtsUrl()).toBeUndefined();
  });
});
