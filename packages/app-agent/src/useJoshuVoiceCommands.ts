import { useCallback, useEffect, useMemo } from "react";

import type { AppGuiActionEvent, JoshuAppAgentManifest } from "./types.js";
import { resolveManifestVoiceTools } from "./types.js";

export type VoiceSocketSend = (payload: Record<string, unknown>) => void;

export type UseJoshuVoiceCommandsInput = {
  appId: string;
  /** Manifest agent block — voice tools derived from guiActions[].voice. */
  manifest?: Pick<JoshuAppAgentManifest, "agent">;
  /** @deprecated Pass manifest.agent.guiActions[].voice instead */
  commands?: Array<{
    name: string;
    phrases: string[];
    action: string;
    params?: string[];
    description?: string;
  }>;
  onAction: (event: AppGuiActionEvent) => void | Promise<void>;
  /** Parent supplies WS send(); hook registers surface voice tools when ready. */
  voiceSend?: VoiceSocketSend | null;
};

/** Wire manifest guiActions[].voice to voice-realtime app_action fast path. */
export function useJoshuVoiceCommands(input: UseJoshuVoiceCommandsInput): void {
  const { appId, manifest, commands, onAction, voiceSend } = input;
  const voiceTools = useMemo(
    () =>
      resolveManifestVoiceTools(manifest?.agent?.guiActions, manifest?.agent?.voiceCommands ?? commands),
    [manifest, commands],
  );

  useEffect(() => {
    if (!voiceSend || !appId) return;
    voiceSend({
      event: "register_surface",
      appId,
      voiceCommands: voiceTools.length > 0 ? voiceTools : undefined,
    });
  }, [appId, voiceSend, voiceTools]);

  const handleAppAction = useCallback(
    (payload: { action?: string; args?: Record<string, unknown> }) => {
      const action = typeof payload.action === "string" ? payload.action.trim() : "";
      if (!action) return;
      void onAction({ appId, action, args: payload.args });
    },
    [appId, onAction],
  );

  useEffect(() => {
    void handleAppAction;
  }, [handleAppAction]);
}

export type JoshuVoiceClientAppActionHandler = (event: AppGuiActionEvent) => void | Promise<void>;

/** Map voice-realtime app_action wire event to manifest guiAction name. */
export function resolveVoiceCommandAction(
  manifest: Pick<JoshuAppAgentManifest, "agent"> | undefined,
  toolName: string,
): string | null {
  const voiceTools = resolveManifestVoiceTools(
    manifest?.agent?.guiActions,
    manifest?.agent?.voiceCommands,
  );
  const normalized = toolName.replace(/^app_/, "").replace(/^joshu_/, "");
  for (const cmd of voiceTools) {
    if (cmd.name === normalized) return cmd.action;
  }
  return null;
}
