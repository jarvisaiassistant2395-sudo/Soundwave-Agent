// ── Voice sample generator (build time) ────────────────────────────────────
// Pre-generates real Microsoft Neural voice MP3 clips and writes them to
// ../frontend/public/voice-samples/ using node-edge-tts (no API key).
//
// Run:  npm run samples

import fs from "node:fs";
import path from "node:path";
import { synthesizeSample } from "../src/lib/edgeTts.js";
import { VOICES } from "../src/lib/voices.js";

const SENTENCE =
  "Welcome to Soundwave AI. This is a sample of my voice. I can help you create professional audio content with natural-sounding speech.";

async function main() {
  const outDir = path.join(process.cwd(), "..", "frontend", "public", "voice-samples");
  fs.mkdirSync(outDir, { recursive: true });

  for (const voice of VOICES) {
    const buf = await synthesizeSample(SENTENCE, voice.id);
    const out = path.join(outDir, `${voice.id}.mp3`);
    fs.writeFileSync(out, buf);
    console.log(`  ✓ ${voice.id}.mp3 (${(buf.length / 1024).toFixed(1)} KB)`);
  }
  console.log(`\nGenerated ${VOICES.length} Microsoft Neural voice samples → ${outDir}`);
}

main().catch((e) => {
  console.error("Sample generation failed:", e);
  process.exit(1);
});
