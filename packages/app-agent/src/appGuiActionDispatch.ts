/** Client-side dispatch for AG-UI app_action / synthesized gui tool calls. */

export type AppGuiActionHandler = (
  args: Record<string, unknown>,
) => Promise<string> | string;

const handlers = new Map<string, AppGuiActionHandler>();

export function registerAppGuiActionHandler(name: string, handler: AppGuiActionHandler): () => void {
  handlers.set(name, handler);
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name);
  };
}

export async function dispatchAppGuiAction(
  action: string,
  args?: Record<string, unknown>,
): Promise<boolean> {
  const handler = handlers.get(action);
  if (!handler) return false;
  await handler(args ?? {});
  return true;
}

export type AppGuiActionWirePayload = {
  appId?: string;
  action?: string;
  args?: Record<string, unknown>;
};

export async function dispatchAppGuiActionWire(payload: AppGuiActionWirePayload): Promise<boolean> {
  const action = typeof payload.action === "string" ? payload.action.trim() : "";
  if (!action) return false;
  return dispatchAppGuiAction(action, payload.args);
}

/** Parse AG-UI SSE data lines and dispatch app GUI actions (tee-safe). */
export async function handleAgUiSseDataLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;
  const jsonText = trimmed.slice(5).trim();
  if (!jsonText || jsonText === "[DONE]") return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "CUSTOM" && event.name === "app_action") {
    const value = event.value;
    if (value && typeof value === "object") {
      await dispatchAppGuiActionWire(value as AppGuiActionWirePayload);
    }
  }
}
