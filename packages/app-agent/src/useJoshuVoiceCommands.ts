import { useCallback, useEffect } from "react";

import type { AppGuiActionEvent, JoshuVoiceCommandDef } from "./types.js";

export type VoiceSocketSend = (payload: Record<string, unknown>) => void;

export type UseJoshuVoiceCommandsInput = {
  appId: string;
  commands?: JoshuVoiceCommandDef[];
  onAction: (event: AppGuiActionEvent) => void | Promise<void>;
  /** Parent supplies WS send(); hook registers surface voice tools when ready. */
  voiceSend?: VoiceSocketSend | null;
};

/** Wire manifest voiceCommands to voice-realtime app_action fast path. */
export function useJoshuVoiceCommands(input: UseJoshuVoiceCommandsInput): void {
  const { appId, commands, onAction, voiceSend } = input;

  useEffect(() => {
    if (!voiceSend || !commands?.length) return;
    voiceSend({
      event: "register_surface",
      appId,
      voiceCommands: commands,
    });
  }, [appId, commands, voiceSend]);

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

/** Map voice-realtime app_action wire event to manifest action names. */
export function resolveVoiceCommandAction(
  commands: JoshuVoiceCommandDef[] | undefined,
  toolName: string,
): string | null {
  if (!commands?.length) return null;
  const normalized = toolName.replace(/^app_/, "").replace(/^joshu_/, "");
  for (const cmd of commands) {
    if (cmd.name === normalized || cmd.action === normalized) return cmd.action;
  }
  return null;
}
