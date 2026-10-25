/** Down/up-sample mono PCM16 between common voice rates. */

import { mulaw8kB64ToPcm16, pcm16ToMulaw8kB64 } from "./audioMulawCodec.js";

/**
 * Downsampling low-pass: cutoff sits just under the target Nyquist, and the
 * transition band is sized so the stopband starts at ~target/2. Without it,
 * picking every Nth sample folds everything above target/2 (sibilants,
 * breath — 4–12 kHz when going 24k → 8k) back into the audible band as harsh,
 * metallic distortion.
 */
const LOWPASS_CUTOFF_OF_TARGET = 0.456;
const LOWPASS_TRANSITION_OF_TARGET = 0.08;
/** Kaiser β for ~80 dB stopband attenuation (μ-law's own noise floor is well above that). */
const KAISER_BETA = 8;
const KAISER_ATTENUATION_DB = 80;

const lowpassCache = new Map<string, Float64Array>();

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

/** Kaiser-windowed sinc FIR (odd length, unity DC gain) for resampling sourceRate → targetRate. */
function downsampleLowpass(sourceRate: number, targetRate: number): Float64Array {
  const key = `${sourceRate}:${targetRate}`;
  const cached = lowpassCache.get(key);
  if (cached) return cached;

  const transition = (LOWPASS_TRANSITION_OF_TARGET * targetRate) / sourceRate;
  let taps = Math.ceil((KAISER_ATTENUATION_DB - 7.95) / (14.36 * transition)) + 1;
  if (taps % 2 === 0) taps += 1;
  const cutoff = (LOWPASS_CUTOFF_OF_TARGET * targetRate) / sourceRate;
  const mid = (taps - 1) / 2;
  const i0Beta = besselI0(KAISER_BETA);
  const h = new Float64Array(taps);
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const n = k - mid;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const r = n / mid;
    h[k] = sinc * (besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0Beta);
    sum += h[k];
  }
  for (let k = 0; k < taps; k++) h[k] /= sum;
  lowpassCache.set(key, h);
  return h;
}

function toPcm16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

export function resamplePcm16(
  samples: Int16Array,
  sourceRate: number,
  targetRate: number,
): Int16Array {
  if (sourceRate === targetRate || samples.length === 0) return samples;

  const ratio = sourceRate / targetRate;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(outLen);

  if (targetRate < sourceRate) {
    // Whole-buffer path (lock prompt clips): centered filter, so no added delay.
    const h = downsampleLowpass(sourceRate, targetRate);
    const mid = (h.length - 1) / 2;
    const filteredAt = (pos: number): number => {
      let acc = 0;
      for (let k = 0; k < h.length; k++) {
        const s = samples[pos + mid - k];
        if (s !== undefined) acc += h[k]! * s;
      }
      return acc;
    };
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const a = filteredAt(idx);
      out[i] = toPcm16(frac === 0 ? a : a * (1 - frac) + filteredAt(idx + 1) * frac);
    }
    return out;
  }

  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = samples[idx] ?? 0;
    const b = samples[Math.min(idx + 1, samples.length - 1)] ?? a;
    out[i] = Math.round(a * (1 - frac) + b * frac);
  }

  return out;
}

/**
 * Streaming integer-ratio downsampler. Model audio arrives in chunks of
 * arbitrary length; the filter history and decimation phase carry across
 * chunks, so chunked output is sample-identical to one-shot output (the
 * stateless path restarts the phase and drops the remainder every chunk).
 * Causal filter: adds (taps − 1) / 2 source samples of delay (~4 ms at 24 kHz).
 */
export class Pcm16StreamDownsampler {
  private readonly factor: number;
  private readonly h: Float64Array;
  private history: Int16Array;
  /** Index, within the next chunk, of the next source sample to emit. */
  private nextPos = 0;

  constructor(sourceRate: number, targetRate: number) {
    const factor = sourceRate / targetRate;
    if (!Number.isInteger(factor) || factor < 1) {
      throw new Error(`Pcm16StreamDownsampler needs an integer ratio, got ${sourceRate} → ${targetRate}`);
    }
    this.factor = factor;
    this.h = downsampleLowpass(sourceRate, targetRate);
    this.history = new Int16Array(this.h.length - 1);
  }

  process(samples: Int16Array): Int16Array {
    const hist = this.history.length;
    const buf = new Int16Array(hist + samples.length);
    buf.set(this.history, 0);
    buf.set(samples, hist);

    const out: number[] = [];
    let pos = this.nextPos;
    for (; pos < samples.length; pos += this.factor) {
      let acc = 0;
      const end = hist + pos;
      for (let k = 0; k < this.h.length; k++) acc += this.h[k]! * buf[end - k]!;
      out.push(toPcm16(acc));
    }
    this.nextPos = pos - samples.length;
    this.history = buf.slice(buf.length - hist);
    return Int16Array.from(out);
  }
}

/** Browser uplink is PCM24k; Gemini Live input is natively 16 kHz. */
export function pcm24kB64ToPcm16k(samples24k: Int16Array): Int16Array {
  return resamplePcm16(samples24k, 24000, 16000);
}

/** PSTN uplink: Twilio μ-law 8 kHz → Gemini Live input 16 kHz. */
export function mulaw8kB64ToPcm16k(b64: string): Int16Array {
  const pcm8k = mulaw8kB64ToPcm16(b64);
  return resamplePcm16(pcm8k, 8000, 16000);
}

function pcm16FromB64(b64: string): Int16Array | null {
  const raw = Buffer.from(b64, "base64");
  if (raw.length < 2) return null;
  const aligned = raw.length - (raw.length % 2);
  // Copy: the base64 buffer's byteOffset is not guaranteed 2-byte aligned.
  return new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + aligned));
}

/** Gemini Live output is PCM24k; Twilio Media Streams expect μ-law 8 kHz. Whole clips only. */
export function pcm24kB64ToMulaw8kB64(pcm24kB64: string): string {
  const samples24k = pcm16FromB64(pcm24kB64);
  if (!samples24k) return "";
  const pcm8k = resamplePcm16(samples24k, 24000, 8000);
  return pcm16ToMulaw8kB64(pcm8k);
}

/** Streaming form of {@link pcm24kB64ToMulaw8kB64} — one per call, fed every model audio chunk. */
export class Pcm24kToMulaw8kStream {
  private readonly downsampler = new Pcm16StreamDownsampler(24000, 8000);

  encodeB64(pcm24kB64: string): string {
    const samples24k = pcm16FromB64(pcm24kB64);
    if (!samples24k) return "";
    const pcm8k = this.downsampler.process(samples24k);
    return pcm8k.length ? pcm16ToMulaw8kB64(pcm8k) : "";
  }
}
