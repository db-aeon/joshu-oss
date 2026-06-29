import { Pcm24kPlayer, PCM24K_RATE, floatToInt16, resampleToPcm24k, rmsInt16 } from "./audio.js";
import type { JoshuVoiceClientOptions, VoiceSessionState } from "./types.js";

type GatewayMessage = {
  event?: string;
  state?: string;
  text?: string;
  partial?: boolean;
  payload?: string;
  message?: string;
};

const UPLOAD_INTERVAL_MS = 80;
/** Client barge-in during TTS only — stops local playout immediately; server confirms via browser_interrupt. */
const SPEAKING_BARGE_IN_RMS = 520;
const SPEAKING_BARGE_IN_FRAMES = 4;
const BARGE_IN_COOLDOWN_MS = 900;

/** Browser voice session over voice-realtime WebSocket (PCM24k duplex). */
export class JoshuVoiceClient {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private player = new Pcm24kPlayer();
  private running = false;
  private paused = false;
  private gatewayState: VoiceSessionState = "idle";
  private pcmUploadAcc: Int16Array[] = [];
  private uploadTimer: ReturnType<typeof setInterval> | null = null;
  private bargeInCooldownUntil = 0;
  private bargeInLoudFrames = 0;
  private pendingAudioLevel = 0;
  private audioLevelTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: JoshuVoiceClientOptions) {}

  private noteAudioLevel(rawRms: number): void {
    if (!this.opts.onAudioLevel) return;
    // Int16 RMS tops out ~23170; scale so normal speech lands mid-range.
    this.pendingAudioLevel = Math.min(1, rawRms / 4200);
  }

  private startAudioLevelPump(): void {
    if (!this.opts.onAudioLevel || this.audioLevelTimer) return;
    this.audioLevelTimer = setInterval(() => {
      if (!this.running) return;
      this.opts.onAudioLevel?.(this.pendingAudioLevel);
      this.pendingAudioLevel *= 0.72;
    }, 66);
  }

  private stopAudioLevelPump(): void {
    if (this.audioLevelTimer) {
      clearInterval(this.audioLevelTimer);
      this.audioLevelTimer = null;
    }
    this.pendingAudioLevel = 0;
    this.opts.onAudioLevel?.(0);
  }

  get state(): VoiceSessionState {
    return this.gatewayState;
  }

  get isActive(): boolean {
    return this.running;
  }

  setCapturePaused(paused: boolean): void {
    this.paused = paused;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.setGatewayState("connecting");

    this.ws = new WebSocket(this.opts.wsUrl);
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const onOpen = () => {
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        ws.removeEventListener("open", onOpen);
        reject(new Error("Voice WebSocket failed to connect"));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });

    this.ws.onmessage = (event) => this.handleGatewayMessage(String(event.data));
    this.ws.onclose = () => {
      if (this.running) this.setGatewayState("idle");
    };
    this.ws.onerror = () => this.opts.onError?.("Voice WebSocket error");

    this.ws.send(
      JSON.stringify({
        event: "browser_start",
        sessionId: this.opts.sessionId,
        chatSessionId: this.opts.chatSessionId,
        appId: this.opts.surface?.appId,
        voiceCommands: this.opts.surface?.voiceCommands,
      }),
    );

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.mediaStream = stream;
    this.audioCtx = new AudioContext();
    this.player.attachContext(this.audioCtx);
    this.micSource = this.audioCtx.createMediaStreamSource(stream);
    this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      if (!this.running || this.paused || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
      const int16 = floatToInt16(input);
      const frameRms = rmsInt16(int16);

      if (this.gatewayState !== "speaking") {
        this.noteAudioLevel(frameRms);
      }

      if (this.gatewayState === "speaking") {
        if (frameRms > SPEAKING_BARGE_IN_RMS) {
          this.bargeInLoudFrames += 1;
          if (this.bargeInLoudFrames >= SPEAKING_BARGE_IN_FRAMES) {
            this.bargeInLoudFrames = 0;
            this.triggerLocalBargeIn();
          }
        } else {
          this.bargeInLoudFrames = 0;
        }
        // Don't uplink mic while assistant speaks — keeps speaker bleed from triggering server VAD.
        return;
      }

      this.bargeInLoudFrames = 0;
      const pcm24k = resampleToPcm24k(int16, this.audioCtx!.sampleRate);
      if (pcm24k.length > 0) {
        this.pcmUploadAcc.push(pcm24k);
      }
    };
    this.micSource.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);

    this.uploadTimer = setInterval(() => this.flushAudioUpload(), UPLOAD_INTERVAL_MS);
    this.startAudioLevelPump();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.setGatewayState("idle");
    this.stopAudioLevelPump();

    if (this.uploadTimer) {
      clearInterval(this.uploadTimer);
      this.uploadTimer = null;
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ event: "browser_stop" }));
      } catch {
        /* ignore */
      }
    }
    this.ws?.close();
    this.ws = null;

    this.processor?.disconnect();
    this.processor = null;
    this.micSource?.disconnect();
    this.micSource = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    await this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    this.pcmUploadAcc = [];
    this.player.close();
  }

  private triggerLocalBargeIn(): void {
    const now = performance.now();
    if (now < this.bargeInCooldownUntil) return;
    this.bargeInCooldownUntil = now + BARGE_IN_COOLDOWN_MS;
    this.player.stop();
    this.opts.onBargeIn?.();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event: "browser_interrupt" }));
    }
  }

  private flushAudioUpload(): void {
    if (!this.running || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.pcmUploadAcc.length === 0) return;

    const chunks = this.pcmUploadAcc;
    this.pcmUploadAcc = [];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const bytes = new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    this.ws.send(
      JSON.stringify({
        event: "browser_audio",
        payload: btoa(binary),
      }),
    );
  }

  private handleGatewayMessage(raw: string): void {
    let msg: GatewayMessage;
    try {
      msg = JSON.parse(raw) as GatewayMessage;
    } catch {
      return;
    }

    switch (msg.event) {
      case "think_job_start":
      case "hermes_job_start":
        (this.opts.onThinkJobStart ?? this.opts.onHermesJobStart)?.();
        break;
      case "browser_ready":
        this.setGatewayState("listening");
        break;
      case "state":
        if (msg.state === "listening" || msg.state === "thinking" || msg.state === "speaking") {
          this.setGatewayState(msg.state);
        }
        break;
      case "user_transcript":
        if (typeof msg.text === "string") {
          this.opts.onUserTranscript?.(msg.text, Boolean(msg.partial));
        }
        break;
      case "assistant_delta":
        if (typeof msg.text === "string") this.opts.onAssistantDelta?.(msg.text);
        break;
      case "assistant_done":
        if (typeof msg.text === "string") this.opts.onAssistantDone?.(msg.text);
        break;
      case "desktop_action": {
        const action = (msg as { action?: { kind?: string; target?: string } }).action;
        if (
          action &&
          (action.kind === "module" || action.kind === "file") &&
          typeof action.target === "string"
        ) {
          this.opts.onDesktopAction?.({ kind: action.kind, target: action.target });
        }
        break;
      }
      case "app_action": {
        const appId = typeof (msg as { appId?: string }).appId === "string" ? (msg as { appId: string }).appId : "";
        const action = typeof (msg as { action?: string }).action === "string" ? (msg as { action: string }).action : "";
        const args = (msg as { args?: Record<string, unknown> }).args;
        if (appId && action) {
          this.opts.onAppAction?.({ appId, action, args });
        }
        break;
      }
      case "browser_audio_out":
        if (typeof msg.payload === "string") {
          const bin = atob(msg.payload);
          const buf = new ArrayBuffer(bin.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
          const alignedBytes = bin.length - (bin.length % 2);
          if (alignedBytes >= 2) {
            const pcm = new Int16Array(buf, 0, alignedBytes / 2);
            if (this.gatewayState === "speaking") {
              this.noteAudioLevel(rmsInt16(pcm));
            }
            void this.player.enqueuePcm24k(pcm);
          }
        }
        break;
      case "tts_end":
        void this.player.flush();
        break;
      case "clear_audio":
        this.player.stop();
        break;
      case "barge_in":
        this.player.stop();
        this.opts.onBargeIn?.();
        break;
      case "error":
        this.opts.onError?.(msg.message || "Voice gateway error");
        this.setGatewayState("error");
        break;
      default:
        break;
    }
  }

  private setGatewayState(state: VoiceSessionState): void {
    this.gatewayState = state;
    this.opts.onState?.(state);
  }
}

export { PCM24K_RATE };
