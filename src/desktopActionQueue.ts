import type { DesktopAction } from "./desktopActionTypes.js";

/** Pending desktop actions from Hermes desktop_open tool (keyed by Hermes session key). */
const pendingBySession = new Map<string, DesktopAction[]>();

export function enqueueDesktopAction(sessionKey: string, action: DesktopAction): void {
  const key = sessionKey.trim();
  if (!key) return;
  const list = pendingBySession.get(key) ?? [];
  list.push(action);
  pendingBySession.set(key, list);
}

export function drainDesktopActions(sessionKey: string): DesktopAction[] {
  const key = sessionKey.trim();
  if (!key) return [];
  const list = pendingBySession.get(key) ?? [];
  pendingBySession.delete(key);
  return list;
}

export function isValidDesktopAction(value: unknown): value is DesktopAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  if (action.kind !== "module" && action.kind !== "file") return false;
  return typeof action.target === "string" && action.target.trim().length > 0;
}
