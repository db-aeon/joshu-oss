import { spawnHermesPython } from "./hermesVoiceRuntime.js";
import type { HermesChatSessionRow, JchatTranscriptMessage } from "./hermesChatSessions.js";

type BridgeResult = {
  ok?: boolean;
  error?: string;
  sessions?: HermesChatSessionRow[];
  sessionId?: string;
  messages?: JchatTranscriptMessage[];
};

async function callSessionsBridge(payload: Record<string, unknown>): Promise<BridgeResult> {
  const { stdout, stderr, code } = await spawnHermesPython(
    "hermes-chat-sessions-bridge.py",
    [],
    JSON.stringify(payload),
  );
  const text = stdout.trim();
  if (!text) {
    throw new Error(stderr.trim() || `sessions bridge exited with code ${code ?? "?"}`);
  }
  try {
    return JSON.parse(text) as BridgeResult;
  } catch {
    throw new Error(stderr.trim() || text.slice(0, 500));
  }
}

export async function listJchatSessionsViaBridge(limit = 40): Promise<HermesChatSessionRow[]> {
  const result = await callSessionsBridge({ action: "list", limit });
  if (!result.ok) throw new Error(result.error || "Failed to list sessions");
  return result.sessions ?? [];
}

export async function loadJchatSessionMessagesViaBridge(sessionId: string): Promise<{
  sessionId: string;
  messages: JchatTranscriptMessage[];
}> {
  const result = await callSessionsBridge({ action: "messages", sessionId });
  if (!result.ok) throw new Error(result.error || "Failed to load session messages");
  return {
    sessionId: result.sessionId ?? sessionId,
    messages: result.messages ?? [],
  };
}
