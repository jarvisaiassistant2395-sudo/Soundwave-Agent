// Soundwave voice input — AudioWorklet that hands raw microphone samples to
// the page in ~20 ms batches (src/lib/voiceInput.ts does the rest: level
// meter, end-of-speech detection, 16 kHz WAV). Served as a same-origin file so
// the app's Content-Security-Policy (script-src 'self') allows it.
class SoundwaveRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~21 ms at 48 kHz: small enough for a lively level meter.
    this.size = 1024;
    this.buffer = new Float32Array(this.size);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let i = 0;
      while (i < channel.length) {
        const take = Math.min(channel.length - i, this.size - this.filled);
        this.buffer.set(channel.subarray(i, i + take), this.filled);
        this.filled += take;
        i += take;
        if (this.filled === this.size) {
          const chunk = this.buffer;
          this.port.postMessage(chunk, [chunk.buffer]);
          this.buffer = new Float32Array(this.size);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("soundwave-recorder", SoundwaveRecorder);
