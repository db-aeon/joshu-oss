const TARGET_RATE = 24000;

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
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

/** Resample mono PCM16 to 24 kHz for OpenAI Realtime transcription input. */
export function resampleToPcm24k(samples: Int16Array, sourceRate: number): Int16Array {
  if (sourceRate === TARGET_RATE) return samples;
  if (samples.length === 0) return new Int16Array(0);

  const ratio = sourceRate / TARGET_RATE;
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

/** Minimum PCM16 @ 24 kHz before enqueueing playback (~100 ms). */
const PCM24K_MIN_PLAY_SAMPLES = 2400;

export class Pcm24kPlayer {
  private ctx: AudioContext | null = null;
  private externalCtx: AudioContext | null = null;
  private nextTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private pending = new Int16Array(0);

  /** Reuse the mic AudioContext when provided (avoids a second 24 kHz context). */
  attachContext(ctx: AudioContext): void {
    this.externalCtx = ctx;
    this.ctx = ctx;
    this.nextTime = ctx.currentTime;
  }

  async ensureContext(): Promise<AudioContext> {
    if (this.externalCtx && this.externalCtx.state !== "closed") {
      this.ctx = this.externalCtx;
    } else if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext();
      this.nextTime = this.ctx.currentTime;
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  async enqueuePcm24k(pcm: Int16Array): Promise<void> {
    if (pcm.length === 0) return;
    this.pending = concatInt16(this.pending, pcm);
    while (this.pending.length >= PCM24K_MIN_PLAY_SAMPLES) {
      const chunk = this.pending.slice(0, PCM24K_MIN_PLAY_SAMPLES);
      this.pending = this.pending.slice(PCM24K_MIN_PLAY_SAMPLES);
      await this.scheduleChunk(chunk);
    }
  }

  /** Flush tail audio (call when a TTS stream ends). */
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const tail = this.pending;
    this.pending = new Int16Array(0);
    await this.scheduleChunk(tail);
  }

  private async scheduleChunk(pcm: Int16Array): Promise<void> {
    if (pcm.length === 0) return;
    const ctx = await this.ensureContext();
    const buffer = ctx.createBuffer(1, pcm.length, TARGET_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      channel[i] = (pcm[i] ?? 0) / 0x8000;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    this.activeSources.add(source);
    source.onended = () => this.activeSources.delete(source);

    const startAt = Math.max(ctx.currentTime + 0.01, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
  }

  stop(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.activeSources.clear();
    this.pending = new Int16Array(0);
    if (this.ctx) {
      this.nextTime = this.ctx.currentTime;
    }
  }

  close(): void {
    this.stop();
    if (this.ctx && this.ctx !== this.externalCtx) {
      void this.ctx.close();
    }
    this.ctx = null;
    this.externalCtx = null;
  }
}

function concatInt16(a: Int16Array, b: Int16Array): Int16Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const PCM24K_RATE = TARGET_RATE;
