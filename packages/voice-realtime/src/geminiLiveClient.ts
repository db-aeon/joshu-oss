/**
 * Gemini Live API speech-to-speech WebSocket client.
 * @see https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 */

import WebSocket from "ws";

import { mulaw8kB64ToPcm16k, pcm24kB64ToMulaw8kB64, pcm24kB64ToPcm16k } from "./audioResample.js";
import {
  GEMINI_LIVE_MODEL,
  GEMINI_LIVE_VOICE,
  PHONE_SYSTEM_PROMPT,
  resolveGeminiApiKey,
} from "./config.js";
import { geminiToolDefinitions } from "./realtimeTools.js";
import {
  injectHermesResultUserText,
  type InjectKind,
  type InjectPresentation,
} from "./speechPresentation.js";
import { voiceLog } from "./voiceLog.js";
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
 * Why the in-flight generation is stale:
 * - `cancel` — we asked it to stop and nothing replaces it.
 * - `instruct` — a new instructed turn (inject, progress, …) replaces it; the
 *   old generation's trailing audio / interrupt / turnComplete must not be
 *   attributed to the new turn.
 */
type StaleGenerationCause = "cancel" | "instruct";

export class GeminiLiveClient implements VoiceS2sClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private sessionReady = false;
  private responseSeq = 0;
  private pendingResponseReason: ResponseSpeechReason | null = null;
  private responseInFlight = false;
  private turnFunctionCalls: string[] = [];
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
  private readonly audioFormat: RealtimeAudioFormat;
  private readonly systemPrompt: string;
  private readonly injectPresentation: InjectPresentation;
  private readonly turnDetection: RealtimeTurnDetection | undefined;

  constructor(
    private readonly config: VoiceS2sConfig,
    private readonly handlers: VoiceS2sHandlers,
  ) {
    this.audioFormat = config.audioFormat ?? "pcmu";
    this.systemPrompt = config.systemPrompt ?? PHONE_SYSTEM_PROMPT;
    this.injectPresentation = config.injectPresentation ?? "voice_only";
    this.turnDetection = config.turnDetection;
  }

  connect(): void {
    const apiKey = resolveGeminiApiKey();
    const url = `${GEMINI_WS_URL}?key=${encodeURIComponent(apiKey)}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => this.sendSetup());

    this.ws.on("message", (data) => {
      try {
        this.handleServerMessage(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (e) {
        this.handlers.onError?.(e instanceof Error ? e.message : String(e));
      }
    });

    this.ws.on("error", (err) => {
      this.handlers.onError?.(err instanceof Error ? err.message : String(err));
    });

    this.ws.on("close", () => {
      if (!this.closed) this.handlers.onError?.("Gemini Live connection closed");
    });
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
    this.ws?.send(
      JSON.stringify({
        setup: {
          model: `models/${GEMINI_LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: GEMINI_LIVE_VOICE },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: this.systemPrompt }],
          },
          tools: geminiToolDefinitions(this.config.extraTools ?? [], this.config.toolNames),
          realtimeInputConfig: {
            automaticActivityDetection: this.vadConfig(),
          },
          // Native-audio Live models auto-detect language; languageCode is unsupported.
          // Wrong-language STT is classified unclear in userInputGate (do not burn passphrase tries).
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      }),
    );
  }

  appendMulaw8kB64(b64: string): void {
    if (this.audioFormat !== "pcmu" || !this.canSend() || !b64) return;
    const samples16k = mulaw8kB64ToPcm16k(b64);
    if (samples16k.length === 0) return;
    const pcmBuf = Buffer.from(samples16k.buffer, samples16k.byteOffset, samples16k.byteLength);
    this.ws!.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: pcmBuf.toString("base64"),
            mimeType: "audio/pcm;rate=16000",
          },
        },
      }),
    );
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
    this.ws!.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: pcmBuf.toString("base64"),
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

    if (REALTIME_DEBUG) {
      console.info(
        `[voice-realtime] gemini → toolResponse callId=${callId} bytes=${output.length}`,
      );
    }

    const toolName = this.toolCallNames.get(callId) ?? "think";
    this.toolCallNames.delete(callId);

    this.ws!.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [
            {
              id: callId,
              name: toolName,
              response: parsed,
            },
          ],
        },
      }),
    );

    if (opts?.triggerResponse === false) {
      voiceLog(this.handlers.sessionId, "speech-instruct", "toolResponse only (no clientContent)", {
        callId,
        outputPreview: output.slice(0, SPEECH_INSTRUCT_PREVIEW_CHARS),
      });
      return;
    }

    this.markResponseStarted("function_output_ack", output);
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
    if (!this.canSend()) return;
    this.supersedeStreamingGeneration();
    this.markResponseStarted("organic");
    this.ws!.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "[Continue the conversation naturally.]" }] }],
          turnComplete: true,
        },
      }),
    );
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
    voiceLog(this.handlers.sessionId, "speech-instruct", "clientContent interrupt (barge-in)");
    this.openStaleWindow("cancel");
    this.pendingResponseReason = null;
    this.responseInFlight = false;
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
    this.ws?.close();
    this.ws = null;
  }

  private canSend(): boolean {
    return !this.closed && Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionReady);
  }

  private sendInstructClientContent(instruct: string, reason: ResponseSpeechReason): void {
    if (!this.canSend()) return;
    this.logSpeechInstruct(reason, instruct);
    this.supersedeStreamingGeneration();
    this.markResponseStarted(reason, instruct);
    this.ws!.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: instruct }] }],
          turnComplete: true,
        },
      }),
    );
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
    this.staleUntilMs = Date.now() + STALE_GENERATION_MAX_MS;
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
      this.sessionReady = true;
      this.handlers.onReady?.();
      return;
    }

    if (msg.toolCall) {
      this.handleToolCall(msg.toolCall as Record<string, unknown>);
      return;
    }

    if (msg.serverContent) {
      this.handleServerContent(msg.serverContent as Record<string, unknown>);
    }

    if (msg.error) {
      const err = msg.error as Record<string, unknown>;
      this.handlers.onError?.(String(err.message ?? err.status ?? "gemini live error"));
    }
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
      this.toolCallNames.set(callId, name);
      const payload: FunctionCallPayload = { name, callId, argumentsJson };
      this.handlers.onFunctionCall?.(payload);
    }
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
      const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
      this.lastOutputTranscript = full;
      if (delta) this.handlers.onAssistantTranscript?.(delta);
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
        if (!this.responseInFlight && this.pendingResponseReason == null) {
          this.markResponseStarted("organic");
        }
        const deltaB64 =
          this.audioFormat === "pcmu" ? pcm24kB64ToMulaw8kB64(data) : data;
        if (deltaB64) {
          const chunk: OutputAudioDelta = { deltaB64 };
          this.handlers.onOutputAudioDelta?.(chunk);
        }
      }
    }

    if (sc.generationComplete === true && !this.responseInFlight && !dropModelOutput) {
      this.markResponseStarted("organic");
    }

    if (sc.turnComplete === true) {
      this.generationStreaming = false;
      this.finishTurn(sc.interrupted === true, staleCause === "instruct");
    }

    if (endsGeneration && staleCause) this.closeStaleWindow();
  }

  /**
   * @param superseded the completed turn is the generation a newer instructed
   *   turn replaced — report the caller's transcript, but do not end the newer
   *   turn's response state or emit its response.done.
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
    });
  }
}
