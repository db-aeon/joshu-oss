export type VoiceSessionState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export type JoshuVoiceClientOptions = {
  /** Full WebSocket URL including token query (from Joshu /api/voice/session). */
  wsUrl: string;
  /** Voice session id sent to gateway. */
  sessionId: string;
  /** Hermes chat session id for memory/tools scoping. */
  chatSessionId: string;
  /** Optional app surface for manifest voiceCommands (browser_start). */
  surface?: {
    appId: string;
    threadId?: string;
    guiSnapshot?: Record<string, unknown>;
    voiceCommands?: Array<{
      name: string;
      phrases: string[];
      action: string;
      params?: string[];
      description?: string;
    }>;
  };
  /** Called when gateway emits assistant token deltas (synced UI). */
  onAssistantDelta?: (delta: string) => void;
  /** Called when a user utterance is finalized. */
  onUserTranscript?: (text: string, partial: boolean) => void;
  /** Called when assistant turn completes. */
  onAssistantDone?: (text: string) => void;
  /** Called when think starts — reset assistant bubble before brain stream. */
  onThinkJobStart?: () => void;
  /** Open a desktop app or file on the ArozOS shell. */
  onDesktopAction?: (action: { kind: "module" | "file"; target: string }) => void;
  /** Fast app GUI action from voice-realtime (no Hermes). */
  onAppAction?: (event: { appId: string; action: string; args?: Record<string, unknown> }) => void;
  /** @deprecated Use onThinkJobStart */
  onHermesJobStart?: () => void;
  onState?: (state: VoiceSessionState) => void;
  /** Normalized audio level 0–1 (mic while listening, playback while speaking). */
  onAudioLevel?: (level: number) => void;
  onBargeIn?: () => void;
  onError?: (message: string) => void;
};

export type VoiceSessionInfo = {
  available: boolean;
  wsUrl?: string;
  reason?: string;
};
