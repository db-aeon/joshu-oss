import type { Request, Response, Router } from "express";

import { getAppManifest, loadAppManifests } from "./appRegistry.js";
import type { AppGuiAction } from "./appGuiActionTypes.js";
import {
  drainAppGuiActions,
  enqueueAppGuiAction,
  isValidAppGuiAction,
} from "./appGuiActionQueue.js";
import { buildAppAgentSessionId } from "./agUiAppContext.js";
import { isDirectLocalhostRequest } from "./httpLocalhost.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Validate action name against manifest guiActions when manifest is loaded. */
export function isAllowedAppGuiAction(
  action: AppGuiAction,
  projectRoot?: string,
): boolean {
  void projectRoot;
  const manifest = getAppManifest(action.appId);
  // Unknown app or headless app without guiActions: refuse rather than queue a no-op.
  if (!manifest) return false;
  if (!manifest.agent?.guiActions?.length) return false;
  return manifest.agent.guiActions.some((entry) => entry.name === action.action);
}

export function describeDisallowedAppGuiAction(action: AppGuiAction): string {
  const manifest = getAppManifest(action.appId);
  if (!manifest) {
    return `Unknown app "${action.appId}" — load a Joshu desktop app with a joshu.app.json manifest`;
  }
  const allowed = (manifest.agent?.guiActions ?? []).map((entry) => entry.name);
  if (!allowed.length) {
    return `App "${action.appId}" does not declare any guiActions`;
  }
  return `action "${action.action}" is not allowed for app "${action.appId}"; allowed: ${allowed.join(", ")}`;
}

export function registerAppGuiActionRoutes(router: Router, projectRoot: string): void {
  router.post("/api/app-gui-actions/enqueue", async (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "app-gui-actions is localhost-only" });
      return;
    }
    await loadAppManifests(projectRoot).catch(() => undefined);
    const body = (req.body ?? {}) as { sessionKey?: string; action?: unknown };
    const sessionKey = readString(body.sessionKey);
    if (!sessionKey || !isValidAppGuiAction(body.action)) {
      res.status(400).json({ error: "sessionKey and valid action required" });
      return;
    }
    const action = body.action;
    if (!isAllowedAppGuiAction(action, projectRoot)) {
      res.status(400).json({ error: describeDisallowedAppGuiAction(action) });
      return;
    }
    enqueueAppGuiAction(sessionKey, action);
    res.json({ ok: true });
  });

  router.get("/api/app-gui-actions/drain", async (req: Request, res: Response) => {
    if (!isDirectLocalhostRequest(req)) {
      res.status(403).json({ error: "app-gui-actions is localhost-only" });
      return;
    }
    const sessionKey = readString(req.query.sessionKey);
    if (!sessionKey) {
      res.status(400).json({ error: "sessionKey query required" });
      return;
    }
    res.json({ actions: drainAppGuiActions(sessionKey) });
  });
}

/** Drain queued GUI actions for an AG-UI app session (prefixed + bare thread id). */
export function drainAppGuiActionsForAgUi(
  appId: string | undefined,
  threadId: string,
  activeSessionId?: string,
): AppGuiAction[] {
  if (!appId) return [];
  const keys = new Set<string>();
  keys.add(buildAppAgentSessionId(appId, threadId));
  if (activeSessionId && activeSessionId !== threadId) {
    keys.add(buildAppAgentSessionId(appId, activeSessionId));
  }
  keys.add(threadId);
  // Plugin post_tool_call may enqueue joshu-hermes-chat:{threadId} when gateway_session_key is absent.
  keys.add(`joshu-hermes-chat:${threadId}`);
  if (activeSessionId && activeSessionId !== threadId) {
    keys.add(`joshu-hermes-chat:${activeSessionId}`);
  }

  const merged: AppGuiAction[] = [];
  for (const key of keys) {
    merged.push(...drainAppGuiActions(key));
  }
  return merged;
}

/** Fallback when enqueue missed — parse app_gui_action tool result from Hermes SSE. */
export function appGuiActionFromHermesToolRaw(raw: unknown): AppGuiAction | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const tryValue = (value: unknown): AppGuiAction | null => {
    if (isValidAppGuiAction(value)) return value;
    if (typeof value !== "string") return null;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const candidate: AppGuiAction = {
        appId: readString(parsed.appId),
        action: readString(parsed.action),
        args:
          parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
            ? (parsed.args as Record<string, unknown>)
            : undefined,
      };
      if (isValidAppGuiAction(candidate)) return candidate;
    } catch {
      /* ignore */
    }
    return null;
  };

  for (const key of ["action", "result", "output", "tool_result"]) {
    const action = tryValue(record[key]);
    if (action) return action;
  }

  const appId = readString(record.appId);
  const actionName = readString(record.action);
  if (appId && actionName) {
    const rawArgs =
      record.args && typeof record.args === "object" && !Array.isArray(record.args)
        ? record.args
        : record.arguments &&
            typeof record.arguments === "object" &&
            !Array.isArray(record.arguments)
          ? record.arguments
          : undefined;
    const candidate: AppGuiAction = {
      appId,
      action: actionName,
      args: rawArgs as Record<string, unknown> | undefined,
    };
    if (isValidAppGuiAction(candidate)) return candidate;
  }

  return null;
}
