// ── A stand-in for Microsoft's Read Aloud endpoint ─────────────────────────
// The phone app speaks with Microsoft's neural voices — from the phone itself
// (EdgeTtsPlugin.java) and, when the PC is on, through the PC's server
// (src/lib/edgeTts.ts). Both are the real product; both make CI depend on
// Microsoft's WebSocket service being reachable from a runner *and* from an
// emulator, which it isn't reliably — and a red build that way says nothing
// about Soundwave.
//
// This is the same trick the Android job already plays for Gemini and Open-Meteo:
// a local stand-in that speaks the service's own framing (the protocol is the
// one server/tests/edge_tts.test.ts exercises) and answers with a real MP3 from
// the bundled music, so the phone really decodes and plays it. The wire format:
//
//   text frames    X-RequestId:…\r\nContent-Type:…\r\nPath:<path>\r\n\r\n<body>
//   binary frames  2-byte big-endian header length, header text with "Path:audio",
//                  then the MPEG audio payload
//
//   node --import tsx scripts/fake-edge-tts.ts [--port 4200]
//
// Bound to 0.0.0.0: the runner reaches it as 127.0.0.1 (the PC server) and the
// emulator as 10.0.2.2 (the phone app). GET /_fake/health answers with how many
// syntheses it has served, so the workflow can prove it was actually used.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const musicDir = path.join(here, "..", "..", "scripts", "assets", "music");

const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4200;
const host = "0.0.0.0";

// The real service answers with MP3 at 24 kHz/48 kbps (OUTPUT_FORMAT). A bundled
// music file is real, playable MPEG audio, so nothing about playback is faked.
const track = fs
  .readdirSync(musicDir)
  .filter((f) => f.toLowerCase().endsWith(".mp3"))
  .map((f) => path.join(musicDir, f))
  .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size)[0];
if (!track) throw new Error(`no MP3 to answer with under ${musicDir}`);
const AUDIO = fs.readFileSync(track);
const AUDIO_CHUNK = 16 * 1024;
// Only the first few seconds of the track per synthesis: the test needs the
// voice to *really* start (and be decoded by the phone), not a full minute of
// music per chunk. A byte cap is bitrate-agnostic: ~300 KB is 9 s at 256 kbps,
// 19 s at 128 kbps. The cut may land inside the last frame; decoders drop an
// incomplete frame, and `ffmpeg -v error -i` on the slice says nothing.
const AUDIO_BYTES = Math.min(AUDIO.length, 300 * 1024);
/** A short, real word timing, so a client that wants captions has something true to read. */
const WORDS = {
  Metadata: [
    { Type: "WordBoundary", Data: { Offset: 1_000_000, Duration: 4_000_000, text: { Text: "Good", Length: 4, BoundaryType: "WordBoundary" } } },
    { Type: "WordBoundary", Data: { Offset: 6_000_000, Duration: 5_000_000, text: { Text: "morning", Length: 7, BoundaryType: "WordBoundary" } } },
  ],
};

function textFrame(pathName: string, body = "{}"): string {
  return `X-RequestId:standin\r\nContent-Type:application/json; charset=utf-8\r\nPath:${pathName}\r\n\r\n${body}`;
}

function audioFrame(payload: Buffer): Buffer {
  const header = Buffer.from("X-RequestId:standin\r\nContent-Type:audio/mpeg\r\nX-StreamId:1\r\nPath:audio\r\n");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(header.length);
  return Buffer.concat([length, header, payload]);
}

let served = 0;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/_fake/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, served, track: path.basename(track), bytes: AUDIO.length }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const text = data.toString();
      if (!text.includes("Path:ssml")) return;
      const spoken = text.length;
      served++;
      console.log(`[fake-edge-tts] synthesis #${served} (${spoken} bytes of SSML) → ${path.basename(track)}`);
      ws.send(textFrame("turn.start"));
      ws.send(textFrame("audio.metadata", JSON.stringify(WORDS)));
      for (let at = 0; at < AUDIO_BYTES; at += AUDIO_CHUNK) ws.send(audioFrame(AUDIO.subarray(at, Math.min(at + AUDIO_CHUNK, AUDIO_BYTES))));
      ws.send(textFrame("turn.end"));
    });
  });
});

server.listen(port, host, () => {
  console.log(`[fake-edge-tts] listening on ws://${host}:${port}/consumer/speech/synthesize/readaloud/edge/v1 (answering with ${path.basename(track)}, ${Math.round(AUDIO.length / 1024)} KB)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[fake-edge-tts] served ${served} synthesis(es)`);
    server.close(() => process.exit(0));
  });
}
