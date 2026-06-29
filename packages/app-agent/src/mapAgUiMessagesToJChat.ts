import type { Message } from "@ag-ui/core";

import type { JChatMessage, JChatToolEvent } from "@joshu/jchat-ui";

function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function messageText(content: Message["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        return String(part.text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Map AG-UI / CopilotKit agent messages into jChat bubble rows. */
export function mapAgUiMessagesToJChat(messages: readonly Message[], isRunning: boolean): JChatMessage[] {
  const toolResults = new Map<string, { content: string; error?: string }>();
  const pendingReasoning: string[] = [];
  const rows: JChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "reasoning") {
      pendingReasoning.push(messageText(message.content));
      continue;
    }

    if (message.role === "tool") {
      toolResults.set(message.toolCallId, { content: messageText(message.content), error: message.error });
      continue;
    }

    if (message.role === "user") {
      rows.push({
        id: message.id,
        role: "user",
        content: messageText(message.content),
        status: "done",
      });
      continue;
    }

    if (message.role === "assistant") {
      const tools: JChatToolEvent[] = (message.toolCalls ?? []).map((toolCall) => {
        const result = toolResults.get(toolCall.id);
        let parsedArgs: unknown = toolCall.function.arguments;
        try {
          parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          /* keep raw string */
        }
        return {
          id: toolCall.id,
          tool: toolCall.function.name,
          status: result ? "completed" : isRunning ? "running" : "completed",
          raw: result ? { args: parsedArgs, result: result.content, error: result.error } : { args: parsedArgs },
        };
      });

      rows.push({
        id: message.id,
        role: "assistant",
        content: messageText(message.content),
        reasoning: pendingReasoning.length ? pendingReasoning.join("\n\n") : undefined,
        tools: tools.length ? tools : undefined,
        status: "done",
      });
      pendingReasoning.length = 0;
    }
  }

  if (isRunning) {
    const last = rows[rows.length - 1];
    if (last?.role === "assistant") {
      last.status = "streaming";
      if (last.tools?.length) {
        const lastTool = last.tools[last.tools.length - 1];
        if (lastTool && !toolResults.has(lastTool.id)) {
          lastTool.status = "running";
        }
      }
    } else if (!last || last.role === "user") {
      rows.push({
        id: newMessageId(),
        role: "assistant",
        content: "",
        status: "streaming",
      });
    }
  }

  return rows;
}
