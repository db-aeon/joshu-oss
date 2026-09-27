/**
 * Gemini Live API speech-to-speech WebSocket client.
 * @see https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 *
 * Two tool modes, chosen by model:
 * - Legacy (3.1 Flash Live): blocking tools. Sessions fake async with a silent tool ack,
 *   handler-owned wait lines, and the brain result injected as a user turn.
 * - Native (3.8 Live): `NON_BLOCKING` tools. The result goes back as a function response
 *   (`sendFunctionResult`) and the model speaks it. `turnComplete` no longer means idle —
 *   `interactionStatus` does.
 */

import WebSocket from "ws";

import { mulaw8kB64ToPcm16k, pcm24kB64ToMulaw8kB64, pcm24kB64ToPcm16k } from "./audioResample.js";
import {
  GEMINI_LIVE_MODEL,
  GEMINI_LIVE_RESULT_SCHEDULING,
  GEMINI_LIVE_VOICE,
  geminiLiveModelSupportsThinkingConfig,
  geminiLiveModelUsesAsyncTools,
  PHONE_SYSTEM_PROMPT,
  resolveGeminiApiKey,
} from "./config.js";
import { geminiToolDefinitions } from "./realtimeTools.js";
import {
  injectHermesResultUserText,
  type InjectKind,
  type InjectPresentation,
} from "./speechPresentation.js";
import { voiceLog, voiceWarn } from "./voiceLog.js";
import type {
  FunctionCallPayload,
  FunctionOutputOptions,
  OutputAudioDelta,
  RealtimeAudioFormat,
  RealtimeTurnDetection,
  ResponseSpeechReason,
  VoiceS2sClient,
  VoiceS2sConfig,
  VoiceS2sHandlers,
} from "./voiceS2sTypes.js";

const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const REALTIME_DEBUG = process.env.VOICE_REALTIME_DEBUG?.trim().toLowerCase() === "true";
const SPEECH_INSTRUCT_PREVIEW_CHARS = 500;
/**
 * Upper bound on how long we drop audio from a generation we asked Gemini to
 * abandon. Normally Gemini ends it sooner with `interrupted` / `turnComplete`;
 * the bound keeps a missing ack from muting the next reply indefinitely.
 */
const STALE_GENERATION_MAX_MS = 2500;
/**
 * Native path: cancel is local-only (no interrupt is sent, so none comes back) and the
 * generation runs to turnComplete — mute it that long. Bounded so a lost turnComplete
 * cannot mute the next reply forever.
 */
const NATIVE_CANCEL_MUTE_MAX_MS = 20_000;
/** Native: longest a Joshu turn waits for the model's current reply to finish. */
const NATIVE_TURN_DEFER_MAX_MS = 12_000;
/**
 * Consecutive failed resume attempts before the drop is reported as an error.
 * Resets after every successful resume, so long calls can resume repeatedly
 * (Gemini sends `goAway` before each connection lifetime ends).
 */
const MAX_RESUME_ATTEMPTS = 3;

/**
 * Why the in-flight generation is stale:
 * - `cancel` — we asked it to stop and nothing replaces it.
 * - `instruct` — a new instructed turn (inject, progress, …) replaces it; the
 *   old generation's trailing audio / interrupt / turnComplete must not be
 *   attributed to the new turn.
 */
type StaleGenerationCause = "cancel" | "instruct";

type InteractionStatus = "IN_PROGRESS" | "IDLE";

/** `interactionStatus` may be top-level or inside serverContent; values may carry an enum prefix. */
function readInteractionStatus(msg: Record<string, unknown>): InteractionStatus | null {
  const sc = msg.serverContent as Record<string, unknown> | undefined;
  const raw =
    msg.interactionStatus ?? msg.interaction_status ?? sc?.interactionStatus ?? sc?.interaction_status;
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  if (value.endsWith("IN_PROGRESS")) return "IN_PROGRESS";
  if (value.endsWith("IDLE")) return "IDLE";
  return null;
}

export class GeminiLiveClient implements VoiceS2sClient {
  readonly nativeAsyncTools: boolean;
  private ws: WebSocket | null = null;
  /** Previous socket during a resume — still drained until the new one is ready. */
  private retiringWs: WebSocket | null = null;
  private closed = false;
  private sessionReady = false;
  /** onReady fires once per client; resumes report via onSessionResumed. */
  private readyFired = false;
  /** Latest resumable handle from `sessionResumptionUpdate`. */
  private resumptionHandle: string | null = null;
  private resumeReason: string | null = null;
  private resumeAttempts = 0;
  private responseSeq = 0;
  private pendingResponseReason: ResponseSpeechReason | null = null;
  /**
   * Reason for the next generation that starts on its own (native path: the model
   * speaking a function result we just sent). Consumed when its first audio lands.
   */
  private nextGenerationReason: ResponseSpeechReason | null = null;
  private responseInFlight = false;
  private turnFunctionCalls: string[] = [];
  /** Native path: every tool call since the interaction last went IDLE. */
  private interactionFunctionCalls: string[] = [];
  private interactionStatus: InteractionStatus | null = null;
  /** Native: Joshu turns waiting for the model to finish speaking (see sendClientTurn). */
  private deferredTurns: Array<() => void> = [];
  private deferTimer: ReturnType<typeof setTimeout> | null = null;
  private toolCallNames = new Map<string, string>();
  private pendingUserTranscript = "";
  private lastOutputTranscript = "";
  /** Avoid spamming onInputTranscript when Gemini refines the same turn. */
  private lastEmittedInputTranscript = "";
  /**
   * Gemini Live has no response.cancel: an in-flight generation keeps
   * streaming until the server acknowledges with `interrupted` or finishes
   * with `turnComplete`. While this window is open its audio is dropped and
   * its interrupt is ours, not the caller barging in.
   */
  private staleCause: StaleGenerationCause | null = null;
  private staleUntilMs = 0;
  /** Model audio seen since the last turnComplete / interrupted. */
  private generationStreaming = false;
  private readonly model: string;
  private readonly audioFormat: RealtimeAudioFormat;
  private readonly systemPrompt: string;
  private readonly injectPresentation: InjectPresentation;
  private readonly turnDetection: RealtimeTurnDetection | undefined;

  constructor(
    private readonly config: VoiceS2sConfig,
    private readonly handlers: VoiceS2sHandlers,
  ) {
    this.model = config.model?.trim() || GEMINI_LIVE_MODEL;
    this.nativeAsyncTools = geminiLiveModelUsesAsyncTools(this.model);
    this.audioFormat = config.audioFormat ?? "pcmu";
    this.systemPrompt = config.systemPrompt ?? PHONE_SYSTEM_PROMPT;
    this.injectPresentation = config.injectPresentation ?? "voice_only";
    this.turnDetection = config.turnDetection;
  }

  connect(): void {
    this.openSocket();
  }

  /** Socket factory — tests substitute a fake. */
  createSocket(url: string): WebSocket {
    return new WebSocket(url);
  }

  private openSocket(): void {
    const apiKey = resolveGeminiApiKey();
    const socket = this.createSocket(`${GEMINI_WS_URL}?key=${encodeURIComponent(apiKey)}`);
    this.ws = socket;
    this.sessionReady = false;

    socket.on("open", () => {
      if (socket === this.ws) this.sendSetup();
    });

    socket.on("message", (data) => {
      // A retiring socket still drains output that was already in flight.
      if (socket !== this.ws && socket !== this.retiringWs) return;
      try {
        this.handleServerMessage(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (e) {
        this.handlers.onError?.(e instanceof Error ? e.message : String(e));
      }
    });

    socket.on("error", (err) => {
      if (socket !== this.ws) return;
      this.handlers.onError?.(err instanceof Error ? err.message : String(err));
    });

    socket.on("close", () => {
      if (socket === this.retiringWs) {
        this.retiringWs = null;
        return;
      }
      if (socket !== this.ws || this.closed) return;
      // Unexpected drop (or a resume attempt that failed before setupComplete).
      this.resumeReason = null;
      if (this.resumptionHandle && this.resumeAttempts < MAX_RESUME_ATTEMPTS) {
        this.resume("socket closed");
        return;
      }
      this.handlers.onError?.("Gemini Live connection closed");
    });
  }

  /**
   * Reconnect on a new socket with the stored resumption handle. The server
   * restores the conversation, so the caller does not notice beyond a short gap.
   */
  private resume(reason: string): void {
    if (this.closed || this.resumeReason) return;
    this.resumeReason = reason;
    this.resumeAttempts += 1;
    voiceLog(this.handlers.sessionId, "gemini", "resuming session", {
      reason,
      attempt: this.resumeAttempts,
      hasHandle: Boolean(this.resumptionHandle),
    });
    const previous = this.ws;
    this.retiringWs = previous && previous.readyState === WebSocket.OPEN ? previous : null;
    this.resetGenerationState();
    this.openSocket();
  }

  /** Generation bookkeeping does not survive a socket swap. */
  private resetGenerationState(): void {
    if (this.responseInFlight) {
      this.handlers.onResponseDone?.({ status: "cancelled", outputItems: 0, functionCalls: [] });
    }
    this.responseInFlight = false;
    this.pendingResponseReason = null;
    this.nextGenerationReason = null;
    this.generationStreaming = false;
    this.turnFunctionCalls = [];
    this.lastOutputTranscript = "";
    this.closeStaleWindow();
  }

  private vadConfig(): Record<string, unknown> {
    const td = this.turnDetection;
    // Higher OpenAI threshold ≈ less sensitive; map browser defaults to conservative Gemini VAD.
    const threshold = td?.threshold ?? 0.5;
    const startSensitivity = threshold >= 0.65 ? "START_SENSITIVITY_LOW" : "START_SENSITIVITY_HIGH";
    const endSensitivity = threshold >= 0.65 ? "END_SENSITIVITY_LOW" : "END_SENSITIVITY_HIGH";
    return {
      disabled: false,
      startOfSpeechSensitivity: startSensitivity,
      endOfSpeechSensitivity: endSensitivity,
      ...(td?.prefixPaddingMs != null ? { prefixPaddingMs: td.prefixPaddingMs } : {}),
      ...(td?.silenceDurationMs != null ? { silenceDurationMs: td.silenceDurationMs } : {}),
    };
  }

  private sendSetup(): void {
    const thinkingLevel =
      geminiLiveModelSupportsThinkingConfig(this.model) && this.config.thinkingLevel
        ? this.config.thinkingLevel
        : undefined;
    this.ws?.send(
      JSON.stringify({
        setup: {
          model: `models/${this.model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: GEMINI_LIVE_VOICE },
              },
            },
            ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
          },
          systemInstruction: {
            parts: [{ text: this.systemPrompt }],
          },
          tools: geminiToolDefinitions(this.config.extraTools ?? [], this.config.toolNames, {
            nativeAsyncTools: this.nativeAsyncTools,
          }),
          // Native: Gemini's own turn-taking (VAD + always-on proactive audio) decides when
          // the caller is done — our sensitivity/silence overrides split sentences on "mmm".
          ...(this.nativeAsyncTools
            ? {}
            : { realtimeInputConfig: { automaticActivityDetection: this.vadConfig() } }),
          // Native-audio Live models auto-detect language; languageCode is unsupported.
          // Wrong-language STT is classified unclear in userInputGate (do not burn passphrase tries).
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // Long calls: resumable handles survive connection resets / goAway, and the
          // sliding window keeps the context from hitting the session length limit.
          sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
          contextWindowCompression: { slidingWindow: {} },
        },
      }),
    );
  }

  appendMulaw8kB64(b64: string): void {
    if (this.audioFormat !== "pcmu" || !this.canSend() || !b64) return;
    const samples16k = mulaw8kB64ToPcm16k(b64);
    if (samples16k.length === 0) return;
    const pcmBuf = Buffer.from(samples16k.buffer, samples16k.byteOffset, samples16k.byteLength);
    this.sendRealtimeAudio(pcmBuf);
  }

  appendPcm24kB64(b64: string): void {
    if (this.audioFormat !== "pcm24" || !this.canSend() || !b64) return;
    const raw = Buffer.from(b64, "base64");
    if (raw.length < 2) return;
    const aligned = raw.length - (raw.length % 2);
    const samples24k = new Int16Array(
      raw.buffer,
      raw.byteOffset,
      aligned / Int16Array.BYTES_PER_ELEMENT,
    );
    const samples16k = pcm24kB64ToPcm16k(samples24k);
    if (samples16k.length === 0) return;
    const pcmBuf = Buffer.from(samples16k.buffer, samples16k.byteOffset, samples16k.byteLength);
    this.sendRealtimeAudio(pcmBuf);
  }

  private sendRealtimeAudio(pcm16k: Buffer): void {
    this.ws!.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: pcm16k.toString("base64"),
            mimeType: "audio/pcm;rate=16000",
          },
        },
      }),
    );
  }

  sendFunctionOutput(callId: string, output: string, opts?: FunctionOutputOptions): void {
    if (!this.canSend()) return;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(output) as Record<string, unknown>;
    } catch {
      parsed = { result: output };
    }

    if (opts?.triggerResponse === false) {
      parsed = {
        ...parsed,
        silent: true,
        instruction:
          "Do not speak. Remain completely silent. Do not answer the user's question or guess personal data. Wait only for an injected progress or result message.",
      };
    }

    this.sendToolResponse(callId, parsed, output.length);

    if (opts?.triggerResponse === false) {
      voiceLog(this.handlers.sessionId, "speech-instruct", "toolResponse only (no clientContent)", {
        callId,
        outputPreview: output.slice(0, SPEECH_INSTRUCT_PREVIEW_CHARS),
      });
      return;
    }

    this.markResponseStarted("function_output_ack", output);
  }

  sendFunctionResult(callId: string, result: Record<string, unknown>): void {
    if (!this.canSend()) return;
    const response = GEMINI_LIVE_RESULT_SCHEDULING
      ? { ...result, scheduling: GEMINI_LIVE_RESULT_SCHEDULING }
      : result;
    const json = JSON.stringify(response);
    this.sendToolResponse(callId, response, json.length);
    // The model speaks the result on its own schedule; label that generation when it starts.
    // Mid-speech it may fold the answer into the current generation instead.
    if (!this.responseInFlight) this.nextGenerationReason = "function_result";
    voiceLog(this.handlers.sessionId, "speech-instruct", "toolResponse (native result)", {
      callId,
      outputPreview: json.slice(0, SPEECH_INSTRUCT_PREVIEW_CHARS),
    });
  }

  private sendToolResponse(callId: string, response: Record<string, unknown>, bytes: number): void {
    if (REALTIME_DEBUG) {
      console.info(`[voice-realtime] gemini → toolResponse callId=${callId} bytes=${bytes}`);
    }
    const toolName = this.toolCallNames.get(callId) ?? "think";
    this.toolCallNames.delete(callId);
    this.ws!.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [{ id: callId, name: toolName, response }],
        },
      }),
    );
  }

  appendContext(text: string): void {
    if (!this.canSend() || !text.trim()) return;
    // turnComplete=false adds context without asking for (or interrupting) a reply.
    this.ws!.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: false,
        },
      }),
    );
    voiceLog(this.handlers.sessionId, "speech-instruct", "clientContent context (no turn)", {
      chars: text.length,
    });
  }

  injectAssistantMessage(text: string, kind?: InjectKind): void {
    this.sendInstructClientContent(
      injectHermesResultUserText(text, this.injectPresentation, kind),
      "hermes_inject",
    );
  }

  injectProgressMessage(suggestedPhrase: string): void {
    const instruct = `[Progress — Joshu still working]\nSay ONLY 2–4 words, like "${suggestedPhrase}". Do not add anything else. Do NOT answer the user's question yet.`;
    this.sendInstructClientContent(instruct, "progress");
  }

  injectControlMessage(text: string): void {
    const instruct =
      `[Call control message]\n` +
      `Say this exact message in one short sentence, naturally and clearly: "${text}"\n` +
      "Do not add extra details or instructions.";
    this.sendInstructClientContent(instruct, "progress");
  }

  requestOrganicResponse(): void {
    this.sendClientTurn("[Continue the conversation naturally.]", "organic");
  }

  /** Send a typed user turn (smoke tests / text-driven checks; calls use audio). */
  sendUserText(text: string): void {
    this.sendClientTurn(text, "organic", text);
  }

  injectRepromptMessage(): void {
    const instruct =
      "[Could not understand the caller]\nSay ONE short sentence asking them to repeat, e.g. \"Sorry, I didn't catch that — could you say that again?\" Do not answer anything else.";
    this.sendInstructClientContent(instruct, "reprompt");
  }

  cancelActiveResponse(): void {
    if (!this.canSend()) return;
    // Already cancelled and still draining: its remaining chunks are dropped.
    if (this.staleWindowCause() === "cancel") return;
    if (!this.responseInFlight && !this.generationStreaming) return;
    this.openStaleWindow("cancel");
    this.pendingResponseReason = null;
    this.responseInFlight = false;
    if (this.nativeAsyncTools) {
      // 3.8 reads an externally aborted generation as a failure and tells the caller
      // "a system error occurred" (canary box 2026-09-25). Mute locally instead; a
      // real barge-in is already handled by Gemini's own VAD.
      voiceLog(this.handlers.sessionId, "speech-instruct", "local mute (native cancel, no interrupt sent)");
      return;
    }
    voiceLog(this.handlers.sessionId, "speech-instruct", "clientContent interrupt (barge-in)");
    // Best-effort nudge; Gemini may keep generating — the stale window mutes it.
    this.ws!.send(
      JSON.stringify({
        clientContent: {
          turns: [],
          turnComplete: false,
        },
      }),
    );
  }

  truncateItem(_itemId: string, _audioEndMs: number): void {
    // Gemini Live has no OpenAI-style conversation.item.truncate — barge-in uses interrupted + cancel.
  }

  close(): void {
    this.closed = true;
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
    this.deferredTurns = [];
    this.retiringWs?.close();
    this.retiringWs = null;
    this.ws?.close();
    this.ws = null;
  }

  private canSend(): boolean {
    return !this.closed && Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionReady);
  }

  private sendInstructClientContent(instruct: string, reason: ResponseSpeechReason): void {
    if (!this.canSend()) return;
    this.logSpeechInstruct(reason, instruct);
    this.sendClientTurn(instruct, reason, instruct);
  }

  /**
   * One Joshu-authored turn (`turnComplete: true`) that asks the model to speak.
   * Legacy: sent now, superseding any in-flight generation. Native: waits for the model
   * to finish its current reply — 3.8 treats a turn that cuts it off as a failure and
   * tells the caller "a system error occurred" (canary box callback replay 2026-09-25).
   */
  private sendClientTurn(text: string, reason: ResponseSpeechReason, logContext?: string): void {
    if (!this.canSend()) return;
    this.whenModelIdle(() => {
      if (!this.canSend()) return;
      this.supersedeStreamingGeneration();
      this.markResponseStarted(reason, logContext);
      this.ws!.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true,
          },
        }),
      );
    });
  }

  /** Native: run `send` once the model is not mid-reply (bounded); legacy: now. */
  private whenModelIdle(send: () => void): void {
    const busy = this.nativeAsyncTools && (this.generationStreaming || this.responseInFlight);
    if (!busy && this.deferredTurns.length === 0) {
      send();
      return;
    }
    this.deferredTurns.push(send);
    voiceLog(this.handlers.sessionId, "speech-instruct", "turn deferred until model finishes speaking", {
      queued: this.deferredTurns.length,
    });
    if (!this.deferTimer) {
      this.deferTimer = setTimeout(() => this.flushDeferredTurn(), NATIVE_TURN_DEFER_MAX_MS);
      this.deferTimer.unref?.();
    }
  }

  /** Send the next deferred turn; later ones wait for the reply it starts. */
  private flushDeferredTurn(): void {
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
    const next = this.deferredTurns.shift();
    next?.();
    if (this.deferredTurns.length > 0 && !this.deferTimer) {
      this.deferTimer = setTimeout(() => this.flushDeferredTurn(), NATIVE_TURN_DEFER_MAX_MS);
      this.deferTimer.unref?.();
    }
  }

  /** Sending new clientContent mid-stream replaces the old generation (Gemini interrupts it). */
  private supersedeStreamingGeneration(): void {
    if (this.generationStreaming) {
      this.openStaleWindow("instruct");
      return;
    }
    // Cancelled before any audio: nothing to drain, and keeping the window
    // open would mute the turn we are about to request.
    if (this.staleCause === "cancel") this.closeStaleWindow();
  }

  private openStaleWindow(cause: StaleGenerationCause): void {
    // A cancel followed by an instruct is still "replaced by a new turn".
    this.staleCause = cause;
    const maxMs =
      this.nativeAsyncTools && cause === "cancel" ? NATIVE_CANCEL_MUTE_MAX_MS : STALE_GENERATION_MAX_MS;
    this.staleUntilMs = Date.now() + maxMs;
  }

  private closeStaleWindow(): void {
    this.staleCause = null;
    this.staleUntilMs = 0;
  }

  /** Current stale cause, or null once the window closed or timed out. */
  private staleWindowCause(): StaleGenerationCause | null {
    if (this.staleCause && Date.now() >= this.staleUntilMs) this.closeStaleWindow();
    return this.staleCause;
  }

  private markResponseStarted(reason: ResponseSpeechReason, context?: string): void {
    this.responseSeq += 1;
    this.pendingResponseReason = reason;
    this.responseInFlight = true;
    // An instructed turn replaces whatever the next self-started generation would have been.
    this.nextGenerationReason = null;
    voiceLog(this.handlers.sessionId, "speech-instruct", `gemini turn #${this.responseSeq}`, {
      reason,
      contextPreview: context?.slice(0, SPEECH_INSTRUCT_PREVIEW_CHARS),
    });
    this.handlers.onResponseStarted?.({ reason, seq: this.responseSeq });
  }

  private logSpeechInstruct(reason: string, instruct: string): void {
    const preview = instruct.slice(0, SPEECH_INSTRUCT_PREVIEW_CHARS);
    const extra: Record<string, unknown> = {
      reason,
      chars: instruct.length,
      preview,
    };
    if (REALTIME_DEBUG && instruct.length > SPEECH_INSTRUCT_PREVIEW_CHARS) {
      extra.full = instruct;
    }
    voiceLog(this.handlers.sessionId, "speech-instruct", "clientContent", extra);
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    const sid = this.handlers.sessionId;

    if (REALTIME_DEBUG) {
      const keys = Object.keys(msg).filter((k) => k !== "usageMetadata");
      if (keys.length > 0) {
        console.info(`[voice-realtime] session=${sid ?? "?"} gemini ← ${keys.join(",")}`);
      }
    }

    if (msg.setupComplete != null) {
      this.handleSetupComplete();
      return;
    }

    if (msg.sessionResumptionUpdate) {
      const update = msg.sessionResumptionUpdate as Record<string, unknown>;
      if (update.resumable !== false && typeof update.newHandle === "string" && update.newHandle) {
        this.resumptionHandle = update.newHandle;
      }
    }

    if (msg.goAway) {
      const timeLeft = (msg.goAway as Record<string, unknown>).timeLeft;
      if (this.resumptionHandle) {
        this.resume(`goAway timeLeft=${String(timeLeft ?? "?")}`);
      } else {
        voiceWarn(sid, "gemini", "goAway without a resumption handle — session will end", { timeLeft });
      }
    }

    // Read first: a message may carry turnComplete and IDLE together.
    const status = readInteractionStatus(msg);
    if (status) this.interactionStatus = status;

    if (msg.toolCall) {
      this.handleToolCall(msg.toolCall as Record<string, unknown>);
    }

    if (msg.serverContent) {
      this.handleServerContent(msg.serverContent as Record<string, unknown>);
    }

    if (status === "IDLE") this.handleInteractionIdle();

    if (msg.error) {
      const err = msg.error as Record<string, unknown>;
      this.handlers.onError?.(String(err.message ?? err.status ?? "gemini live error"));
    }
  }

  private handleSetupComplete(): void {
    this.sessionReady = true;
    const resumedFor = this.resumeReason;
    if (resumedFor) {
      this.resumeReason = null;
      this.resumeAttempts = 0;
      this.retiringWs?.close();
      voiceLog(this.handlers.sessionId, "gemini", "session resumed", { reason: resumedFor });
      this.handlers.onSessionResumed?.({ reason: resumedFor });
      return;
    }
    this.resumeAttempts = 0;
    if (this.readyFired) return;
    this.readyFired = true;
    this.handlers.onReady?.();
  }

  private handleToolCall(toolCall: Record<string, unknown>): void {
    const calls = Array.isArray(toolCall.functionCalls) ? toolCall.functionCalls : [];
    for (const row of calls) {
      const fc = row as Record<string, unknown>;
      const name = typeof fc.name === "string" ? fc.name : "";
      const callId = typeof fc.id === "string" ? fc.id : "";
      const args = fc.args ?? {};
      const argumentsJson = JSON.stringify(args);
      if (!name || !callId) continue;
      this.turnFunctionCalls.push(name);
      if (this.nativeAsyncTools) this.interactionFunctionCalls.push(name);
      this.toolCallNames.set(callId, name);
      const payload: FunctionCallPayload = { name, callId, argumentsJson };
      this.handlers.onFunctionCall?.(payload);
    }
  }

  /**
   * Native path: the interaction is over — no background reasoning or async tool
   * calls outstanding. Reports every tool call it made, including late ones that
   * arrived after the spoken turn completed (and so missed that response.done).
   */
  private handleInteractionIdle(): void {
    if (!this.nativeAsyncTools) return;
    const functionCalls = this.interactionFunctionCalls;
    this.interactionFunctionCalls = [];
    this.handlers.onInteractionIdle?.({ functionCalls });
  }

  private handleServerContent(sc: Record<string, unknown>): void {
    // Evaluate once: interrupted and turnComplete can arrive in the same message
    // and both belong to the stale generation.
    const staleCause = this.staleWindowCause();
    const endsGeneration = sc.interrupted === true || sc.turnComplete === true;

    if (sc.interrupted === true) {
      this.generationStreaming = false;
      if (staleCause === "instruct") {
        // Old generation acknowledged; the instructed turn that replaced it
        // keeps its reason (else its audio is mislabeled "organic").
        this.handlers.onInterrupted?.();
      } else {
        this.responseInFlight = false;
        this.pendingResponseReason = null;
        if (staleCause === "cancel") {
          this.handlers.onInterrupted?.();
        } else {
          // Gemini's server VAD heard the caller over the model: barge-in.
          this.handlers.onSpeechStarted?.();
        }
      }
    }

    const inputTx = sc.inputTranscription as Record<string, unknown> | undefined;
    if (inputTx && typeof inputTx.text === "string") {
      const text = inputTx.text.trim();
      if (text) {
        this.pendingUserTranscript = text;
        if (text !== this.lastEmittedInputTranscript) {
          this.lastEmittedInputTranscript = text;
          this.handlers.onInputTranscript?.(text);
        }
      }
    }

    // Audio/text from a generation we abandoned never reaches the caller or transcript.
    const dropModelOutput = staleCause != null && !endsGeneration;

    const outputTx = sc.outputTranscription as Record<string, unknown> | undefined;
    if (outputTx && typeof outputTx.text === "string" && !dropModelOutput) {
      const full = outputTx.text;
      const prev = this.lastOutputTranscript;
      // 3.8 proactive audio marks a deliberate non-reply (fillers, half sentences)
      // with a literal "<no speech>" transcript — not something the caller heard.
      const delta = (full.startsWith(prev) ? full.slice(prev.length) : full).replace(
        /<no speech>/gi,
        "",
      );
      this.lastOutputTranscript = full;
      if (delta.trim()) this.handlers.onAssistantTranscript?.(delta);
    }

    const modelTurn = sc.modelTurn as Record<string, unknown> | undefined;
    const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
    for (const part of parts) {
      const row = part as Record<string, unknown>;
      const inlineData = row.inlineData as Record<string, unknown> | undefined;
      const data = typeof inlineData?.data === "string" ? inlineData.data : "";
      if (data) {
        this.generationStreaming = true;
        if (dropModelOutput) continue;
        if (!this.responseInFlight) this.startSelfInitiatedGeneration();
        const deltaB64 =
          this.audioFormat === "pcmu" ? pcm24kB64ToMulaw8kB64(data) : data;
        if (deltaB64) {
          const chunk: OutputAudioDelta = { deltaB64 };
          this.handlers.onOutputAudioDelta?.(chunk);
        }
      }
    }

    if (sc.generationComplete === true && !this.responseInFlight && !dropModelOutput) {
      this.startSelfInitiatedGeneration();
    }

    if (sc.turnComplete === true) {
      this.generationStreaming = false;
      this.finishTurn(sc.interrupted === true, staleCause === "instruct");
    }

    if (endsGeneration && staleCause) this.closeStaleWindow();
  }

  /** A generation we did not request: organic reply, or (native) the model speaking a tool result. */
  private startSelfInitiatedGeneration(): void {
    const reason = this.nextGenerationReason ?? "organic";
    this.nextGenerationReason = null;
    this.markResponseStarted(reason);
  }

  /**
   * @param superseded the completed turn is the generation a newer instructed
   *   turn replaced — report the caller's transcript, but do not end the newer
   *   turn's response state or emit its response.done.
   *
   * One response.done per generation on both paths. On 3.8 the interaction can
   * stay IN_PROGRESS for the whole tool run, so waiting for IDLE here would hold
   * the "let me check" audio tail until the brain finished; IDLE is reported
   * separately via onInteractionIdle.
   */
  private finishTurn(interrupted: boolean, superseded = false): void {
    const transcript = this.pendingUserTranscript;
    this.pendingUserTranscript = "";
    this.lastOutputTranscript = "";
    this.lastEmittedInputTranscript = "";

    if (transcript) {
      this.handlers.onTranscriptionComplete?.(transcript);
      this.handlers.onUserTranscript?.(transcript);
    } else {
      this.handlers.onTranscriptionComplete?.("");
    }

    if (superseded) {
      this.turnFunctionCalls = [];
      return;
    }

    const functionCalls = [...this.turnFunctionCalls];
    this.turnFunctionCalls = [];
    this.responseInFlight = false;
    this.pendingResponseReason = null;

    this.handlers.onResponseDone?.({
      status: interrupted ? "cancelled" : "complete",
      outputItems: functionCalls.length,
      functionCalls,
      ...(this.nativeAsyncTools && this.interactionStatus
        ? { interactionStatus: this.interactionStatus }
        : {}),
    });
    // The model finished its reply — a waiting Joshu turn can go now without cutting it off.
    if (this.deferredTurns.length > 0) this.flushDeferredTurn();
  }
}
