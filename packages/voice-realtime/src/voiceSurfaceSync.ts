import { normalizeThinkToolName } from "./realtimeTools.js";

/**
 * Wire protocol for surfaces attached to a browser voice session.
 * jChat consumes these WebSocket events today; future desktop shells can subscribe the same way.
 */
export type DesktopSurfaceAction = {
  kind: "module" | "file";
  target: string;
};

export type VoiceSurfaceWireEvent =
  | { event: "assistant_delta"; text: string }
  | { event: "assistant_done"; text: string }
  | { event: "think_job_start" }
  | { event: "desktop_action"; action: DesktopSurfaceAction };

export type VoiceSurfaceSessionKind = "chat" | "desktop";

export function surfaceAssistantDelta(text: string): VoiceSurfaceWireEvent {
  return { event: "assistant_delta", text };
}

export function surfaceAssistantDone(text: string): VoiceSurfaceWireEvent {
  return { event: "assistant_done", text };
}

export function surfaceBrainJobStart(): VoiceSurfaceWireEvent {
  return { event: "think_job_start" };
}

export function surfaceDesktopAction(action: DesktopSurfaceAction): VoiceSurfaceWireEvent {
  return { event: "desktop_action", action };
}

export function responseDoneRequestedThink(functionCalls: unknown): boolean {
  if (!Array.isArray(functionCalls)) return false;
  return functionCalls.some((name) => normalizeThinkToolName(String(name)) === "think");
}
