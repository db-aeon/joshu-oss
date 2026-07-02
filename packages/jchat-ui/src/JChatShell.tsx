import React, { type ReactNode } from "react";

import { JChatHistoryPanel, type JChatHistoryPanelProps } from "./JChatHistoryPanel.js";

export type JChatShellStatus = "checking" | "ready" | "error";

export type JChatShellHistoryConfig = Omit<JChatHistoryPanelProps, "ariaLabel"> & {
  ariaLabel?: string;
  /** Label on the history toggle pill (default: Past chats). */
  toggleLabel?: string;
};

export type JChatShellProps = {
  status: JChatShellStatus;
  statusText: string;
  /** Right-side header actions (Connectors, Speech, Mic, close, …). */
  headerActions?: ReactNode;
  /** Optional banner below status (voice errors, etc.). */
  hint?: ReactNode;
  /** Controlled history drawer — omit `history` to hide the toggle entirely. */
  historyOpen?: boolean;
  onHistoryToggle?: () => void;
  history?: JChatShellHistoryConfig;
  /** `standalone` = full jChat window; `embedded` = slide-out / in-app panel. */
  variant?: "standalone" | "embedded";
  children: ReactNode;
};

/** Shared jChat chrome: status strip, optional history drawer, thread slot. */
export function JChatShell({
  status,
  statusText,
  headerActions,
  hint,
  historyOpen = false,
  onHistoryToggle,
  history,
  variant = "standalone",
  children,
}: JChatShellProps): React.ReactElement {
  const showHistoryToggle = Boolean(history && onHistoryToggle);
  const shellClass = [
    "jchat-shell",
    variant === "embedded" ? "jchat-shell--embedded" : "",
    hint ? "jchat-shell--has-hint" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClass}>
      <header className={`jchat-status jchat-status-${status}`}>
        <span className="jchat-status-dot" aria-hidden />
        <span className="jchat-status-text">{statusText}</span>
        <div className="jchat-status-actions">
          {showHistoryToggle ? (
            <button
              type="button"
              className={`jchat-history-toggle ${historyOpen ? "jchat-history-toggle-on" : ""}`}
              aria-pressed={historyOpen}
              aria-expanded={historyOpen}
              onClick={onHistoryToggle}
              title={historyOpen ? "Hide past chats" : "Show past chats"}
            >
              <span className="jchat-history-toggle-icon" aria-hidden>
                ☰
              </span>
              <span>{history?.toggleLabel ?? "Past chats"}</span>
            </button>
          ) : null}
          {headerActions}
        </div>
      </header>

      {hint ? <div className="jchat-hint">{hint}</div> : null}

      <div className={`jchat-split ${historyOpen ? "jchat-split-history-open" : ""}`}>
        {historyOpen && history ? (
          <JChatHistoryPanel
            title={history.title}
            items={history.items}
            activeId={history.activeId}
            onSelect={history.onSelect}
            loading={history.loading}
            error={history.error}
            emptyText={history.emptyText}
            onNewChat={history.onNewChat}
            newChatDisabled={history.newChatDisabled}
            ariaLabel={history.ariaLabel}
          />
        ) : null}
        <div className="jchat-thread-slot">{children}</div>
      </div>
    </div>
  );
}
