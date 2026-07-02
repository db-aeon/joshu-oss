import React from "react";

import { JChatAvatar } from "./JChatAvatar.js";
import { JChatMarkdown } from "./JChatMarkdown.js";
import { JChatToolCard } from "./JChatToolCard.js";
import type { JChatMessage } from "./types.js";

export type JChatMessageBubbleProps = {
  message: JChatMessage;
  /** Avatar beside assistant bubbles. */
  companionAvatarUrl?: string;
  companionName?: string;
  /** Avatar beside user bubbles (initials if no image). */
  userAvatarUrl?: string | null;
  userName?: string;
};

export function JChatMessageBubble({
  message,
  companionAvatarUrl,
  companionName = "Assistant",
  userAvatarUrl,
  userName = "You",
}: JChatMessageBubbleProps): React.ReactElement | null {
  const isUser = message.role === "user";
  const avatarSrc = isUser ? userAvatarUrl : companionAvatarUrl;
  const avatarLabel = isUser ? userName : companionName;

  const hasBody =
    Boolean(message.content.trim()) ||
    Boolean(message.attachments?.length) ||
    Boolean(message.tools?.length) ||
    Boolean(message.reasoning?.trim());

  if (!hasBody && message.status === "streaming") {
    return (
      <div className={`jchat-bubble-row jchat-bubble-row-${message.role}`}>
        {!isUser ? <JChatAvatar src={avatarSrc} label={avatarLabel} size="sm" /> : null}
        <div className={`jchat-bubble jchat-bubble-${message.role}`}>
          <span className="jchat-streaming">…</span>
        </div>
        {isUser ? <JChatAvatar src={avatarSrc} label={avatarLabel} size="sm" /> : null}
      </div>
    );
  }

  if (!hasBody) return null;

  return (
    <div className={`jchat-bubble-row jchat-bubble-row-${message.role}`}>
      {!isUser ? <JChatAvatar src={avatarSrc} label={avatarLabel} size="sm" /> : null}
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
      {isUser ? <JChatAvatar src={avatarSrc} label={avatarLabel} size="sm" /> : null}
    </div>
  );
}
