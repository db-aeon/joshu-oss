/** Shared speech-to-speech client types (OpenAI Realtime + Gemini Live). */

export type RealtimeAudioFormat = "pcmu" | "pcm24";

export type RealtimeVadType = "server_vad" | "semantic_vad";
export type SemanticVadEagerness = "low" | "medium" | "high" | "auto";

export type RealtimeTurnDetection = {
  vadType?: RealtimeVadType;
  /** semantic_vad only — `low` waits for natural pauses (good for PSTN). */
  eagerness?: SemanticVadEagerness;
  /** server_vad only */
  threshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  /** When false, Joshu calls response.create only after a validated user transcript. */
  createResponse?: boolean;
  /** When false with createResponse, we handle barge-in via response.cancel (OpenAI manual-turn pattern). */
  interruptResponse?: boolean;
};

export type VoiceS2sConfig = {
  audioFormat?: RealtimeAudioFormat;
  systemPrompt?: string;
  injectPresentation?: import("./speechPresentation.js").InjectPresentation;
  /** Browser: higher threshold reduces noise / echo false turns. Phone uses provider defaults. */
  turnDetection?: RealtimeTurnDetection;
  /** App-specific fast tools merged into Realtime session (manifest voiceCommands). */
  extraTools?: Array<Record<string, unknown>>;
  /** Restrict declared base tools to those this surface implements (default: all). */
  toolNames?: readonly string[];
  /** Gemini only: override `GEMINI_LIVE_MODEL` (tests, per-surface experiments). */
  model?: string;
  /** Gemini 3.8 Live Extended Thinking only: background reasoning level. */
  thinkingLevel?: import("./config.js").GeminiThinkingLevel;
};

export type FunctionCallPayload = {
  name: string;
  callId: string;
  argumentsJson: string;
};

export type OutputAudioDelta = {
  deltaB64: string;
  itemId?: string;
};

export type FunctionOutputOptions = {
  /** When false, only records tool output — caller triggers speech separately (avoids duplicate summaries). */
  triggerResponse?: boolean;
};

export type ResponseSpeechReason =
  | "organic"
  | "function_output_ack"
  /** Native async tools: the model speaking a tool result it just received. */
  | "function_result"
  | "hermes_inject"
  | "progress"
  | "reprompt";

export type VoiceS2sHandlers = {
  sessionId?: string;
  onReady?: () => void;
  onOutputAudioDelta?: (chunk: OutputAudioDelta) => void;
  onSpeechStarted?: () => void;
  /** Model generation cut short (Gemini `interrupted` after Joshu cancel — not user speech). */
  onInterrupted?: () => void;
  /** Gemini Live: input transcription arrived (may precede turnComplete / model audio). */
  onInputTranscript?: (text: string) => void;
  onSpeechStopped?: () => void;
  onUserTranscript?: (text: string) => void;
  /** Always fired (including empty) when input audio transcription completes. */
  onTranscriptionComplete?: (text: string) => void;
  onAssistantTranscript?: (delta: string) => void;
  /** Fired when the provider begins generating a spoken response. */
  onResponseStarted?: (info: { reason: ResponseSpeechReason; seq: number }) => void;
  onResponseDone?: (info: Record<string, unknown>) => void;
  onFunctionCall?: (call: FunctionCallPayload) => void;
  /**
   * Gemini 3.8: the whole interaction finished (`interactionStatus: IDLE`) — no background
   * reasoning or async tool calls outstanding. `functionCalls` lists every tool call the
   * interaction made, including ones that arrived after the spoken turn completed.
   */
  onInteractionIdle?: (info: { functionCalls: string[] }) => void;
  /** Upstream session was transparently resumed on a new socket (Gemini goAway / drop). */
  onSessionResumed?: (info: { reason: string }) => void;
  onError?: (message: string) => void;
};

/** Browser + phone speech-to-speech upstream (OpenAI Realtime or Gemini Live). */
export interface VoiceS2sClient {
  /**
   * True when the model runs tools asynchronously and speaks their results itself
   * (Gemini 3.8 Live). Sessions then skip the legacy handler-owned speech: wait
   * lines, progress ticks, silent tool acks, and injected results.
   */
  readonly nativeAsyncTools: boolean;
  connect(): void;
  appendMulaw8kB64(b64: string): void;
  appendPcm24kB64(b64: string): void;
  /** Legacy: tool output, optionally with a silence hint and no spoken response. */
  sendFunctionOutput(callId: string, output: string, opts?: FunctionOutputOptions): void;
  /** Native path: deliver a finished tool result; the model decides how to speak it. */
  sendFunctionResult(callId: string, result: Record<string, unknown>): void;
  /** Add background context to the conversation without asking the model to speak. */
  appendContext(text: string): void;
  injectAssistantMessage(text: string, kind?: import("./speechPresentation.js").InjectKind): void;
  injectProgressMessage(suggestedPhrase: string): void;
  injectControlMessage(text: string): void;
  requestOrganicResponse(): void;
  injectRepromptMessage(): void;
  cancelActiveResponse(): void;
  truncateItem(itemId: string, audioEndMs: number): void;
  close(): void;
}
