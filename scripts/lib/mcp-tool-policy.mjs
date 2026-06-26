/**
 * Runtime copy of src/mcpToolPolicy.ts for standalone MCP proxy scripts.
 * Keep in sync with the TypeScript module.
 */

/** @typedef {{ enabled: boolean; composioBlockedTools: string[]; connectorsBlockedTools: string[] }} McpToolPolicy */

export const COMPOSIO_BLOCKED_TOOLS = ["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD"];

export const CONNECTORS_BLOCKED_TOOLS = [
  "nylas_create_event",
  "nylas_update_event",
  "nylas_delete_event",
];

export const COMPOSIO_BLOCKED_PATTERNS = [
  /^GMAIL_.*(SEND|REPLY|FORWARD|CREATE_DRAFT|DRAFT)/i,
  /DELETE/i,
  /TRASH/i,
];

/** @returns {McpToolPolicy} */
export function defaultMcpToolPolicy() {
  const raw = process.env.JOSHU_MCP_TOOL_POLICY_ENABLED?.trim();
  const enabled = raw ? /^(1|true|yes|on)$/i.test(raw) : true;
  if (!enabled) {
    return { enabled: false, composioBlockedTools: [], connectorsBlockedTools: [] };
  }
  return {
    enabled: true,
    composioBlockedTools: [...COMPOSIO_BLOCKED_TOOLS],
    connectorsBlockedTools: [...CONNECTORS_BLOCKED_TOOLS],
  };
}

/**
 * @param {McpToolPolicy | null | undefined} policy
 * @param {string} toolName
 * @returns {string | null}
 */
export function composioToolBlockReason(toolName, policy = defaultMcpToolPolicy()) {
  if (!policy?.enabled) return null;
  const name = String(toolName ?? "").trim();
  const upper = name.toUpperCase();
  if (policy.composioBlockedTools.some((t) => t.toUpperCase() === upper)) {
    if (/^GMAIL_/i.test(name) && /(SEND|REPLY|FORWARD|DRAFT)/i.test(name)) {
      return "Principal Gmail mail send is disabled for agents. Use mcp_joshu_connectors_nylas_send_message.";
    }
    return `Composio tool ${name} is blocked by Joshu MCP policy.`;
  }
  if (COMPOSIO_BLOCKED_PATTERNS.some((re) => re.test(name))) {
    if (/^GMAIL_/i.test(name)) {
      return "Principal Gmail mail send is disabled for agents. Use mcp_joshu_connectors_nylas_send_message.";
    }
    if (/DELETE|TRASH/i.test(name)) {
      return "Delete/trash actions are disabled for agents.";
    }
    return `Composio tool ${name} is blocked by Joshu MCP policy.`;
  }
  return null;
}

/**
 * @param {McpToolPolicy | null | undefined} policy
 * @param {string} toolName
 * @returns {string | null}
 */
export function connectorsToolBlockReason(toolName, policy = defaultMcpToolPolicy()) {
  if (!policy?.enabled) return null;
  const name = String(toolName ?? "").trim().toLowerCase();
  if (policy.connectorsBlockedTools.some((t) => t.toLowerCase() === name)) {
    return "Nylas calendar writes are disabled. Book on owner Google Calendar via Composio GOOGLECALENDAR_CREATE_EVENT (after google_calendar_find_free_slots availability check).";
  }
  return null;
}

/**
 * @param {unknown} payload
 * @returns {McpToolPolicy}
 */
export function mcpToolPolicyFromApi(payload) {
  if (!payload || typeof payload !== "object") return defaultMcpToolPolicy();
  const row = /** @type {Record<string, unknown>} */ (payload);
  const policy = row.policy;
  if (!policy || typeof policy !== "object") return defaultMcpToolPolicy();
  const p = /** @type {Record<string, unknown>} */ (policy);
  return {
    enabled: p.enabled === true,
    composioBlockedTools: Array.isArray(p.composioBlockedTools)
      ? p.composioBlockedTools.filter((x) => typeof x === "string")
      : [...COMPOSIO_BLOCKED_TOOLS],
    connectorsBlockedTools: Array.isArray(p.connectorsBlockedTools)
      ? p.connectorsBlockedTools.filter((x) => typeof x === "string")
      : [...CONNECTORS_BLOCKED_TOOLS],
  };
}
