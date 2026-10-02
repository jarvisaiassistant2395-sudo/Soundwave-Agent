// Live check of the Soundwave voices against Microsoft's real Edge TTS service.
// CI runs it on every desktop build (non-blocking) so a service-side change
// shows up as an annotation instead of as a "robotic voice" bug report.
//
//   npx tsx scripts/edge-tts-smoke.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EdgeTTS } from "node-edge-tts";
import { OUTPUT_FORMAT, streamEdgeTTS, synthesizeEdgeTTS } from "../src/lib/edgeTts.js";

const SOUNDWAVE_VOICES = [
  // The newest generation (listed first in the app's picker): the most natural
  // free voices. Checked live here so a service-side change shows up as an
  // annotation instead of a silent fallback.
  "en-US-AvaMultilingualNeural",
  "en-US-AndrewMultilingualNeural",
  "en-US-EmmaMultilingualNeural",
  "en-US-BrianMultilingualNeural",
  "en-US-GuyNeural",
  "en-US-ChristopherNeural",
  "en-GB-RyanNeural",
  "en-US-JennyNeural",
  "en-US-AnaNeural",
  "en-GB-SoniaNeural",
];

const ci = Boolean(process.env.GITHUB_ACTIONS);
const notice = (msg: string) => console.log(ci ? `::notice title=Soundwave voices::${msg}` : `✓ ${msg}`);
const warn = (msg: string) => console.log(ci ? `::warning title=Soundwave voices::${msg}` : `✗ ${msg}`);

let failures = 0;

// 1. The Command Center's live path: streamed speech.
try {
  const t0 = performance.now();
  let firstChunkMs = 0;
  let chunks = 0;
  const r = await streamEdgeTTS(
    { text: "Soundwave voice check. The agent is online and ready to make your next short.", voice: "en-US-GuyNeural" },
    {
      onAudio: () => {
        if (chunks++ === 0) firstChunkMs = performance.now() - t0;
      },
    },
  );
  const totalMs = performance.now() - t0;
  notice(
    `Streaming (Guy): first audio after ${Math.round(firstChunkMs)} ms, ${r.duration.toFixed(1)} s of speech in ${chunks} chunks, done after ${Math.round(totalMs)} ms (${OUTPUT_FORMAT}).`,
  );
} catch (err) {
  failures++;
  warn(`Streaming speech failed: ${(err as Error).message}`);
}

// 2. Every Soundwave voice, the way shorts are narrated (word timings drive the captions).
for (const voice of SOUNDWAVE_VOICES) {
  try {
    const t0 = performance.now();
    const r = await synthesizeEdgeTTS({ text: "Did you know that honey never spoils?", voice }, { attempts: 1 });
    const ms = Math.round(performance.now() - t0);
    if (r.wordTimings.length === 0) throw new Error("no word timings came back (captions would be estimated)");
    notice(`${voice}: ${r.duration.toFixed(2)} s, ${r.wordTimings.length} word timings, ${ms} ms.`);
  } catch (err) {
    failures++;
    warn(`${voice} failed: ${(err as Error).message}`);
  }
}

// 3. The backup engine on its own (node-edge-tts), for the record.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-edge-smoke-"));
try {
  const out = path.join(dir, "legacy.mp3");
  const legacy = new EdgeTTS({ voice: "en-US-GuyNeural", lang: "en-US", outputFormat: OUTPUT_FORMAT, timeout: 20_000 });
  await legacy.ttsPromise("Backup voice engine check.", out);
  notice(`Backup engine (node-edge-tts): ${fs.statSync(out).size} bytes.`);
} catch (err) {
  warn(`Backup engine (node-edge-tts) failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  warn(`${failures} voice check(s) failed — the app will show this reason instead of speaking.`);
  process.exit(1);
}
notice("All Soundwave voices answered.");
process.exit(0);
