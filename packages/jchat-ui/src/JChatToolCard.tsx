import React, { useState } from "react";

import type { JChatToolEvent } from "./types.js";
import { ToolPixelIcon } from "./toolIcons.js";

export function JChatToolCard({ tool }: { tool: JChatToolEvent }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const isDone = tool.status === "completed";
  const raw = tool.raw ? JSON.stringify(tool.raw, null, 2) : "";

  return (
    <article className={`tool-card ${isDone ? "tool-card-done" : "tool-card-running"}`}>
      <button type="button" className="tool-summary" onClick={() => setOpen((value) => !value)}>
        <span className="tool-icon" aria-hidden>
          <ToolPixelIcon tool={tool.tool} emoji={tool.emoji} />
        </span>
        <span>
          <strong>{tool.label || tool.tool}</strong>
          <small>{tool.tool}</small>
        </span>
        <span className="tool-state">{isDone ? "completed" : "running"}</span>
      </button>
      {open && raw ? <pre className="tool-raw">{raw}</pre> : null}
    </article>
  );
}
