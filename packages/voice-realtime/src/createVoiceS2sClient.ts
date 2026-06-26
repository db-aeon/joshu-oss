import { GeminiLiveClient } from "./geminiLiveClient.js";
import { OpenAiRealtimeClient } from "./openaiRealtimeClient.js";
import { VOICE_S2S_PROVIDER } from "./config.js";
import type { VoiceS2sClient, VoiceS2sConfig, VoiceS2sHandlers } from "./voiceS2sTypes.js";

export function createVoiceS2sClient(config: VoiceS2sConfig, handlers: VoiceS2sHandlers): VoiceS2sClient {
  if (VOICE_S2S_PROVIDER === "gemini_live") {
    return new GeminiLiveClient(config, handlers);
  }
  return new OpenAiRealtimeClient(config, handlers);
}

export function voiceS2sProviderLabel(): string {
  return VOICE_S2S_PROVIDER === "gemini_live" ? "gemini_live" : "openai_realtime";
}
