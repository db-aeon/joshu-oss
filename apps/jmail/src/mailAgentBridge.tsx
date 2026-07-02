import React, { useMemo } from "react";
import { JoshuEmbeddedAppAgent, type JoshuEmbeddedAppAgentProps } from "@joshu/app-agent";

import { createJmailGuiActions } from "./mailGuiActions.js";
import type { MailGuiAgentApi } from "./mailGuiActions.js";
import { JMAIL_MANIFEST } from "./mailAppManifest.js";

export type { MailGuiAgentApi };

export type MailAgentBridgeProps = {
  guiRef: React.MutableRefObject<MailGuiAgentApi | null>;
  threadId: string;
  onNewChat?: () => void | Promise<void>;
  voice?: JoshuEmbeddedAppAgentProps["voice"];
};

export function MailAgentBridge({ guiRef, threadId, onNewChat, voice }: MailAgentBridgeProps): React.ReactElement {
  const guiActions = useMemo(() => createJmailGuiActions(guiRef), [guiRef]);

  return (
    <JoshuEmbeddedAppAgent
      manifest={JMAIL_MANIFEST}
      threadId={threadId}
      guiRef={guiRef}
      guiReadableDescription="Current jMail UI state (activeView: inbox_list | thread | compose | setup)"
      guiActions={guiActions}
      chatTitle="jMail"
      onNewChat={onNewChat}
      voice={voice}
    />
  );
}
