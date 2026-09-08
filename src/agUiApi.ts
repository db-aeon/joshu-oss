/**
 * AG-UI-compatible HTTP endpoints — thin Hermes chat stream adapter.
 * CopilotKit HttpAgent can POST RunAgentInput and receive SSE BaseEvents.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { NextFunction, Request, Response, Router } from "express";
import { resolveManifestVoiceTools } from "@joshu/app-sdk";
import type { HermesApiRunner, HermesChatMessage } from "./hermesApi.js";
import { buildTurnSystemMessages } from "./hermesApi.js";
import type { StreamHermesChatCallbacks } from "./hermesApi.js";
import {
  appGuiActionFromHermesToolRaw,
  drainAppGuiActionsForAgUi,
  isAllowedAppGuiAction,
} from "./appGuiActionApi.js";
import type { AppGuiAction } from "./appGuiActionTypes.js";
import { drainDesktopActionsForChat, desktopActionFromHermesToolRaw } from "./desktopActionApi.js";
import { isComposioEnabled, syncComposioHermesMcp } from "./composioApi.js";
import { isDesktopBrowserOrLocalRequest } from "./httpLocalhost.js";
import {
  buildAppAgentSessionId,
  buildAppAgentSystemMessages,
  buildWhiteboardBoardMutationNudge,
  getManifestForAppId,
  groundUserMessagesWithSelection,
  isExcalidrawBoardMutatingAction,
  latestUserText,
  parseAppAgentState,
  requiresExcalidrawBoardMutation,
  resolveAppIdFromRequest,
} from "./agUiAppContext.js";
import {
  buildClientToolNameSet,
  parseAgUiClientTools,
  toOpenAiChatTools,
} from "./agUiFrontendTools.js";
import { loadAppManifests } from "./appRegistry.js";
import { SSE_HEADERS, sseData, startSseHeartbeat } from "./httpSse.js";

type RunAgentInput = {
  threadId?: string;
  runId?: string;
  messages?: Array<{
    role?: string;
    content?: unknown;
    id?: string;
    toolCallId?: string;
    toolCalls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  }>;
  state?: unknown;
  tools?: unknown[];
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
  sseData(res, event);
}

/** Deliver a manifest guiAction to CopilotKit frontend tools (and CUSTOM app_action fallback). */
function emitAppGuiActionEvents(
  res: Response,
  messageId: string,
  guiAction: AppGuiAction,
  clientToolNames: Set<string>,
  onEmitted?: (action: AppGuiAction) => void,
): void {
  agUiSseSend(res, {
    type: EVENT.CUSTOM,
    name: "app_action",
    value: guiAction,
  });
  onEmitted?.(guiAction);

  if (!clientToolNames.has(guiAction.action)) return;

  const toolCallId = `agui_gui_${guiAction.action}_${Date.now()}`;
  const argsJson = JSON.stringify(guiAction.args ?? {});
  agUiSseSend(res, {
    type: EVENT.TOOL_CALL_START,
    toolCallId,
    toolCallName: guiAction.action,
    parentMessageId: messageId,
  });
  agUiSseSend(res, {
    type: EVENT.TOOL_CALL_ARGS,
    toolCallId,
    delta: argsJson,
  });
  agUiSseSend(res, {
    type: EVENT.TOOL_CALL_END,
    toolCallId,
    toolCallName: guiAction.action,
  });
}

function drainAndEmitAppGuiActions(
  res: Response,
  messageId: string,
  appId: string | undefined,
  threadId: string,
  activeSessionId: string,
  clientToolNames: Set<string>,
  onEmitted?: (action: AppGuiAction) => void,
): void {
  const actions = drainAppGuiActionsForAgUi(appId, threadId, activeSessionId);
  for (const action of actions) {
    if (!isAllowedAppGuiAction(action)) continue;
    emitAppGuiActionEvents(res, messageId, action, clientToolNames, onEmitted);
  }
}

/** Map CopilotKit / AG-UI messages to Hermes chat/completions format (incl. tool turns). */
function toHermesMessages(input: RunAgentInput): HermesChatMessage[] {
  const raw = input.messages ?? [];
  const out: HermesChatMessage[] = [];

  for (const m of raw) {
    const role = readString(m.role);
    if (role === "tool") {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      if (!content) continue;
      out.push({
        role: "tool",
        content,
        tool_call_id: readString(m.toolCallId) || undefined,
      });
      continue;
    }

    if (role === "assistant" && m.toolCalls?.length) {
      const content = typeof m.content === "string" ? m.content : "";
      out.push({
        role: "assistant",
        content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id ?? "",
          type: "function" as const,
          function: {
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "{}",
          },
        })),
      });
      continue;
    }

    const normalizedRole =
      role === "system" || role === "assistant" || role === "user" ? role : "user";
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (!content) continue;
    out.push({ role: normalizedRole, content });
  }

  return out;
}

function isHermesChatMessage(m: HermesChatMessage): boolean {
  return m.role === "user" || m.role === "assistant" || m.role === "system" || m.role === "tool";
}

function isLocalhostAgUi(req: Request): boolean {
  return isDesktopBrowserOrLocalRequest(req);
}

/** Permit local ArozOS subservices on :8787 to stream AG-UI runs from :8788. */
export function setAgUiCors(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const { hostname } = new URL(origin);
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
  } catch {
    // Invalid or remote origins receive no cross-origin grant.
  }
}

function hermesHomeDir(): string {
  return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
}

/** Remove Hermes session transcript for an AG-UI threadId (localhost only). */
function deleteHermesSessionTranscript(threadId: string): boolean {
  const file = path.join(hermesHomeDir(), "sessions", `session_${threadId}.json`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function registerAgUiRoutes(
  router: Router,
  runner: HermesApiRunner,
  projectRoot: string,
): void {
  router.use("/api/ag-ui", (req: Request, res: Response, next: NextFunction) => {
    setAgUiCors(req, res);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  router.get("/api/ag-ui/info", async (req: Request, res: Response) => {
    await loadAppManifests(projectRoot);
    const appId = readString(req.query.appId);
    const manifest = getManifestForAppId(appId);
    const guiActions = manifest?.agent?.guiActions ?? [];
    const voiceTools = resolveManifestVoiceTools(guiActions, manifest?.agent?.voiceCommands);

    res.json({
      agents: [
        {
          id: "hermes-default",
          name: manifest?.name ? `${manifest.name} Agent` : "Hermes",
          description: "Joshu box agent (Hermes gateway)",
          appId: appId || undefined,
          guiActions: guiActions.map((a) => a.name),
          guiActionDetails: guiActions,
          voiceTools,
          skills: [
            ...(manifest?.agent?.usesSkills ?? []),
            ...(manifest?.agent?.skill ? [manifest.agent.skill] : []),
          ],
        },
      ],
    });
  });

  router.post("/api/ag-ui/run", async (req: Request, res: Response) => {
    if (!isDesktopBrowserOrLocalRequest(req)) {
      res.status(403).json({ error: "ag-ui is desktop-session-only" });
      return;
    }
    await loadAppManifests(projectRoot);
    const input = (req.body ?? {}) as RunAgentInput;
    const threadId = readString(input.threadId) || readString(input.runId) || `agui-${Date.now()}`;
    const runId = readString(input.runId) || threadId;
    const messages = toHermesMessages(input);
    const clientTools = parseAgUiClientTools(input.tools);
    const clientToolNames = buildClientToolNameSet(clientTools);
    const openAiClientTools = toOpenAiChatTools(clientTools);

    if (messages.length === 0) {
      return res.status(400).json({ error: "messages required" });
    }

    const appState = parseAppAgentState(input.state);
    const appId = resolveAppIdFromRequest(req.query.appId, appState);
    const manifest = getManifestForAppId(appId);
    const appSystemMessages = buildAppAgentSystemMessages(manifest, appState);
    const groundedMessages = groundUserMessagesWithSelection(messages, appState.gui);
    const sessionKey = appId ? buildAppAgentSessionId(appId, threadId) : undefined;
    const selectedCount = Array.isArray(appState.gui?.selectedItems)
      ? appState.gui.selectedItems.length
      : 0;
    console.info(
      `[ag-ui] app=${appId ?? "none"} thread=${threadId} selectedItems=${selectedCount}` +
        ` selectionSource=${String(appState.gui?.selectionSource ?? "n/a")}`,
    );

    res.set(SSE_HEADERS);
    res.flushHeaders?.();

    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const stopHeartbeat = startSseHeartbeat(res);

    agUiSseSend(res, { type: EVENT.RUN_STARTED, threadId, runId });

    const messageId = `msg_${runId}`;
    agUiSseSend(res, { type: EVENT.TEXT_MESSAGE_START, messageId, role: "assistant" });

    let activeSessionId = threadId;
    const emittedClientToolStarts = new Set<string>();
    let boardMutationsThisRun = 0;
    const noteEmittedGuiAction = (action: AppGuiAction) => {
      if (appId === "excalidraw" && isExcalidrawBoardMutatingAction(action.action)) {
        boardMutationsThisRun += 1;
      }
    };

    try {
      if (isComposioEnabled()) {
        await syncComposioHermesMcp(projectRoot).catch(() => undefined);
      }
      await runner.ensureGatewayReady().catch(() => undefined);

      const turnSystemMessages = buildTurnSystemMessages(projectRoot, { browser: null });
      const hermesHandlers: StreamHermesChatCallbacks = {
        onSession: (sid) => {
          activeSessionId = sid;
        },
        onDelta: (text) => {
          if (text) {
            agUiSseSend(res, { type: EVENT.TEXT_MESSAGE_CONTENT, messageId, delta: text });
          }
        },
        onClientToolCall: (tool) => {
          if (tool.phase === "start" && !emittedClientToolStarts.has(tool.toolCallId)) {
            emittedClientToolStarts.add(tool.toolCallId);
            agUiSseSend(res, {
              type: EVENT.TOOL_CALL_START,
              toolCallId: tool.toolCallId,
              toolCallName: tool.toolCallName,
              parentMessageId: messageId,
            });
          }
          if (tool.phase === "args" && tool.argumentsDelta) {
            agUiSseSend(res, {
              type: EVENT.TOOL_CALL_ARGS,
              toolCallId: tool.toolCallId,
              delta: tool.argumentsDelta,
            });
          }
          if (tool.phase === "end") {
            agUiSseSend(res, {
              type: EVENT.TOOL_CALL_END,
              toolCallId: tool.toolCallId,
              toolCallName: tool.toolCallName,
            });
          }
        },
        onTool: (tool) => {
          const shortName = tool.tool?.replace(/^.*\./, "") ?? "";
          if (clientToolNames.has(tool.tool ?? "") || clientToolNames.has(shortName)) {
            return;
          }
          const toolCallId = tool.toolCallId ?? `tool_${tool.tool ?? "unknown"}`;
          if (tool.status === "running") {
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
            if (shortName === "desktop_open") {
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
            if (shortName === "app_gui_action") {
              let guiActions = drainAppGuiActionsForAgUi(appId, threadId, activeSessionId);
              if (guiActions.length === 0) {
                const fromTool = appGuiActionFromHermesToolRaw(tool.raw);
                if (fromTool) guiActions = [fromTool];
              }
              for (const guiAction of guiActions) {
                if (!isAllowedAppGuiAction(guiAction)) continue;
                emitAppGuiActionEvents(
                  res,
                  messageId,
                  guiAction,
                  clientToolNames,
                  noteEmittedGuiAction,
                );
              }
            }
          }
        },
      };

      const baseHermesMessages = [
        ...turnSystemMessages,
        ...appSystemMessages,
        ...groundedMessages.filter(isHermesChatMessage),
      ];

      await runner.streamHermesChat(
        {
          sessionId: threadId,
          sessionKey,
          messages: baseHermesMessages,
          signal: controller.signal,
          clientTools: openAiClientTools.length ? openAiClientTools : undefined,
          clientToolNames: clientToolNames.size ? clientToolNames : undefined,
        },
        hermesHandlers,
      );

      drainAndEmitAppGuiActions(
        res,
        messageId,
        appId,
        threadId,
        activeSessionId,
        clientToolNames,
        noteEmittedGuiAction,
      );

      // Mechanical AG-UI tenet: whiteboard review/empty-board turns must mutate the canvas.
      const mustWriteBoard = requiresExcalidrawBoardMutation(
        appState.gui,
        latestUserText(groundedMessages),
      );
      if (mustWriteBoard && boardMutationsThisRun === 0 && !controller.signal.aborted) {
        console.warn(
          `[ag-ui] whiteboard board-mutation gate: no proposeTransaction/recallToBoard/stageOpening — retrying once`,
        );
        await runner.streamHermesChat(
          {
            sessionId: threadId,
            sessionKey,
            messages: [
              ...baseHermesMessages,
              { role: "system", content: buildWhiteboardBoardMutationNudge() },
              {
                role: "user",
                content:
                  "Continue: put the results on the board now via app_gui_action (proposeTransaction, recallToBoard, or stageOpening). Do not reply with a chat-only list.",
              },
            ],
            signal: controller.signal,
            clientTools: openAiClientTools.length ? openAiClientTools : undefined,
            clientToolNames: clientToolNames.size ? clientToolNames : undefined,
          },
          hermesHandlers,
        );
        drainAndEmitAppGuiActions(
          res,
          messageId,
          appId,
          threadId,
          activeSessionId,
          clientToolNames,
          noteEmittedGuiAction,
        );
        if (boardMutationsThisRun === 0) {
          console.warn(
            `[ag-ui] whiteboard board-mutation gate: still no board GUI after retry`,
          );
          agUiSseSend(res, {
            type: EVENT.TEXT_MESSAGE_CONTENT,
            messageId,
            delta:
              "\n\n(Board was not updated — this turn never called proposeTransaction / recallToBoard / stageOpening.)",
          });
        }
      }

      agUiSseSend(res, { type: EVENT.TEXT_MESSAGE_END, messageId });
      agUiSseSend(res, { type: EVENT.RUN_FINISHED, threadId, runId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      agUiSseSend(res, { type: EVENT.RUN_ERROR, threadId, runId, message: msg });
    } finally {
      stopHeartbeat();
      res.end();
    }
  });

  router.delete("/api/ag-ui/session", (req: Request, res: Response) => {
    if (!isLocalhostAgUi(req)) {
      return res.status(403).json({ error: "localhost only" });
    }
    const threadId = readString(req.query.threadId);
    if (!threadId) {
      return res.status(400).json({ error: "threadId query required" });
    }
    const deleted = deleteHermesSessionTranscript(threadId);
    res.json({ ok: true, threadId, deleted });
  });
}
