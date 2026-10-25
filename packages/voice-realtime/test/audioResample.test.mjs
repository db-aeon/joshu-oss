import assert from "node:assert/strict";
import test from "node:test";

import {
  Pcm16StreamDownsampler,
  Pcm24kToMulaw8kStream,
  pcm24kB64ToMulaw8kB64,
  resamplePcm16,
} from "../dist/audioResample.js";

function tone(freqHz, rate, seconds, amplitude = 16000) {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / rate));
  return out;
}

/** RMS over the middle of the signal (skips filter warm-up at the edges). */
function rms(samples) {
  const from = Math.floor(samples.length * 0.2);
  const to = Math.floor(samples.length * 0.8);
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] ** 2;
  return Math.sqrt(sum / (to - from));
}

const db = (a, b) => 20 * Math.log10(a / b);

/** Gemini Live delivers model audio in uneven chunks, often not a multiple of 3 samples. */
function* unevenChunks(samples) {
  const sizes = [961, 1440, 7, 2400, 1, 8160, 1023, 480];
  let at = 0;
  for (let i = 0; at < samples.length; i++) {
    const size = sizes[i % sizes.length];
    yield samples.subarray(at, at + size);
    at += size;
  }
}

test("24k → 8k blocks content above the phone band instead of folding it back", () => {
  // Regression: every-3rd-sample decimation turned a 6 kHz tone into a full-level 2 kHz tone.
  const input = tone(6000, 24000, 1);
  const whole = resamplePcm16(input, 24000, 8000);
  assert.ok(db(rms(whole), rms(input)) < -60, `stateless path leaked ${db(rms(whole), rms(input)).toFixed(1)} dB`);

  const streamed = new Pcm16StreamDownsampler(24000, 8000).process(input);
  assert.ok(db(rms(streamed), rms(input)) < -60, `stream path leaked ${db(rms(streamed), rms(input)).toFixed(1)} dB`);
});

test("24k → 8k keeps speech-band content at unity gain", () => {
  for (const freq of [300, 1000, 3000]) {
    const input = tone(freq, 24000, 1);
    const whole = resamplePcm16(input, 24000, 8000);
    const streamed = new Pcm16StreamDownsampler(24000, 8000).process(input);
    assert.ok(Math.abs(db(rms(whole), rms(input))) < 0.5, `${freq} Hz stateless gain ${db(rms(whole), rms(input)).toFixed(2)} dB`);
    assert.ok(Math.abs(db(rms(streamed), rms(input))) < 0.5, `${freq} Hz stream gain ${db(rms(streamed), rms(input)).toFixed(2)} dB`);
  }
});

test("chunked streaming output is identical to one-shot output, with no dropped samples", () => {
  const input = tone(440, 24000, 2);
  const oneShot = new Pcm16StreamDownsampler(24000, 8000).process(input);

  const stream = new Pcm16StreamDownsampler(24000, 8000);
  const parts = [...unevenChunks(input)].map((chunk) => stream.process(chunk));
  const chunked = Int16Array.from(parts.flatMap((part) => [...part]));

  assert.equal(chunked.length, input.length / 3);
  assert.deepEqual(chunked, oneShot);
});

test("μ-law stream encodes the same byte count as the whole-clip path", () => {
  const input = tone(1000, 24000, 1);
  const b64 = Buffer.from(input.buffer).toString("base64");
  const whole = Buffer.from(pcm24kB64ToMulaw8kB64(b64), "base64");

  const stream = new Pcm24kToMulaw8kStream();
  const streamed = Buffer.concat(
    [...unevenChunks(input)].map((chunk) =>
      Buffer.from(stream.encodeB64(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64")), "base64"),
    ),
  );

  assert.equal(whole.length, 8000);
  assert.equal(streamed.length, 8000);
});

test("stream downsampler rejects non-integer ratios", () => {
  assert.throws(() => new Pcm16StreamDownsampler(24000, 16000), /integer ratio/);
});

test("upsampling is unchanged (linear interpolation)", () => {
  const input = Int16Array.from([0, 100, 200, 300]);
  assert.deepEqual([...resamplePcm16(input, 8000, 16000)], [0, 50, 100, 150, 200, 250, 300, 300]);
});
