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
  onError?: (message: string) => void;
};

/** Browser + phone speech-to-speech upstream (OpenAI Realtime or Gemini Live). */
export interface VoiceS2sClient {
  connect(): void;
  appendMulaw8kB64(b64: string): void;
  appendPcm24kB64(b64: string): void;
  sendFunctionOutput(callId: string, output: string, opts?: FunctionOutputOptions): void;
  injectAssistantMessage(text: string): void;
  injectProgressMessage(suggestedPhrase: string): void;
  injectControlMessage(text: string): void;
  requestOrganicResponse(): void;
  injectRepromptMessage(): void;
  cancelActiveResponse(): void;
  truncateItem(itemId: string, audioEndMs: number): void;
  close(): void;
}
