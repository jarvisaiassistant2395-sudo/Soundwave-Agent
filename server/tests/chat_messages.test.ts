// The server (lib/chatMessages) and the desktop app (frontend lib/agentChat)
// build the same conversation messages: same order, same merge, same fixed
// ids for job outcomes — otherwise the PC window and the phone would disagree.
import { describe, expect, it } from "vitest";
import * as server from "../src/lib/chatMessages.js";
import * as web from "../../frontend/src/lib/agentChat.js";

const strip = <T extends { time?: string; at?: number }>(m: T) => {
  const { time: _time, at: _at, ...rest } = m;
  return rest;
};

const background = {
  source: "orbital_ncg" as const,
  channelName: "Orbital NCG",
  channelUrl: "https://www.youtube.com/@OrbitalNCG",
  videoId: "abc123",
  url: "https://www.youtube.com/watch?v=abc123",
  title: "Parkour run",
  section: { start: 65, end: 125 },
};

describe("server and desktop build identical messages", () => {
  it("order messages the same way", () => {
    for (const id of ["init", "1727000000000-ab12cd", "1727000000000", "job-x-done", "abc"]) {
      expect(server.messageOrder({ id })).toBe(web.messageOrder({ id }));
    }
    expect(server.messageOrder({ id: "job-x-done", at: 5 })).toBe(web.messageOrder({ id: "job-x-done", at: 5 }));
  });

  it("merge the same way", () => {
    const t = 1_727_000_000_000;
    const a = [
      { id: "init", sender: "assistant" as const, text: "hi", time: "" },
      { id: `${t + 5}-a`, sender: "user" as const, text: "a", time: "" },
    ];
    const b = [
      { id: `${t + 1}-b`, sender: "user" as const, text: "b", time: "", via: "phone" as const },
      { id: `job-j1-done`, sender: "assistant" as const, text: "done", time: "", at: t + 9 },
      { id: `${t + 5}-a`, sender: "user" as const, text: "a (other copy)", time: "" },
    ];
    const s = server.mergeChatMessages(a, b, 60);
    const w = web.mergeChat(a, b, 60);
    expect(s).toEqual(w);
    expect(s.map((m) => m.text)).toEqual(["hi", "b", "a", "done"]);
    expect(server.mergeChatMessages(a, b, 2)).toEqual(web.mergeChat(a, b, 2));
  });

  it("job outcome messages match (fixed ids, same text)", () => {
    const sDone = server.completionMessage("j1", "black holes", { videoUrl: "/v.mp4", youtubeUrl: "https://youtu.be/x", background });
    const wDone = web.completionMessage("j1", "black holes", { videoUrl: "/v.mp4", youtubeUrl: "https://youtu.be/x", background });
    expect(strip(sDone)).toEqual(strip(wDone));
    expect(sDone.id).toBe("job-j1-done");

    const sPlain = server.completionMessage("j2", "sharks", { videoUrl: "/v2.mp4" });
    const wPlain = web.completionMessage("j2", "sharks", { videoUrl: "/v2.mp4" });
    expect(strip(sPlain)).toEqual(strip(JSON.parse(JSON.stringify(wPlain))));

    expect(strip(server.failureMessage("j3", "x", "boom"))).toEqual(strip(web.failureMessage("j3", "x", "boom")));
  });

  it("chat replies become the same assistant message", () => {
    const reply = { success: true, reply: "On it!", action: "soundwave_shorts", status: "PROCESSING", jobId: "j9", topic: "space", tag: "AUDIO" as const };
    const s = server.replyToMessage(reply, "make a short about space");
    const w = web.replyToMessage(reply, "make a short about space");
    const { id: _s, ...sRest } = strip(s);
    const { id: _w, ...wRest } = strip(JSON.parse(JSON.stringify(w)));
    expect(sRest).toEqual(wRest);
    expect(server.openJobs([s])).toEqual(web.openJobs([w]));
  });
});
