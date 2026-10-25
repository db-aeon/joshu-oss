/**
 * Runtime copy of src/mcpToolPolicy.ts for standalone MCP proxy scripts.
 * Keep in sync with the TypeScript module.
 */

/** @typedef {{ enabled: boolean; composioBlockedTools: string[]; connectorsBlockedTools: string[] }} McpToolPolicy */

/** Composio workbench tools: the Composio MCP guard runs them on the read session only. */
export const COMPOSIO_WORKBENCH_TOOLS = ["COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL"];

export const COMPOSIO_BLOCKED_TOOLS = ["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD"];

export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

/** Depth limit for a COMPOSIO_MULTI_EXECUTE_TOOL inside another one. */
const MAX_MULTI_EXECUTE_DEPTH = 4;

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

/** @typedef {{ toolName: string; args: Record<string, unknown> }} ComposioToolCall */

/**
 * The tool calls that one Composio MCP call runs: the inner tool calls of
 * COMPOSIO_MULTI_EXECUTE_TOOL (also nested ones), or the call itself for any other tool.
 * Returns null when a COMPOSIO_MULTI_EXECUTE_TOOL call has no list of inner tool calls
 * or an inner tool call has no tool name, because then nobody can tell what the call does.
 * @param {string} toolName
 * @param {unknown} args
 * @returns {ComposioToolCall[] | null}
 */
export function composioInnerToolCalls(toolName, args, depth = 0) {
  const name = String(toolName ?? "").trim();
  const a = args && typeof args === "object" && !Array.isArray(args) ? /** @type {Record<string, unknown>} */ (args) : {};
  if (name.toUpperCase() !== COMPOSIO_MULTI_EXECUTE_TOOL) return [{ toolName: name, args: a }];
  if (depth >= MAX_MULTI_EXECUTE_DEPTH || !Array.isArray(a.tools)) return null;
  /** @type {ComposioToolCall[]} */
  const calls = [];
  for (const item of a.tools) {
    const row = item && typeof item === "object" ? /** @type {Record<string, unknown>} */ (item) : {};
    const slug = typeof row.tool_slug === "string" ? row.tool_slug.trim() : "";
    if (!slug) return null;
    const inner = composioInnerToolCalls(slug, row.arguments, depth + 1);
    if (!inner) return null;
    calls.push(...inner);
  }
  return calls;
}

/**
 * Hard block reason for a whole Composio MCP call: the first inner tool call with a hard block.
 * @param {string} toolName
 * @param {unknown} args
 * @param {McpToolPolicy | null | undefined} policy
 * @returns {string | null}
 */
export function composioCallBlockReason(toolName, args, policy = defaultMcpToolPolicy()) {
  if (!policy?.enabled) return null;
  const calls = composioInnerToolCalls(toolName, args);
  if (!calls) {
    return `${COMPOSIO_MULTI_EXECUTE_TOOL} needs a tools list where each entry has a tool_slug.`;
  }
  for (const call of calls) {
    const reason = composioToolBlockReason(call.toolName, policy);
    if (reason) return reason;
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
    return "Nylas calendar writes are disabled. Book on the owner Google calendar with google_calendar_create_event, or move an event with google_calendar_update_event (after a google_calendar_find_free_slots availability check).";
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
