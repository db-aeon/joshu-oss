/**
 * Push transcript updates to open jChat clients (SSE per session).
 * Async jobs (cron, …) notify here after appending to Hermes SessionDB.
 */

import type { Response } from "express";

export type HermesChatSessionPushEvent = {
  type: "transcript_updated";
  sessionId: string;
  reason?: string;
  runId?: string;
};

type SessionListener = {
  res: Response;
  sessionIds: Set<string>;
};

const listeners = new Set<SessionListener>();

/** Match bare hermes-chat-* ids and joshu-hermes-chat: prefixed keys. */
export function hermesChatSessionAliases(sessionId: string): string[] {
  const id = sessionId.trim();
  if (!id) return [];
  const aliases = new Set<string>([id]);
  if (id.startsWith("joshu-hermes-chat:")) {
    aliases.add(id.slice("joshu-hermes-chat:".length));
  } else {
    aliases.add(`joshu-hermes-chat:${id}`);
  }
  return [...aliases];
}

export function registerHermesChatSessionListener(sessionId: string, res: Response): () => void {
  const listener: SessionListener = {
    res,
    sessionIds: new Set(hermesChatSessionAliases(sessionId)),
  };
  listeners.add(listener);
  const detach = () => listeners.delete(listener);
  res.on("close", detach);
  return detach;
}

/** Notify connected jChat tabs for this session. Returns listener count notified. */
export function pushHermesChatSessionEvent(
  sessionId: string,
  event: HermesChatSessionPushEvent,
): number {
  const targets = new Set(hermesChatSessionAliases(sessionId));
  let sent = 0;
  for (const listener of listeners) {
    const matches = [...listener.sessionIds].some((id) => targets.has(id));
    if (!matches) continue;
    try {
      listener.res.write(`event: ${event.type}\n`);
      listener.res.write(`data: ${JSON.stringify(event)}\n\n`);
      sent += 1;
    } catch {
      listeners.delete(listener);
    }
  }
  return sent;
}
