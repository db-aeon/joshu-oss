/**
 * Silence / end-of-utterance detection matched to Hermes `tools/voice_mode.py`
 * `AudioRecorder._callback` (RMS threshold, dip tolerance, silence duration).
 *
 * RMS is computed like Python: int(sqrt(mean(int16_sample**2))) on 0..32767 scale.
 */

export const DEFAULT_SILENCE_RMS_THRESHOLD = 200;
export const DEFAULT_SILENCE_DURATION_SEC = 3.0;
export const MIN_SPEECH_DURATION_SEC = 0.3;
export const MAX_DIP_TOLERANCE_SEC = 0.3;
export const MAX_WAIT_NO_SPEECH_SEC = 15.0;

/** Convert WebAudio float [-1,1] to int16 (Hermes-style PCM). */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] ?? 0;
    const s = Math.max(-1, Math.min(1, raw));
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
  }
  return out;
}

export function rmsInt16(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.floor(Math.sqrt(sum / samples.length));
}

/**
 * Stateful VAD mirroring Hermes AudioRecorder silence callback.
 * Call `beginSegment()` when starting a new utterance capture, then `process()` each frame.
 */
export class HermesVoiceVad {
  silenceThreshold: number;
  silenceDurationSec: number;

  private hasSpoken = false;
  private speechStart = 0;
  private dipStart = 0;
  private silenceStart = 0;
  private resumeStart = 0;
  private resumeDipStart = 0;
  private segmentStartMono = 0;

  constructor(options?: { silenceThreshold?: number; silenceDurationSec?: number }) {
    this.silenceThreshold = options?.silenceThreshold ?? DEFAULT_SILENCE_RMS_THRESHOLD;
    this.silenceDurationSec = options?.silenceDurationSec ?? DEFAULT_SILENCE_DURATION_SEC;
  }

  /** Reset detection state for a new utterance (Hermes `AudioRecorder.start`). */
  beginSegment(nowMonoSeconds: number): void {
    this.segmentStartMono = nowMonoSeconds;
    this.hasSpoken = false;
    this.speechStart = 0;
    this.dipStart = 0;
    this.silenceStart = 0;
    this.resumeStart = 0;
    this.resumeDipStart = 0;
  }

  /**
   * Process one RMS sample at monotonic clock `nowMonoSeconds`.
   * Returns true when Hermes would fire the silence auto-stop (one-shot per segment).
   */
  process(rms: number, nowMonoSeconds: number): boolean {
    const elapsed = nowMonoSeconds - this.segmentStartMono;

    if (rms > this.silenceThreshold) {
      this.dipStart = 0;
      if (this.speechStart === 0) {
        this.speechStart = nowMonoSeconds;
      } else if (!this.hasSpoken && nowMonoSeconds - this.speechStart >= MIN_SPEECH_DURATION_SEC) {
        this.hasSpoken = true;
      }
      if (!this.hasSpoken) {
        this.silenceStart = 0;
      } else {
        this.resumeDipStart = 0;
        if (this.resumeStart === 0) {
          this.resumeStart = nowMonoSeconds;
        } else if (nowMonoSeconds - this.resumeStart >= MIN_SPEECH_DURATION_SEC) {
          this.silenceStart = 0;
          this.resumeStart = 0;
        }
      }
    } else if (this.hasSpoken) {
      if (this.resumeStart > 0) {
        if (this.resumeDipStart === 0) {
          this.resumeDipStart = nowMonoSeconds;
        } else if (nowMonoSeconds - this.resumeDipStart >= MAX_DIP_TOLERANCE_SEC) {
          this.resumeStart = 0;
          this.resumeDipStart = 0;
        }
      }
    } else if (this.speechStart > 0) {
      if (this.dipStart === 0) {
        this.dipStart = nowMonoSeconds;
      } else if (nowMonoSeconds - this.dipStart >= MAX_DIP_TOLERANCE_SEC) {
        this.speechStart = 0;
        this.dipStart = 0;
      }
    }

    let shouldFire = false;
    if (this.hasSpoken && rms <= this.silenceThreshold) {
      if (this.silenceStart === 0) {
        this.silenceStart = nowMonoSeconds;
      } else if (nowMonoSeconds - this.silenceStart >= this.silenceDurationSec) {
        shouldFire = true;
      }
    } else if (!this.hasSpoken && elapsed >= MAX_WAIT_NO_SPEECH_SEC) {
      shouldFire = true;
    }

    return shouldFire;
  }
}

/** Build mono 16-bit WAV (PCM s16le). */
export function encodeWavMono16(pcmChunks: Int16Array[], sampleRate: number): ArrayBuffer {
  const totalSamples = pcmChunks.reduce((acc, c) => acc + c.length, 0);
  const pcm = new Int16Array(totalSamples);
  let offset = 0;
  for (const chunk of pcmChunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }

  const bytesPerSample = 2;
  const numChannels = 1;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const out = new Uint8Array(buffer, 44);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return buffer;
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
