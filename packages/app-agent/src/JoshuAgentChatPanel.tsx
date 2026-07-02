import React, { useMemo, useState } from "react";
import "@joshu/jchat-ui/jchatBubble.css";
import "@joshu/jchat-ui/jchatShell.css";
import "@joshu/jchat-ui/jchatThread.css";
import "./agentChat.css";

import { JChatBubbleDock, JChatShell, type JChatBubbleVoiceControl } from "@joshu/jchat-ui";
import { JChatCopilotThread } from "./JChatCopilotThread.js";
import { useJoshuAppAgentContext } from "./JoshuAppAgentProvider.js";
import { useJoshuCompanionIdentity } from "./useJoshuCompanionIdentity.js";

export type JoshuAgentChatPanelProps = {
  title?: string;
  defaultOpen?: boolean;
  position?: "left" | "right";
  width?: number | string;
  className?: string;
  /** Start a fresh CopilotKit thread + Hermes session (app supplies rotation). */
  onNewChat?: () => void | Promise<void>;
  emptyText?: string;
  /** Override auto-fetched companion identity (Chat Head avatar + bubble avatars). */
  companionName?: string;
  companionAvatarUrl?: string;
  userName?: string;
  /** Mic badge on the Chat Head — Realtime S2S voice toggle. */
  voice?: JChatBubbleVoiceControl;
  apiBase?: string;
};

/** Messenger-style Chat Head + floating panel — jChat UI + CopilotKit AG-UI backend. */
export function JoshuAgentChatPanel({
  title = "Assistant",
  defaultOpen = false,
  position = "right",
  width = 360,
  className = "",
  onNewChat,
  emptyText,
  companionName: companionNameProp,
  companionAvatarUrl: companionAvatarUrlProp,
  userName: userNameProp,
  voice,
  apiBase = "/joshu/api",
}: JoshuAgentChatPanelProps): React.ReactElement {
  const { config } = useJoshuAppAgentContext();
  const identity = useJoshuCompanionIdentity(apiBase);
  const [open, setOpen] = useState(defaultOpen);

  const companionName = companionNameProp ?? identity.name;
  const companionAvatarUrl = companionAvatarUrlProp ?? identity.portraitUrl;
  const userName = userNameProp ?? identity.ownerDisplayName;

  const threadEmptyText =
    emptyText ?? `Start a fresh session with ${companionName}. Ask for help with this app.`;

  const panelTitle = title ?? `${companionName}`;

  const voiceTitle = useMemo(() => {
    if (!voice) return undefined;
    if (voice.title) return voice.title;
    if (!voice.available) return "Voice unavailable";
    return voice.active ? "Turn voice off" : "Turn voice on";
  }, [voice]);

  return (
    <div className={`joshu-agent-chat ${className}`.trim()} data-open={open ? "true" : "false"}>
      <JChatBubbleDock
        open={open}
        onOpenChange={setOpen}
        companionName={companionName}
        companionAvatarUrl={companionAvatarUrl}
        position={position}
        panelWidth={width}
        ariaLabel={panelTitle}
        voice={voice ? { ...voice, title: voiceTitle } : undefined}
      >
        <JChatShell
          variant="embedded"
          status="ready"
          statusText={panelTitle}
          headerActions={
            <>
              {onNewChat ? (
                <button
                  type="button"
                  className="jchat-pill-btn"
                  onClick={() => void onNewChat()}
                  title="New chat (fresh session)"
                >
                  New chat
                </button>
              ) : null}
              <button
                type="button"
                className="jchat-shell-close"
                onClick={() => setOpen(false)}
                aria-label="Hide chat"
                title="Hide chat"
              >
                ×
              </button>
            </>
          }
        >
          <JChatCopilotThread
            agentId={config.agentId}
            emptyText={threadEmptyText}
            companionAvatarUrl={companionAvatarUrl}
            companionName={companionName}
            userName={userName}
          />
        </JChatShell>
      </JChatBubbleDock>
    </div>
  );
}
