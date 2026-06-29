/**
 * OpenAI Realtime speech-to-speech WebSocket client (GA interface).
 * @see https://developers.openai.com/api/docs/guides/realtime-websocket
 */

import WebSocket from "ws";

import {
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL,
  OPENAI_REALTIME_REASONING_EFFORT,
  OPENAI_REALTIME_VOICE,
  PHONE_SYSTEM_PROMPT,
} from "./config.js";
import { REALTIME_TOOL_DEFINITIONS } from "./realtimeTools.js";
import { injectHermesResultUserText, type InjectPresentation } from "./speechPresentation.js";
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

export type {
  FunctionCallPayload,
  FunctionOutputOptions,
  OutputAudioDelta,
  RealtimeAudioFormat,
  RealtimeTurnDetection,
  RealtimeVadType,
  ResponseSpeechReason,
  SemanticVadEagerness,
  VoiceS2sConfig,
  VoiceS2sHandlers,
} from "./voiceS2sTypes.js";

/** @deprecated Use VoiceS2sConfig */
export type OpenAiRealtimeConfig = VoiceS2sConfig;
/** @deprecated Use VoiceS2sHandlers */
export type RealtimeClientHandlers = VoiceS2sHandlers;

const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;

const REALTIME_DEBUG = process.env.VOICE_REALTIME_DEBUG?.trim().toLowerCase() === "true";
const SPEECH_INSTRUCT_PREVIEW_CHARS = 500;

export class OpenAiRealtimeClient implements VoiceS2sClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private sessionReady = false;
  private responseSeq = 0;
  /** Set by requestResponse(); consumed on response.created to tag speech source. */
  private pendingResponseReason: ResponseSpeechReason | null = null;
  private responseInFlight = false;
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
    this.ws = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    this.ws.on("open", () => this.sendSessionUpdate());

    this.ws.on("message", (data) => {
      try {
        this.handleServerEvent(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (e) {
        this.handlers.onError?.(e instanceof Error ? e.message : String(e));
      }
    });

    this.ws.on("error", (err) => {
      this.handlers.onError?.(err instanceof Error ? err.message : String(err));
    });

    this.ws.on("close", () => {
      if (!this.closed) this.handlers.onError?.("OpenAI Realtime connection closed");
    });
  }

  private audioFormatPayload(): { type: string; rate?: number } {
    if (this.audioFormat === "pcm24") {
      return { type: "audio/pcm", rate: 24000 };
    }
    return { type: "audio/pcmu" };
  }

  private turnDetectionPayload(): Record<string, unknown> {
    const td = this.turnDetection;
    const vadType = td?.vadType ?? "server_vad";
    const shared = {
      type: vadType,
      ...(td?.createResponse != null ? { create_response: td.createResponse } : {}),
      ...(td?.interruptResponse != null ? { interrupt_response: td.interruptResponse } : {}),
    };
    if (vadType === "semantic_vad") {
      return {
        ...shared,
        ...(td?.eagerness ? { eagerness: td.eagerness } : {}),
      };
    }
    return {
      ...shared,
      ...(td?.threshold != null ? { threshold: td.threshold } : {}),
      ...(td?.prefixPaddingMs != null ? { prefix_padding_ms: td.prefixPaddingMs } : {}),
      ...(td?.silenceDurationMs != null ? { silence_duration_ms: td.silenceDurationMs } : {}),
    };
  }

  private reasoningPayload(): Record<string, unknown> | undefined {
    const effort = OPENAI_REALTIME_REASONING_EFFORT;
    if (!effort) return undefined;
    return { effort };
  }

  private sendSessionUpdate(): void {
    const format = this.audioFormatPayload();
    this.ws?.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: OPENAI_REALTIME_MODEL,
          instructions: this.systemPrompt,
          output_modalities: ["audio"],
          audio: {
            input: {
              format,
              turn_detection: this.turnDetectionPayload(),
              transcription: { model: "gpt-4o-mini-transcribe" },
            },
            output: {
              format,
              voice: OPENAI_REALTIME_VOICE,
            },
          },
          tools: [...REALTIME_TOOL_DEFINITIONS, ...(this.config.extraTools ?? [])],
          tool_choice: "auto",
          ...(this.reasoningPayload() ? { reasoning: this.reasoningPayload() } : {}),
        },
      }),
    );
  }

  appendMulaw8kB64(b64: string): void {
    if (this.audioFormat !== "pcmu") return;
    this.appendAudioB64(b64);
  }

  appendPcm24kB64(b64: string): void {
    if (this.audioFormat !== "pcm24") return;
    this.appendAudioB64(b64);
  }

  private appendAudioB64(b64: string): void {
    if (!this.canSend() || !b64) return;
    this.ws!.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: b64,
      }),
    );
  }

  sendFunctionOutput(callId: string, output: string, opts?: FunctionOutputOptions): void {
    if (!this.canSend()) return;
    if (REALTIME_DEBUG) {
      console.info(
        `[voice-realtime] openai → function_output callId=${callId} bytes=${output.length}`,
      );
    }
    this.ws!.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output,
        },
      }),
    );
    if (opts?.triggerResponse === false) {
      voiceLog(this.handlers.sessionId, "speech-instruct", "function_output only (no response.create)", {
        callId,
        outputPreview: output.slice(0, SPEECH_INSTRUCT_PREVIEW_CHARS),
      });
      return;
    }
    this.requestResponse("function_output_ack", output);
  }

  injectAssistantMessage(text: string): void {
    if (!this.canSend()) return;
    const instruct = injectHermesResultUserText(text, this.injectPresentation);
    this.logSpeechInstruct("hermes_inject", instruct);
    this.ws!.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: instruct,
            },
          ],
        },
      }),
    );
    this.requestResponse("hermes_inject", instruct);
  }

  injectProgressMessage(suggestedPhrase: string): void {
    if (!this.canSend()) return;
    const instruct = `[Progress — Joshu still working]\nSay ONLY 2–4 words, like "${suggestedPhrase}". Do not add anything else. Do NOT answer the user's question yet.`;
    this.logSpeechInstruct("progress", instruct);
    this.ws!.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: instruct,
            },
          ],
        },
      }),
    );
    this.requestResponse("progress", instruct);
  }

  /** Control-plane spoken line (greeting, unlock prompts, timeout notices). */
  injectControlMessage(text: string): void {
    if (!this.canSend()) return;
    const instruct =
      `[Call control message]\n` +
      `Say this exact message in one short sentence, naturally and clearly: "${text}"\n` +
      "Do not add extra details or instructions.";
    this.logSpeechInstruct("progress", instruct);
    this.ws!.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: instruct }],
        },
      }),
    );
    this.requestResponse("progress", instruct);
  }

  /** Phone: after a clear user transcript (create_response=false sessions). */
  requestOrganicResponse(): void {
    if (!this.canSend()) return;
    this.requestResponse("organic");
  }

  /** Phone: short reprompt when audio was heard but transcript is nonsense. */
  injectRepromptMessage(): void {
    if (!this.canSend()) return;
    const instruct =
      "[Could not understand the caller]\nSay ONE short sentence asking them to repeat, e.g. \"Sorry, I didn't catch that — could you say that again?\" Do not answer anything else.";
    this.logSpeechInstruct("reprompt", instruct);
    this.ws!.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: instruct }],
        },
      }),
    );
    this.requestResponse("reprompt", instruct);
  }

  cancelActiveResponse(): void {
    if (!this.canSend() || !this.responseInFlight) return;
    voiceLog(this.handlers.sessionId, "speech-instruct", "response.cancel");
    this.pendingResponseReason = null;
    this.ws!.send(JSON.stringify({ type: "response.cancel" }));
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
    voiceLog(this.handlers.sessionId, "speech-instruct", "conversation.item.create", extra);
  }

  private requestResponse(reason: ResponseSpeechReason, context?: string): void {
    this.responseSeq += 1;
    this.pendingResponseReason = reason;
    voiceLog(this.handlers.sessionId, "speech-instruct", `response.create #${this.responseSeq}`, {
      reason,
      contextPreview: context?.slice(0, SPEECH_INSTRUCT_PREVIEW_CHARS),
    });
    this.ws!.send(JSON.stringify({ type: "response.create" }));
  }
  truncateItem(itemId: string, audioEndMs: number): void {
    if (!this.canSend()) return;
    this.ws!.send(
      JSON.stringify({
        type: "conversation.item.truncate",
        item_id: itemId,
        content_index: 0,
        audio_end_ms: Math.max(0, Math.round(audioEndMs)),
      }),
    );
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private canSend(): boolean {
    return !this.closed && Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionReady);
  }

  private handleServerEvent(event: Record<string, unknown>): void {
    const type = event.type;
    const sid = this.handlers.sessionId;

    if (REALTIME_DEBUG && type && !String(type).includes("delta")) {
      console.info(`[voice-realtime] session=${sid ?? "?"} openai ← ${type}`);
    }

    if (type === "session.created" || type === "session.updated") {
      this.sessionReady = true;
      if (type === "session.created") this.handlers.onReady?.();
      return;
    }

    if (type === "response.created") {
      this.responseInFlight = true;
      const reason = this.pendingResponseReason ?? "organic";
      this.pendingResponseReason = null;
      this.handlers.onResponseStarted?.({ reason, seq: this.responseSeq || 1 });
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      this.handlers.onSpeechStarted?.();
      return;
    }

    if (type === "input_audio_buffer.speech_stopped") {
      this.handlers.onSpeechStopped?.();
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = typeof event.transcript === "string" ? event.transcript : "";
      const trimmed = transcript.trim();
      this.handlers.onTranscriptionComplete?.(trimmed);
      if (trimmed) this.handlers.onUserTranscript?.(trimmed);
      return;
    }

    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      const deltaB64 = typeof event.delta === "string" ? event.delta : "";
      const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
      if (deltaB64) this.handlers.onOutputAudioDelta?.({ deltaB64, itemId });
      return;
    }

    if (
      type === "response.output_audio_transcript.delta" ||
      type === "response.audio_transcript.delta"
    ) {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) this.handlers.onAssistantTranscript?.(delta);
      return;
    }

    if (type === "response.done") {
      this.responseInFlight = false;
      const response = event.response as Record<string, unknown> | undefined;
      const output = Array.isArray(response?.output) ? response.output : [];
      const functionCalls: FunctionCallPayload[] = [];
      for (const item of output) {
        const row = item as Record<string, unknown>;
        if (row.type !== "function_call") continue;
        const name = typeof row.name === "string" ? row.name : "";
        const callId = typeof row.call_id === "string" ? row.call_id : "";
        const args = typeof row.arguments === "string" ? row.arguments : "{}";
        if (name && callId) {
          functionCalls.push({ name, callId, argumentsJson: args });
        }
      }

      // Tool handlers before onResponseDone so browser can commit a single Hermes job per turn.
      for (const call of functionCalls) {
        this.handlers.onFunctionCall?.(call);
      }

      this.handlers.onResponseDone?.({
        status: response?.status,
        outputItems: output.length,
        functionCalls: functionCalls.map((c) => c.name),
      });
      return;
    }

    if (type === "error") {
      const err = event.error as Record<string, unknown> | undefined;
      this.handlers.onError?.(String(err?.message ?? event.message ?? "realtime error"));
    }
  }
}
