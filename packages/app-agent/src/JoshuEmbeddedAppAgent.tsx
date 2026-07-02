import React, { useCallback, useMemo } from "react";

import { JoshuAgentChatPanel, type JoshuAgentChatPanelProps } from "./JoshuAgentChatPanel.js";
import type { JChatBubbleVoiceControl } from "@joshu/jchat-ui";
import { JoshuAppAgentProvider } from "./JoshuAppAgentProvider.js";
import { createAppAgentConfig } from "./createAppAgentConfig.js";
import type { JoshuAppAgentManifest } from "./types.js";
import { useJoshuGuiAction, type JoshuGuiActionInput } from "./useJoshuGuiAction.js";
import { useJoshuGuiReadable } from "./useJoshuGuiReadable.js";

export type JoshuGuiAgentRef = {
  getGuiSnapshot: () => Record<string, unknown>;
};

export type JoshuEmbeddedAppAgentProps<TGui extends JoshuGuiAgentRef = JoshuGuiAgentRef> = {
  manifest: JoshuAppAgentManifest;
  threadId: string;
  apiBase?: string;
  mode?: "embedded" | "standalone";
  guiRef: React.MutableRefObject<TGui | null>;
  /** CopilotKit readable id — defaults to `${manifest.id}.gui`. */
  guiReadableName?: string;
  /** Hermes context blurb for the GUI snapshot readable. */
  guiReadableDescription: string;
  /** One registration per manifest `guiActions[]` name (handlers call into `guiRef`). */
  guiActions: readonly JoshuGuiActionInput[];
  /** Panel title — defaults to `${manifest.name} assistant`. */
  chatTitle?: string;
  onNewChat?: JoshuAgentChatPanelProps["onNewChat"];
  chatDefaultOpen?: boolean;
  chatPosition?: JoshuAgentChatPanelProps["position"];
  chatWidth?: JoshuAgentChatPanelProps["width"];
  chatEmptyText?: string;
  className?: string;
  /** Mic badge on Chat Head — Realtime S2S voice (Google STS path via voice-realtime). */
  voice?: JChatBubbleVoiceControl;
};

function JoshuGuiActionRegistrar({
  action,
  guiRef,
}: {
  action: JoshuGuiActionInput;
  guiRef: React.MutableRefObject<JoshuGuiAgentRef | null>;
}): null {
  useJoshuGuiAction(action, [guiRef, action.handler]);
  return null;
}

function JoshuEmbeddedAppAgentTools({
  guiReadableName,
  guiReadableDescription,
  guiRef,
  guiActions,
}: {
  guiReadableName: string;
  guiReadableDescription: string;
  guiRef: React.MutableRefObject<JoshuGuiAgentRef | null>;
  guiActions: readonly JoshuGuiActionInput[];
}): React.ReactElement {
  useJoshuGuiReadable({
    name: guiReadableName,
    description: guiReadableDescription,
    getSnapshot: () => guiRef.current?.getGuiSnapshot() ?? {},
  });

  return (
    <>
      {guiActions.map((action) => (
        <JoshuGuiActionRegistrar key={action.name} action={action} guiRef={guiRef} />
      ))}
    </>
  );
}

/**
 * Drop-in embedded agent chat for Joshu desktop apps — jChat UI + CopilotKit + GUI context.
 *
 * Apps supply `guiRef.getGuiSnapshot()` and `guiActions` handlers; this wires provider,
 * readables, frontend tools, and the slide-out chat panel.
 */
export function JoshuEmbeddedAppAgent<TGui extends JoshuGuiAgentRef>({
  manifest,
  threadId,
  apiBase = "/joshu/api",
  mode = "embedded",
  guiRef,
  guiReadableName,
  guiReadableDescription,
  guiActions,
  chatTitle,
  onNewChat,
  chatDefaultOpen,
  chatPosition,
  chatWidth,
  chatEmptyText,
  className,
  voice,
}: JoshuEmbeddedAppAgentProps<TGui>): React.ReactElement {
  const agentConfig = useMemo(
    () =>
      createAppAgentConfig({
        manifest,
        threadId,
        apiBase,
      }),
    [apiBase, manifest, threadId],
  );

  const readableName = guiReadableName ?? `${manifest.id}.gui`;
  const panelTitle = chatTitle ?? `${manifest.name} assistant`;

  const getGuiState = useCallback(() => guiRef.current?.getGuiSnapshot() ?? {}, [guiRef]);

  return (
    <JoshuAppAgentProvider config={agentConfig} getGuiState={getGuiState} mode={mode}>
      <JoshuEmbeddedAppAgentTools
        guiReadableName={readableName}
        guiReadableDescription={guiReadableDescription}
        guiRef={guiRef}
        guiActions={guiActions}
      />
      <JoshuAgentChatPanel
        title={panelTitle}
        defaultOpen={chatDefaultOpen}
        position={chatPosition}
        width={chatWidth}
        className={className}
        onNewChat={onNewChat}
        emptyText={chatEmptyText}
        voice={voice}
        apiBase={apiBase}
      />
    </JoshuAppAgentProvider>
  );
}
