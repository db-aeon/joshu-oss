import { JoshuVoiceClient } from "@joshu/voice-client";

export type VoiceStatus = {
  available: boolean;
  configured?: boolean;
  reason?: string;
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

/** Start a browser voice session (OpenAI Realtime S2S via voice-realtime). */
export async function startJoshuVoiceSession(params: {
  voiceApiBase: string;
  sessionId: string;
  onUserTranscript?: (text: string, partial: boolean) => void;
  onAssistantDelta?: (delta: string) => void;
  onAssistantDone?: (text: string) => void;
  onState?: (state: string) => void;
  onAudioLevel?: (level: number) => void;
  onBargeIn?: () => void;
  onThinkJobStart?: () => void;
  onDesktopAction?: (action: { kind: "module" | "file"; target: string }) => void;
  /** @deprecated Use onThinkJobStart */
  onHermesJobStart?: () => void;
  onDesktopAction?: (action: { kind: "module" | "file"; target: string }) => void;
  onError?: (message: string) => void;
}): Promise<{ client: JoshuVoiceClient; stop: () => Promise<void> }> {
  const res = await fetch(
    `${params.voiceApiBase}/session?chatSessionId=${encodeURIComponent(params.sessionId)}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(await res.text());
  const json = (await res.json()) as { wsUrl?: string };
  if (!json.wsUrl) throw new Error("Voice session missing wsUrl");

  const client = new JoshuVoiceClient({
    wsUrl: json.wsUrl,
    sessionId: `web:${params.sessionId}`,
    chatSessionId: params.sessionId,
    onUserTranscript: params.onUserTranscript,
    onAssistantDelta: params.onAssistantDelta,
    onAssistantDone: params.onAssistantDone,
    onThinkJobStart: params.onThinkJobStart ?? params.onHermesJobStart,
    onDesktopAction: params.onDesktopAction,
    onState: params.onState,
    onAudioLevel: params.onAudioLevel,
    onBargeIn: params.onBargeIn,
    onError: params.onError,
  });
  await client.start();
  return { client, stop: () => client.stop() };
}

/** @deprecated Use fetchVoiceStatus */
export const fetchVoiceGatewayStatus = fetchVoiceStatus;
