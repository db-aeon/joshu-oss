import React from "react";

export type JChatHistoryItem = {
  id: string;
  title: string;
  whenLabel: string;
  icon?: string;
};

export type JChatHistoryPanelProps = {
  title?: string;
  items: JChatHistoryItem[];
  activeId?: string;
  onSelect: (id: string) => void;
  loading?: boolean;
  error?: string;
  emptyText?: string;
  onNewChat?: () => void;
  newChatDisabled?: boolean;
  ariaLabel?: string;
};

/** Collapsible past-chats sidebar — used inside {@link JChatShell}. */
export function JChatHistoryPanel({
  title = "Recent chats",
  items,
  activeId,
  onSelect,
  loading = false,
  error = "",
  emptyText = "No past chats yet.",
  onNewChat,
  newChatDisabled = false,
  ariaLabel,
}: JChatHistoryPanelProps): React.ReactElement {
  return (
    <aside className="jchat-history" aria-label={ariaLabel ?? title}>
      <div className="jchat-history-head-row">
        <h2 className="jchat-history-head">{title}</h2>
        {onNewChat ? (
          <button type="button" className="jchat-history-new" onClick={onNewChat} disabled={newChatDisabled}>
            New
          </button>
        ) : null}
      </div>
      <div className="jchat-history-list">
        {loading && items.length === 0 ? (
          <p className="jchat-history-status">Loading…</p>
        ) : error && items.length === 0 ? (
          <p className="jchat-history-status jchat-history-status-error">{error}</p>
        ) : items.length === 0 ? (
          <p className="jchat-history-status">{emptyText}</p>
        ) : (
          items.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`jchat-history-item ${activeId === item.id ? "jchat-history-item-active" : ""}`}
              onClick={() => onSelect(item.id)}
              disabled={newChatDisabled}
            >
              <span className="jchat-history-icon" aria-hidden>
                {item.icon ?? "💬"}
              </span>
              <span>
                <p className="jchat-history-title">{item.title}</p>
                <p className="jchat-history-time">{item.whenLabel}</p>
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
