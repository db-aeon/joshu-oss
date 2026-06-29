import React from "react";

import { JChatMarkdown } from "./JChatMarkdown.js";
import { JChatToolCard } from "./JChatToolCard.js";
import type { JChatMessage } from "./types.js";

export function JChatMessageBubble({ message }: { message: JChatMessage }): React.ReactElement | null {
  const hasBody =
    Boolean(message.content.trim()) ||
    Boolean(message.attachments?.length) ||
    Boolean(message.tools?.length) ||
    Boolean(message.reasoning?.trim());

  if (!hasBody && message.status === "streaming") {
    return (
      <div className={`jchat-bubble-row jchat-bubble-row-${message.role}`}>
        <div className={`jchat-bubble jchat-bubble-${message.role}`}>
          <span className="jchat-streaming">…</span>
        </div>
      </div>
    );
  }

  if (!hasBody) return null;

  return (
    <div className={`jchat-bubble-row jchat-bubble-row-${message.role}`}>
      <article className={`jchat-bubble jchat-bubble-${message.role}`}>
        {message.attachments && message.attachments.length > 0 ? (
          <div className="attachment-grid">
            {message.attachments.map((attachment) => (
              <a href={attachment.dataUrl} target="_blank" rel="noreferrer" key={attachment.id}>
                <img src={attachment.dataUrl} alt={attachment.name} />
              </a>
            ))}
          </div>
        ) : null}

        {message.reasoning ? (
          <details className="reasoning">
            <summary>Reasoning</summary>
            <p>{message.reasoning}</p>
          </details>
        ) : null}

        {message.tools && message.tools.length > 0 ? (
          <div className="tool-list">
            {message.tools.map((tool) => (
              <JChatToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        ) : null}

        <div className="markdown-body">
          <JChatMarkdown content={message.content} />
          {message.status === "streaming" ? <span className="jchat-streaming"> …</span> : null}
        </div>
      </article>
    </div>
  );
}
