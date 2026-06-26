import type { Request, Response, Router } from "express";

import { drainDesktopActions, enqueueDesktopAction, isValidDesktopAction } from "./desktopActionQueue.js";
import type { DesktopAction } from "./desktopActionTypes.js";

function isLocalhost(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  const host = (req.hostname ?? "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost";
}

export function registerDesktopActionRoutes(router: Router): void {
  router.post("/api/desktop-actions/enqueue", (req: Request, res: Response) => {
    if (!isLocalhost(req)) {
      res.status(403).json({ error: "localhost only" });
      return;
    }
    const body = (req.body ?? {}) as { sessionKey?: string; action?: unknown };
    const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
    if (!sessionKey || !isValidDesktopAction(body.action)) {
      res.status(400).json({ error: "sessionKey and valid action required" });
      return;
    }
    enqueueDesktopAction(sessionKey, body.action);
    res.json({ ok: true });
  });

  router.get("/api/desktop-actions/drain", (req: Request, res: Response) => {
    if (!isLocalhost(req)) {
      res.status(403).json({ error: "localhost only" });
      return;
    }
    const sessionKey = typeof req.query.sessionKey === "string" ? req.query.sessionKey.trim() : "";
    if (!sessionKey) {
      res.status(400).json({ error: "sessionKey query required" });
      return;
    }
    res.json({ actions: drainDesktopActions(sessionKey) });
  });
}

/** Hermes chat session key used by jChat text stream. */
export function hermesChatSessionKey(sessionId: string): string {
  return `joshu-hermes-chat:${sessionId}`;
}

/** Drain queued actions for a jChat session (prefixed + legacy bare id). */
export function drainDesktopActionsForChat(sessionId: string) {
  const prefixed = drainDesktopActions(hermesChatSessionKey(sessionId));
  const bare = drainDesktopActions(sessionId);
  return [...prefixed, ...bare];
}

/** Fallback when enqueue missed — parse desktop_open tool result from Hermes SSE. */
export function desktopActionFromHermesToolRaw(raw: unknown): DesktopAction | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const tryValue = (value: unknown): DesktopAction | null => {
    if (isValidDesktopAction(value)) return value;
    if (typeof value !== "string") return null;
    try {
      const parsed = JSON.parse(value) as { action?: unknown };
      if (isValidDesktopAction(parsed?.action)) return parsed.action;
    } catch {
      /* ignore */
    }
    return null;
  };

  for (const key of ["action", "result", "output", "tool_result"]) {
    const action = tryValue(record[key]);
    if (action) return action;
  }
  return null;
}
