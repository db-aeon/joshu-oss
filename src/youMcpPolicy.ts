/**
 * Optional You.com web-search MCP provider (Hermes `mcp_servers.you`).
 *
 * Opt-in via `JOSHU_YOU_MCP_ENABLED` (default off). Keyless by default —
 * `https://api.you.com/mcp?profile=free` exposes basic `you-search` without a
 * key; setting `YDC_API_KEY` upgrades to the authenticated endpoint.
 * Mirrors the fal.ai optional-provider pattern in `meteredProviders/config.ts`.
 */

const KEYLESS_MCP_URL = "https://api.you.com/mcp?profile=free";
const AUTHENTICATED_MCP_URL = "https://api.you.com/mcp";

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function envBool(name: string, fallback = false): boolean {
  const raw = envTrim(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

/** True only when the owner explicitly opted in (default off). */
export function youMcpEnabled(): boolean {
  return envBool("JOSHU_YOU_MCP_ENABLED", false);
}

/** Optional API key (https://you.com/platform/api-keys); empty = keyless profile. */
export function youApiKey(): string {
  return envTrim("YDC_API_KEY");
}

/** `YDC_API_KEY` present → authenticated endpoint; else keyless free profile. */
export function resolveYouMcpUrl(): string {
  const explicit = envTrim("JOSHU_YOU_MCP_URL");
  if (explicit) return explicit;
  return youApiKey() ? AUTHENTICATED_MCP_URL : KEYLESS_MCP_URL;
}

/** Bearer headers for the authenticated endpoint; empty for keyless. */
export function youMcpHeaders(): Record<string, string> {
  const key = youApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Desired `mcp_servers.you` entry; null when the provider is disabled. */
export function desiredYouMcpServer(): {
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
} | null {
  if (!youMcpEnabled()) return null;
  return {
    url: resolveYouMcpUrl(),
    headers: youMcpHeaders(),
    enabled: true,
  };
}

/** Add/remove the `mcp-you` toolset entry (Hermes alias for MCP server `you`). */
export function toolsetsWithYou(toolsets: string[], youActive: boolean): string[] {
  const next = [...toolsets];
  const idx = next.indexOf("mcp-you");
  if (youActive && idx < 0) next.push("mcp-you");
  if (!youActive && idx >= 0) next.splice(idx, 1);
  return next;
}
