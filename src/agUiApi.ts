/**
 * AG-UI-compatible HTTP endpoints — thin Hermes chat stream adapter.
 * CopilotKit HttpAgent can POST RunAgentInput and receive SSE BaseEvents.
 */

import type { Request, Response, Router } from "express";
import type { HermesApiRunner, HermesChatMessage } from "./hermesApi.js";
import { buildTurnSystemMessages } from "./hermesApi.js";
import { drainDesktopActionsForChat, desktopActionFromHermesToolRaw } from "./desktopActionApi.js";
import { isComposioEnabled, syncComposioHermesMcp } from "./composioApi.js";

type RunAgentInput = {
  threadId?: string;
  runId?: string;
  messages?: Array<{ role?: string; content?: unknown; id?: string }>;
  state?: unknown;
};

type AgUiEvent = Record<string, unknown>;

const EVENT = {
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  CUSTOM: "CUSTOM",
} as const;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function agUiSseSend(res: Response, event: AgUiEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function toHermesMessages(input: RunAgentInput): HermesChatMessage[] {
  const raw = input.messages ?? [];
  return raw
    .map((m) => ({
      role: (m.role === "system" || m.role === "assistant" ? m.role : "user") as HermesChatMessage["role"],
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
    }))
    .filter((m) => m.content.length > 0);
}

function isHermesChatMessage(m: HermesChatMessage): boolean {
  return m.role === "user" || m.role === "assistant" || m.role === "system";
}

export function registerAgUiRoutes(
  router: Router,
  runner: HermesApiRunner,
  projectRoot: string,
): void {
  router.get("/api/ag-ui/info", (_req: Request, res: Response) => {
    res.json({
      agents: [{ id: "hermes-default", name: "Hermes", description: "Joshu box agent (Hermes gateway)" }],
    });
  });

  router.post("/api/ag-ui/run", async (req: Request, res: Response) => {
    const input = (req.body ?? {}) as RunAgentInput;
    const threadId = readString(input.threadId) || readString(input.runId) || `agui-${Date.now()}`;
    const runId = readString(input.runId) || threadId;
    const messages = toHermesMessages(input);

    if (messages.length === 0) {
      return res.status(400).json({ error: "messages required" });
    }

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const controller = new AbortController();
    res.on("close", () => controller.abort());

    agUiSseSend(res, { type: EVENT.RUN_STARTED, threadId, runId });

    const messageId = `msg_${runId}`;
    agUiSseSend(res, { type: EVENT.TEXT_MESSAGE_START, messageId, role: "assistant" });

    let activeSessionId = threadId;
    const toolCallIds = new Map<string, string>();

    try {
      if (isComposioEnabled()) {
        await syncComposioHermesMcp(projectRoot).catch(() => undefined);
      }
      await runner.ensureGatewayReady().catch(() => undefined);

      const turnSystemMessages = buildTurnSystemMessages(projectRoot, { browser: null });

      await runner.streamHermesChat(
        {
          sessionId: threadId,
          messages: [...turnSystemMessages, ...messages.filter(isHermesChatMessage)],
          signal: controller.signal,
        },
        {
          onSession: (sid) => {
            activeSessionId = sid;
          },
          onDelta: (text) => {
            if (text) {
              agUiSseSend(res, { type: EVENT.TEXT_MESSAGE_CONTENT, messageId, delta: text });
            }
          },
          onTool: (tool) => {
            const toolCallId = tool.toolCallId ?? `tool_${tool.tool ?? "unknown"}`;
            if (tool.status === "running") {
              toolCallIds.set(toolCallId, tool.tool ?? "tool");
              agUiSseSend(res, {
                type: EVENT.TOOL_CALL_START,
                toolCallId,
                toolCallName: tool.tool ?? "tool",
              });
            }
            if (tool.status === "completed") {
              agUiSseSend(res, {
                type: EVENT.TOOL_CALL_END,
                toolCallId,
                toolCallName: tool.tool ?? "tool",
              });
              const toolName = tool.tool?.replace(/^.*\./, "") ?? "";
              if (toolName === "desktop_open" && tool.status === "completed") {
                let actions = drainDesktopActionsForChat(activeSessionId);
                if (actions.length === 0) {
                  const fromTool = desktopActionFromHermesToolRaw(tool.raw);
                  if (fromTool) actions = [fromTool];
                }
                for (const action of actions) {
                  agUiSseSend(res, {
                    type: EVENT.CUSTOM,
                    name: "desktop_action",
                    value: { action },
                  });
                }
              }
            }
          },
        },
      );

      agUiSseSend(res, { type: EVENT.TEXT_MESSAGE_END, messageId });
      agUiSseSend(res, { type: EVENT.RUN_FINISHED, threadId, runId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      agUiSseSend(res, { type: EVENT.RUN_ERROR, threadId, runId, message: msg });
    } finally {
      res.end();
    }
  });
}
