import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function JChatMarkdown({ content }: { content: string }): React.ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        img: ({ src, alt }) => (
          <a className="markdown-image-link" href={src} target="_blank" rel="noreferrer">
            <img src={src} alt={alt ?? ""} loading="lazy" />
          </a>
        ),
        code: ({ className, children }) => {
          const code = String(children).replace(/\n$/, "");
          return (
            <code className={className} title={code.length > 120 ? code : undefined}>
              {children}
            </code>
          );
        },
      }}
    >
      {content || ""}
    </ReactMarkdown>
  );
}
