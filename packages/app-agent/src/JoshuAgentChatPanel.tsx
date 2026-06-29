import React, { useMemo, useState } from "react";
import "@joshu/jchat-ui/jchatThread.css";
import "./agentChat.css";

import { JChatCopilotThread } from "./JChatCopilotThread.js";
import { useJoshuAppAgentContext } from "./JoshuAppAgentProvider.js";

export type JoshuAgentChatPanelProps = {
  title?: string;
  defaultOpen?: boolean;
  position?: "left" | "right";
  width?: number | string;
  className?: string;
  /** Start a fresh CopilotKit thread + Hermes session (app supplies rotation). */
  onNewChat?: () => void | Promise<void>;
  emptyText?: string;
};

/** Expandable chat panel — jChat thread UI + CopilotKit AG-UI backend. */
export function JoshuAgentChatPanel({
  title = "Assistant",
  defaultOpen = false,
  position = "right",
  width = 360,
  className = "",
  onNewChat,
  emptyText,
}: JoshuAgentChatPanelProps): React.ReactElement {
  const { config } = useJoshuAppAgentContext();
  const [open, setOpen] = useState(defaultOpen);

  const panelStyle = useMemo(
    () => ({
      width: typeof width === "number" ? `${width}px` : width,
    }),
    [width],
  );

  const threadEmptyText = emptyText ?? `Ask ${title} for help with this app.`;

  return (
    <div className={`joshu-agent-chat ${className}`.trim()} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="joshu-agent-chat__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Close assistant" : "Open assistant"}
      >
        {open ? "Close chat" : "Chat"}
      </button>
      {open ? (
        <aside
          className={`joshu-agent-chat__panel joshu-agent-chat__panel--${position}`}
          style={panelStyle}
          aria-label={title}
        >
          <header className="joshu-agent-chat__header">
            <span>{title}</span>
            <div className="joshu-agent-chat__header-actions">
              {onNewChat ? (
                <button
                  type="button"
                  className="jchat-history-new joshu-agent-chat__new"
                  onClick={() => void onNewChat()}
                  title="New chat (fresh session)"
                >
                  New
                </button>
              ) : null}
              <button type="button" className="joshu-agent-chat__close" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
          </header>
          <div className="joshu-agent-chat__body">
            <JChatCopilotThread agentId={config.agentId} emptyText={threadEmptyText} />
          </div>
        </aside>
      ) : null}
    </div>
  );
}
