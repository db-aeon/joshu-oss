import type { AppGuiAction } from "./appGuiActionTypes.js";

/** Pending app GUI actions from Hermes app_gui_action (keyed by Hermes session key). */
const pendingBySession = new Map<string, AppGuiAction[]>();

export function enqueueAppGuiAction(sessionKey: string, action: AppGuiAction): void {
  const key = sessionKey.trim();
  if (!key) return;
  const list = pendingBySession.get(key) ?? [];
  list.push(action);
  pendingBySession.set(key, list);
}

export function drainAppGuiActions(sessionKey: string): AppGuiAction[] {
  const key = sessionKey.trim();
  if (!key) return [];
  const list = pendingBySession.get(key) ?? [];
  pendingBySession.delete(key);
  return list;
}

export function isValidAppGuiAction(value: unknown): value is AppGuiAction {
  if (!value || typeof value !== "object") return false;
  const doc = value as Record<string, unknown>;
  if (typeof doc.appId !== "string" || !doc.appId.trim()) return false;
  if (typeof doc.action !== "string" || !doc.action.trim()) return false;
  if (doc.args !== undefined && (typeof doc.args !== "object" || doc.args === null || Array.isArray(doc.args))) {
    return false;
  }
  return true;
}
