/**
 * Hermes toolset ordering — prefer local mail recall (gbrain, connectors) before Composio.
 * Composio stays enabled when OAuth is connected; skills guide the model's first hop.
 *
 * Hard MCP write blocks (Gmail send, deletes, Nylas calendar writes): see `mcpToolPolicy.ts`.
 */

export {
  loadMcpToolPolicy,
  isMcpToolPolicyEnabled,
  isComposioToolBlocked,
  isConnectorsToolBlocked,
  composioToolBlockReason,
  connectorsToolBlockReason,
  filterComposioTools,
  filterConnectorsTools,
} from "./mcpToolPolicy.js";

/** Toolsets listed earlier are preferred in Hermes config (model still sees all enabled toolsets). */
export const JOSHU_HERMES_TOOLSET_ORDER = [
  "mcp-gbrain",
  "mcp-joshu-connectors",
  "kanban",
  "hermes-cli",
  "browser",
  "mcp-composio",
] as const;

/** Sort enabled toolsets so gbrain + connectors precede Composio. */
export function reorderHermesToolsets(toolsets: string[]): string[] {
  const out: string[] = [];
  for (const name of JOSHU_HERMES_TOOLSET_ORDER) {
    if (toolsets.includes(name)) out.push(name);
  }
  for (const name of toolsets) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** After Composio OAuth, ensure mcp-composio is present but last in the ordered list. */
export function toolsetsWithComposio(toolsets: string[], composioSessionActive: boolean): string[] {
  let next = [...toolsets];
  if (composioSessionActive && !next.includes("mcp-composio")) {
    next.push("mcp-composio");
  }
  if (!composioSessionActive) {
    next = next.filter((t) => t !== "mcp-composio");
  }
  return reorderHermesToolsets(next);
}
