import React, { useEffect, useRef, type ReactNode } from "react";

import { JChatMessageBubble } from "./JChatMessageBubble.js";
import type { JChatMessage } from "./types.js";

export type JChatThreadProps = {
  messages: JChatMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  busy?: boolean;
  disabled?: boolean;
  emptyText?: string;
  showDaySeparator?: boolean;
  placeholder?: string;
  beforeComposer?: ReactNode;
  /** Override default send enablement (draft non-empty). */
  sendEnabled?: boolean;
};

/** jChat thread column: scrollable bubbles + composer (matches hermes-chat). */
export function JChatThread({
  messages,
  draft,
  onDraftChange,
  onSend,
  busy = false,
  disabled = false,
  emptyText = "Start a conversation.",
  showDaySeparator = true,
  placeholder = "Type a message…",
  beforeComposer,
  sendEnabled,
}: JChatThreadProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const canSend = sendEnabled ?? (!disabled && !busy && draft.trim().length > 0);

  return (
    <section className="jchat-thread" aria-label="Chat thread">
      <div className="jchat-messages">
        {messages.length === 0 ? (
          <p className="jchat-empty">{emptyText}</p>
        ) : (
          <>
            {showDaySeparator ? <div className="jchat-day-sep">Today</div> : null}
            {messages.map((message) => (
              <JChatMessageBubble key={message.id} message={message} />
            ))}
          </>
        )}
        <div ref={scrollRef} />
      </div>

      {beforeComposer}

      <form
        className="jchat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSend();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={placeholder}
          rows={1}
          disabled={disabled || busy}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <button type="submit" className="jchat-send" disabled={!canSend}>
          {busy ? "…" : "Send"}
        </button>
      </form>
    </section>
  );
}
