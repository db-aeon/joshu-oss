/**
 * Hard MCP tool policy for Hermes agents.
 *
 * Enforced in:
 * - Composio MCP guard proxy (`scripts/composio-mcp-guard-proxy.mjs`)
 * - Connectors MCP (`scripts/joshu-connectors-mcp-http-server.mjs`)
 * - Joshu REST (defense in depth for execute_code / curl bypass)
 *
 * Routing intent:
 * - Outbound mail: Nylas agent mailbox only (never principal Gmail via Composio)
 * - Calendar create/update: owner Google Calendar via Composio (never Nylas calendar writes)
 * - Deletes: blocked everywhere
 */

export type McpToolPolicy = {
  enabled: boolean;
  /** Exact Composio tool names always blocked when policy is enabled. */
  composioBlockedTools: string[];
  /** Exact connectors MCP tool names always blocked when policy is enabled. */
  connectorsBlockedTools: string[];
};

/** Composio tools blocked by exact name (case-insensitive match). */
export const COMPOSIO_BLOCKED_TOOLS = [
  "GMAIL_SEND_EMAIL",
  "GMAIL_REPLY_TO_THREAD",
] as const;

export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

/** Depth limit for a COMPOSIO_MULTI_EXECUTE_TOOL inside another one. */
const MAX_MULTI_EXECUTE_DEPTH = 4;

/** Connectors MCP tools blocked by exact name. */
export const CONNECTORS_BLOCKED_TOOLS = [
  "nylas_create_event",
  "nylas_update_event",
  "nylas_delete_event",
] as const;

/** Heuristic Composio tool-name patterns (applied when policy enabled). */
export const COMPOSIO_BLOCKED_PATTERNS: RegExp[] = [
  /^GMAIL_.*(SEND|REPLY|FORWARD|CREATE_DRAFT|DRAFT)/i,
  /DELETE/i,
  /TRASH/i,
];

const DEFAULT_POLICY: McpToolPolicy = {
  enabled: true,
  composioBlockedTools: [...COMPOSIO_BLOCKED_TOOLS],
  connectorsBlockedTools: [...CONNECTORS_BLOCKED_TOOLS],
};

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = envTrim(name);
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

import fs from "node:fs";
import { actionGuardPolicyPath } from "./actionGuard/paths.js";

function readMcpPolicyFromFile(): boolean | null {
  const file = actionGuardPolicyPath();
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpToolPolicyEnabled?: boolean };
    return typeof parsed.mcpToolPolicyEnabled === "boolean" ? parsed.mcpToolPolicyEnabled : null;
  } catch {
    return null;
  }
}

export function isMcpToolPolicyEnabled(): boolean {
  const fromEnv = envTrim("JOSHU_MCP_TOOL_POLICY_ENABLED");
  if (fromEnv) return envBool("JOSHU_MCP_TOOL_POLICY_ENABLED", true);
  const fromFile = readMcpPolicyFromFile();
  if (fromFile !== null) return fromFile;
  return true;
}

export function loadMcpToolPolicy(): McpToolPolicy {
  if (!isMcpToolPolicyEnabled()) {
    return { enabled: false, composioBlockedTools: [], connectorsBlockedTools: [] };
  }
  return DEFAULT_POLICY;
}

function normalizeToolName(toolName: string): string {
  return toolName.trim();
}

function matchesComposioPatterns(name: string): boolean {
  return COMPOSIO_BLOCKED_PATTERNS.some((re) => re.test(name));
}

export function composioToolBlockReason(toolName: string, policy = loadMcpToolPolicy()): string | null {
  if (!policy.enabled) return null;
  const name = normalizeToolName(toolName);
  const upper = name.toUpperCase();
  if (policy.composioBlockedTools.some((t) => t.toUpperCase() === upper)) {
    if (/^GMAIL_/i.test(name) && /(SEND|REPLY|FORWARD|DRAFT)/i.test(name)) {
      return "Principal Gmail mail send is disabled for agents. Use mcp_joshu_connectors_nylas_send_message.";
    }
    return `Composio tool ${name} is blocked by Joshu MCP policy.`;
  }
  if (matchesComposioPatterns(name)) {
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

export function isComposioToolBlocked(toolName: string, policy = loadMcpToolPolicy()): boolean {
  return composioToolBlockReason(toolName, policy) !== null;
}

export type ComposioToolCall = { toolName: string; args: Record<string, unknown> };

/**
 * The tool calls that one Composio MCP call runs: the inner tool calls of
 * COMPOSIO_MULTI_EXECUTE_TOOL (also nested ones), or the call itself for any other tool.
 * Returns null when a COMPOSIO_MULTI_EXECUTE_TOOL call has no list of inner tool calls
 * or an inner tool call has no tool name, because then nobody can tell what the call does.
 */
export function composioInnerToolCalls(toolName: string, args: unknown, depth = 0): ComposioToolCall[] | null {
  const name = normalizeToolName(String(toolName ?? ""));
  const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (name.toUpperCase() !== COMPOSIO_MULTI_EXECUTE_TOOL) return [{ toolName: name, args: a }];
  if (depth >= MAX_MULTI_EXECUTE_DEPTH || !Array.isArray(a.tools)) return null;
  const calls: ComposioToolCall[] = [];
  for (const item of a.tools) {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const slug = typeof row.tool_slug === "string" ? row.tool_slug.trim() : "";
    if (!slug) return null;
    const inner = composioInnerToolCalls(slug, row.arguments, depth + 1);
    if (!inner) return null;
    calls.push(...inner);
  }
  return calls;
}

/** Hard block reason for a whole Composio call: the first inner tool call with a hard block. */
export function composioCallBlockReason(
  toolName: string,
  args: unknown,
  policy = loadMcpToolPolicy(),
): string | null {
  if (!policy.enabled) return null;
  const calls = composioInnerToolCalls(toolName, args);
  if (!calls) return `${COMPOSIO_MULTI_EXECUTE_TOOL} needs a tools list where each entry has a tool_slug.`;
  for (const call of calls) {
    const reason = composioToolBlockReason(call.toolName, policy);
    if (reason) return reason;
  }
  return null;
}

export function connectorsToolBlockReason(toolName: string, policy = loadMcpToolPolicy()): string | null {
  if (!policy.enabled) return null;
  const name = normalizeToolName(toolName);
  if (policy.connectorsBlockedTools.some((t) => t.toLowerCase() === name.toLowerCase())) {
    return "Nylas calendar writes are disabled. Book on the owner Google calendar with google_calendar_create_event, or move an event with google_calendar_update_event (after a google_calendar_find_free_slots availability check).";
  }
  return null;
}

export function isConnectorsToolBlocked(toolName: string, policy = loadMcpToolPolicy()): boolean {
  return connectorsToolBlockReason(toolName, policy) !== null;
}

/** Filter Composio listTools output — hide blocked tools from the agent catalog. */
export function filterComposioTools<T extends { name: string }>(
  tools: T[],
  policy = loadMcpToolPolicy(),
): T[] {
  if (!policy.enabled) return tools;
  return tools.filter((t) => !isComposioToolBlocked(t.name, policy));
}

/** Filter connectors MCP tool definitions. */
export function filterConnectorsTools<T extends { name: string }>(
  tools: T[],
  policy = loadMcpToolPolicy(),
): T[] {
  if (!policy.enabled) return tools;
  return tools.filter((t) => !isConnectorsToolBlocked(t.name, policy));
}
