import type { Request, Response, Router } from "express";

import { getAppManifest, loadAppManifests } from "./appRegistry.js";
import type { AppGuiAction } from "./appGuiActionTypes.js";
import {
  drainAppGuiActions,
  enqueueAppGuiAction,
  isValidAppGuiAction,
} from "./appGuiActionQueue.js";
import { buildAppAgentSessionId } from "./agUiAppContext.js";

function isLocalhost(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  const host = (req.hostname ?? "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Validate action name against manifest guiActions when manifest is loaded. */
export function isAllowedAppGuiAction(
  action: AppGuiAction,
  projectRoot?: string,
): boolean {
  const manifest = getAppManifest(action.appId);
  if (!manifest?.agent?.guiActions?.length) {
    // Allow when manifest not loaded (enqueue from plugin before warm) or headless apps.
    return true;
  }
  return manifest.agent.guiActions.some((entry) => entry.name === action.action);
}

export function registerAppGuiActionRoutes(router: Router, projectRoot: string): void {
  router.post("/api/app-gui-actions/enqueue", async (req: Request, res: Response) => {
    if (!isLocalhost(req)) {
      res.status(403).json({ error: "localhost only" });
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
      res.status(400).json({ error: `action not allowed for app ${action.appId}` });
      return;
    }
    enqueueAppGuiAction(sessionKey, action);
    res.json({ ok: true });
  });

  router.get("/api/app-gui-actions/drain", async (req: Request, res: Response) => {
    if (!isLocalhost(req)) {
      res.status(403).json({ error: "localhost only" });
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
    const candidate: AppGuiAction = {
      appId,
      action: actionName,
      args:
        record.args && typeof record.args === "object" && !Array.isArray(record.args)
          ? (record.args as Record<string, unknown>)
          : undefined,
    };
    if (isValidAppGuiAction(candidate)) return candidate;
  }

  return null;
}
