/* Runtime verification of the TTS audio pipeline (run with: npx tsx scripts/verify-audio.ts).
 * Exercises the pure helpers and WAV header writer without a browser. */
import {
  OFFLINE_SAMPLE_RATE,
  encodeWav,
  toMonoFloat32,
  normalizeFloat32,
  normalizeSampleRate,
  resampleLinear,
} from "../src/lib/audio";
import { synthesizeOffline } from "../src/lib/ttsEngine";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// Fake AudioBuffer (mono, 24 kHz) whose samples exceed [-1, 1] to test clipping.
function fakeBuffer(samples: Float32Array, sampleRate = OFFLINE_SAMPLE_RATE) {
  return {
    sampleRate,
    numberOfChannels: 1,
    length: samples.length,
    duration: samples.length / sampleRate,
    getChannelData: (c: number) => (c === 0 ? samples : new Float32Array(samples.length)),
  } as unknown as AudioBuffer;
}

const fs = 24000;
// 0.5 s of a 440 Hz sine with amplitude 1.5 (would clip without normalization).
const hot = new Float32Array(Math.floor(fs * 0.5));
for (let i = 0; i < hot.length; i++) hot[i] = 1.5 * Math.sin((2 * Math.PI * 440 * i) / fs);

// 1. normalizeFloat32 attenuates to <= target peak, never amplifies quiet.
const norm = normalizeFloat32(hot, 0.98);
let peak = 0;
for (const v of norm) peak = Math.max(peak, Math.abs(v));
check("normalizeFloat32 peak <= 0.98", peak <= 0.9801, `peak=${peak}`);
const quiet = normalizeFloat32(new Float32Array([0.1, -0.1, 0.05]));
check("normalizeFloat32 does not amplify quiet audio", Math.abs(quiet[0]! - 0.1) < 1e-6);

// 2. WAV 16-bit header fields + no overflow.
const wav = encodeWav(fakeBuffer(hot));
const wavBytes = new Uint8Array(await wav.arrayBuffer());
const dv = new DataView(wavBytes.buffer);
const ascii = (o: number, n: number) => String.fromCharCode(...wavBytes.slice(o, o + n));
check("WAV RIFF/WAVE magic", ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE");
check("WAV fmt/data magic", ascii(12, 4) === "fmt " && ascii(36, 4) === "data");
check("WAV audio format = 1 (PCM)", dv.getUint16(20, true) === 1);
check("WAV channels = 1 (mono)", dv.getUint16(22, true) === 1);
check("WAV sampleRate = 24000", dv.getUint32(24, true) === 24000);
check("WAV byteRate = 48000", dv.getUint32(28, true) === 48000);
check("WAV blockAlign = 2", dv.getUint16(32, true) === 2);
check("WAV bitsPerSample = 16", dv.getUint16(34, true) === 16);
let max16 = -1, min16 = 1;
for (let i = 44; i < wavBytes.length; i += 2) {
  const s = dv.getInt16(i, true);
  max16 = Math.max(max16, s);
  min16 = Math.min(min16, s);
}
check("WAV Int16 no overflow (max<=32767)", max16 <= 32767, `max=${max16}`);
check("WAV Int16 no underflow (min>=-32768)", min16 >= -32768, `min=${min16}`);
check("WAV Int16 normalized (peak≈0.98*32767)", Math.abs(max16 / 32767 - 0.98) < 0.02, `max=${max16}`);
check("WAV chunk size consistent", dv.getUint32(4, true) === wavBytes.length - 8);

// 3. WAV 32-bit float variant.
const wavf = encodeWav(fakeBuffer(hot), { float32: true });
const wavfBytes = new Uint8Array(await wavf.arrayBuffer());
const dvf = new DataView(wavfBytes.buffer);
check("WAV float: format = 3 (IEEE float)", dvf.getUint16(20, true) === 3);
check("WAV float: bitsPerSample = 32", dvf.getUint16(34, true) === 32);
check("WAV float: blockAlign = 4", dvf.getUint16(32, true) === 4);
let fpeak = 0;
for (let i = 44; i < wavfBytes.length; i += 4) fpeak = Math.max(fpeak, Math.abs(dvf.getFloat32(i, true)));
check("WAV float: samples normalized ≤ 0.98", fpeak <= 0.9801, `peak=${fpeak}`);

// 4. toMonoFloat32 coercion.
check("toMonoFloat32 passthrough", toMonoFloat32(hot) === hot);
const arr = toMonoFloat32([0.5, -0.5, 0.25] as unknown as number[]);
check("toMonoFloat32 number[]", arr.length === 3 && Math.abs(arr[1]! + 0.5) < 1e-7);
const stereo = toMonoFloat32([[1, 0], [0, 1]] as unknown as number[][]);
check("toMonoFloat32 stereo→mono average", stereo.length === 2 && Math.abs(stereo[0]! - 0.5) < 1e-7);
const tens = toMonoFloat32({ data: [0.2, 0.3] });
check("toMonoFloat32 tensor-like", tens.length === 2 && Math.abs(tens[1]! - 0.3) < 1e-7);
const nan = toMonoFloat32(new Float32Array([0.1, NaN, 0.2]));
check("toMonoFloat32 NaN→0", nan[1] === 0);

// 5. normalizeSampleRate validation.
check("normalizeSampleRate 24000", normalizeSampleRate(24000) === 24000);
check("normalizeSampleRate garbage→24000", normalizeSampleRate(undefined) === 24000 && normalizeSampleRate(7) === 24000);

// 6. resampleLinear length ratio.
const rs = resampleLinear(hot, 24000, 44100);
const expect = Math.round(hot.length * (44100 / 24000));
check("resampleLinear 24k→44.1k length", Math.abs(rs.length - expect) <= 1, `got ${rs.length}, want ~${expect}`);
check("resampleLinear identity", resampleLinear(hot, 24000, 24000) === hot);

// 7. Offline engine output: 24 kHz, mono, within [-1, 1].
const off = synthesizeOffline({ text: "Hello world, this is a test.", voiceId: "af_heart", settings: { speed: 1, pitch: 0, volume: 100 } });
check("offline engine sampleRate = 24000", off.sampleRate === OFFLINE_SAMPLE_RATE, `got ${off.sampleRate}`);
let opk = 0;
for (const v of off.samples) opk = Math.max(opk, Math.abs(v));
check("offline engine samples within [-1,1]", opk <= 1.0001 && opk > 0, `peak=${opk}`);
check("offline engine duration consistent", Math.abs(off.duration - off.samples.length / off.sampleRate) < 1e-6);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
