import { describe, expect, it } from "vitest";
import { SpeechPlaybackError, speakable, speakableBriefing, speakLong, splitSpeech } from "./voice";

describe("what the phone reads aloud", () => {
  it("skips links and the background credits", () => {
    const text =
      'Rendered viral short for "space". Your video is ready to preview, download, or post to YouTube!\nBackground: "Parkour" (1:05–2:05) — Orbital NCG video imported via the YouTube link importer: https://www.youtube.com/watch?v=abc';
    expect(speakable({ text })).toBe('Rendered viral short for "space". Your video is ready to preview, download, or post to YouTube!');
    expect(speakable({ text: "Picking a video (https://www.youtube.com/@OrbitalNCG) now." })).toBe("Picking a video now.");
  });

  it("says short outcomes in a few words", () => {
    expect(speakable({ text: "long…", jobState: "done", topic: "black holes", youtubeUrl: "https://youtu.be/x" })).toBe(
      "Your short about black holes is ready, and it's up on YouTube.",
    );
    expect(speakable({ text: "long…", jobState: "failed", topic: "sharks" })).toBe("I couldn't finish the short about sharks.");
  });
});

describe("the morning briefing, read in full", () => {
  it("is cut into pieces at sentence ends, none longer than the voice service takes", () => {
    const sentence = "Ollama shipped a new release with faster local models and a fresh library. ";
    const long = sentence.repeat(60); // ~4500 characters
    const pieces = splitSpeech(long, 1800);
    expect(pieces.length).toBe(3);
    expect(pieces.every((p) => p.length <= 1800 && p.endsWith("."))).toBe(true);
    expect(pieces.join(" ")).toBe(long.trim());
  });

  it("reads a full reply, however long — a 3000-character explanation is not cut", () => {
    // The PC's YouTube walkthrough ran to thousands of characters; the phone
    // used to trim the spoken text at 700, so it stopped mid-explanation.
    const body = "Open the Soundwave settings on your PC and follow each step exactly as it is written here. ".repeat(34);
    const text = `Here is how to link your YouTube account. ${body}That is everything you need to do.`;
    const spoken = speakable({ text });
    expect(spoken.length).toBeGreaterThan(3000);
    expect(spoken.startsWith("Here is how to link your YouTube account.")).toBe(true);
    expect(spoken.endsWith("That is everything you need to do.")).toBe(true);
  });

  it("splits a long reply into voice-service-sized pieces without losing anything", () => {
    const text = `${"Step one is to open the settings page and follow the steps. ".repeat(40)}Done.`;
    const pieces = splitSpeech(text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 1200)).toBe(true);
    expect(pieces.join(" ")).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("keeps everything but links (no 700-character cut)", () => {
    const text = `${"Good morning! ".repeat(80)}See https://example.com for more.`;
    const spoken = speakableBriefing(text);
    expect(spoken.length).toBeGreaterThan(1000);
    expect(spoken).not.toMatch(/https?:/);
  });
});

// The phone that makes no sound is the one thing a briefing must not pretend
// about: a stuck player (it "plays" but never starts advancing) used to leave
// the bar up and the room silent — and every later piece was silent too.
describe("when the phone itself can't make a sound", () => {
  const piece = { audio: new Uint8Array([7]), mime: "audio/mpeg" };
  const synth = async () => piece;
  /** A briefing long enough to be read in several pieces (splitSpeech caps at 1200). */
  const BRIEFING = "This is one sentence of the morning briefing. ".repeat(60);
  const piecesInBriefing = splitSpeech(BRIEFING).length;

  it("stops the briefing and says so, instead of reading on in silence", async () => {
    let plays = 0;
    const play = async () => {
      plays += 1;
      throw new SpeechPlaybackError("no sound came out");
    };
    expect(piecesInBriefing).toBeGreaterThan(1);
    await expect(speakLong(BRIEFING, synth, () => false, play)).rejects.toThrow(SpeechPlaybackError);
    expect(plays).toBe(1); // it did not pretend to read the rest
  });

  it("keeps reading when one piece fails for another reason", async () => {
    let plays = 0;
    const play = async () => {
      plays += 1;
      if (plays === 1) throw new Error("one file the player didn't like");
    };
    await expect(speakLong(BRIEFING, synth, () => false, play)).resolves.toBeUndefined();
    expect(plays).toBe(piecesInBriefing); // the failed piece is skipped, the rest is read
  });

  it("stops at once when the person taps Stop", async () => {
    let plays = 0;
    let stopped = false;
    const play = async () => {
      plays += 1;
      stopped = true; // the like of stopBriefing() while the first piece plays
    };
    await speakLong(BRIEFING, synth, () => stopped, play);
    expect(plays).toBe(1);
  });
});
