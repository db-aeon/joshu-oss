import { JoshuVoiceClient } from "@joshu/voice-client";

export type VoiceStatus = {
  available: boolean;
  configured?: boolean;
};

export async function fetchVoiceStatus(voiceApiBase: string): Promise<VoiceStatus> {
  try {
    const res = await fetch(`${voiceApiBase}/status`, { cache: "no-store" });
    if (!res.ok) return { available: false };
    return (await res.json()) as VoiceStatus;
  } catch {
    return { available: false };
  }
}

/** @deprecated Use fetchVoiceStatus */
export const fetchVoiceGatewayStatus = fetchVoiceStatus;

export async function startJoshuVoiceSession(params: {
  voiceApiBase: string;
  /** Voice-realtime session id (logging / web: prefix). */
  sessionId: string;
  /** Hermes + app_gui_action session — use CopilotKit thread id for embedded apps. */
  chatSessionId?: string;
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
  onUserTranscript?: (text: string, partial: boolean) => void;
  onAssistantDelta?: (delta: string) => void;
  onAssistantDone?: (text: string) => void;
  onState?: (state: string) => void;
  onDesktopAction?: (action: { kind: "module" | "file"; target: string }) => void;
  onAppAction?: (event: { appId: string; action: string; args?: Record<string, unknown> }) => void;
  onBargeIn?: () => void;
  onThinkJobStart?: () => void;
  /** @deprecated Use onThinkJobStart */
  onHermesJobStart?: () => void;
  onError?: (message: string) => void;
}): Promise<{ client: JoshuVoiceClient; stop: () => Promise<void> }> {
  const res = await fetch(
    `${params.voiceApiBase}/session?chatSessionId=${encodeURIComponent(params.chatSessionId ?? params.sessionId)}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(await res.text());
  const json = (await res.json()) as { wsUrl?: string };
  if (!json.wsUrl) throw new Error("Voice session missing wsUrl");

  const hermesSessionId = params.chatSessionId ?? params.sessionId;

  const client = new JoshuVoiceClient({
    wsUrl: json.wsUrl,
    sessionId: `web:${params.sessionId}`,
    chatSessionId: hermesSessionId,
    surface: params.surface,
    onUserTranscript: params.onUserTranscript,
    onAssistantDelta: params.onAssistantDelta,
    onAssistantDone: params.onAssistantDone,
    onDesktopAction: params.onDesktopAction,
    onAppAction: params.onAppAction,
    onThinkJobStart: params.onThinkJobStart ?? params.onHermesJobStart,
    onState: params.onState,
    onBargeIn: params.onBargeIn,
    onError: params.onError,
  });
  await client.start();
  return { client, stop: () => client.stop() };
}
