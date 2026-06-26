/** Composio MCP tool names that require owner approval in v1 allowlist mode. */
const COMPOSIO_GUARDED_TOOLS = new Set([
  "GMAIL_SEND_EMAIL",
  "GMAIL_REPLY_TO_THREAD",
]);

export const COMPOSIO_WRITE_HEURISTICS = [
  /_SEND_/i,
  /_CREATE_/i,
  /_UPDATE_/i,
  /_POST_/i,
  /_REPLY_/i,
];

/** Meta / read tools — never gated even in external_writes mode. */
const COMPOSIO_READ_EXCLUSIONS = [
  /^COMPOSIO_/i,
  /_SEARCH_/i,
  /_LIST_/i,
  /_FETCH_/i,
  /_FIND_/i,
  /_READ_/i,
  /_GET_/i,
];

export const BROWSER_WRITE_ACTION_IDS = new Set([
  "browser:click",
  "browser:type",
  "browser:press",
  "browser:evaluate",
  "browser:submit",
]);

const CONNECTORS_WRITE_TOOLS = new Set(["nylas_send_message"]);

export type ActionExposure = "external" | "owner_only" | "ambiguous";

/** Map connectors MCP tool name to guard action id. */
export function connectorsActionId(toolName: string): string {
  return toolName.trim();
}

/** Map Composio MCP tool name to guard action id. */
export function composioActionId(toolName: string): string {
  return `composio:${toolName.trim()}`;
}

/** Map browser write to guard action id. */
export function browserActionId(kind: string): string {
  return `browser:${kind.trim()}`;
}

/** True when a Composio tool name looks like an external write (not a read/meta tool). */
export function isComposioWriteTool(toolName: string): boolean {
  const name = toolName.trim();
  if (!name) return false;
  if (COMPOSIO_READ_EXCLUSIONS.some((re) => re.test(name))) return false;
  return COMPOSIO_WRITE_HEURISTICS.some((re) => re.test(name));
}

export function isComposioToolGuarded(toolName: string, guardedActions: string[]): boolean {
  const name = toolName.trim();
  const actionId = composioActionId(name);
  if (guardedActions.includes(actionId)) return true;
  if (COMPOSIO_GUARDED_TOOLS.has(name)) return true;
  if (guardedActions.some((a) => a === "composio:*" || a === "composio:write")) {
    return isComposioWriteTool(name);
  }
  return false;
}

export function isConnectorsToolGuarded(toolName: string, guardedActions: string[]): boolean {
  if (guardedActions.includes(connectorsActionId(toolName))) return true;
  return CONNECTORS_WRITE_TOOLS.has(toolName.trim());
}

export function isBrowserWriteAction(actionId: string): boolean {
  return BROWSER_WRITE_ACTION_IDS.has(actionId.trim());
}

export type ActionGuardPolicySlice = {
  gateMode?: "allowlist" | "external_writes";
  guardedActions?: string[];
  browserGateWrites?: boolean;
};

/** external_writes mode: gate third-party-visible writes. */
export function isActionGuardedExternalWrites(
  actionId: string,
  policy: ActionGuardPolicySlice,
): boolean {
  const id = actionId.trim();
  if (!id) return false;

  if (id.startsWith("composio:")) {
    return isComposioWriteTool(id.slice("composio:".length));
  }
  if (id.startsWith("browser:")) {
    return policy.browserGateWrites === true && isBrowserWriteAction(id);
  }
  if (CONNECTORS_WRITE_TOOLS.has(id)) return true;
  return false;
}

export function resolveActionExposure(
  actionId: string,
  summary: Record<string, unknown>,
): ActionExposure {
  const id = actionId.trim();

  if (id.startsWith("composio:")) {
    const tool = id.slice("composio:".length);
    if (!isComposioWriteTool(tool)) return "owner_only";
    if (/_UPDATE_/i.test(tool) && !summary.to && !summary.attendees && !summary.channel) {
      return "ambiguous";
    }
    return "external";
  }

  if (id.startsWith("browser:")) {
    if (id === "browser:evaluate" && summary.expressionPreview) return "ambiguous";
    return "external";
  }

  if (id === "nylas_send_message") return "external";
  return "owner_only";
}
