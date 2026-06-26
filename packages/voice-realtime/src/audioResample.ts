/** Down/up-sample mono PCM16 between common voice rates. */

import { mulaw8kB64ToPcm16, pcm16ToMulaw8kB64 } from "./audioMulawCodec.js";

export function resamplePcm16(
  samples: Int16Array,
  sourceRate: number,
  targetRate: number,
): Int16Array {
  if (sourceRate === targetRate || samples.length === 0) return samples;

  const ratio = sourceRate / targetRate;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(outLen);

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

/** Browser uplink is PCM24k; Gemini Live input is natively 16 kHz. */
export function pcm24kB64ToPcm16k(samples24k: Int16Array): Int16Array {
  return resamplePcm16(samples24k, 24000, 16000);
}

/** PSTN uplink: Twilio μ-law 8 kHz → Gemini Live input 16 kHz. */
export function mulaw8kB64ToPcm16k(b64: string): Int16Array {
  const pcm8k = mulaw8kB64ToPcm16(b64);
  return resamplePcm16(pcm8k, 8000, 16000);
}

/** Gemini Live output is PCM24k; Twilio Media Streams expect μ-law 8 kHz. */
export function pcm24kB64ToMulaw8kB64(pcm24kB64: string): string {
  const raw = Buffer.from(pcm24kB64, "base64");
  if (raw.length < 2) return "";
  const aligned = raw.length - (raw.length % 2);
  const samples24k = new Int16Array(
    raw.buffer,
    raw.byteOffset,
    aligned / Int16Array.BYTES_PER_ELEMENT,
  );
  const pcm8k = resamplePcm16(samples24k, 24000, 8000);
  return pcm16ToMulaw8kB64(pcm8k);
}
