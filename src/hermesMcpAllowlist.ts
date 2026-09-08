/**
 * Strip untrusted Hermes MCP servers from config.yaml.
 *
 * Joshu upserts HTTP MCPs it owns (gbrain, joshu_connectors, composio, fal_ai, aeon).
 * Owners may add extra **HTTP** MCPs (e.g. known_quantity). Stdio servers
 * (`command` / `args`) are an RCE vector — a public Hermes Admin UI or
 * `hermes mcp add --command python3 --args -c …` can persist a miner dropper
 * that Joshu previously left in place across gateway sync.
 */

export const JOSHU_MANAGED_MCP_SERVER_NAMES = [
  "gbrain",
  "joshu_connectors",
  "composio",
  "fal_ai",
  "aeon",
] as const;

export type ConfigRecord = Record<string, unknown>;

function asRecord(value: unknown): ConfigRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigRecord) : {};
}

/** True when the MCP entry launches a local process (stdio), not HTTP. */
export function isStdioMcpServer(server: unknown): boolean {
  const rec = asRecord(server);
  const command = typeof rec.command === "string" && rec.command.trim().length > 0;
  const args = Array.isArray(rec.args) && rec.args.length > 0;
  return command || args;
}

function extraHttpUrl(server: unknown): string | null {
  const rec = asRecord(server);
  const url = typeof rec.url === "string" ? rec.url.trim() : "";
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function isJoshuManagedMcpServerName(name: string): boolean {
  return (JOSHU_MANAGED_MCP_SERVER_NAMES as readonly string[]).includes(name);
}

/**
 * Keep Joshu-managed entries and extra HTTP MCPs; drop stdio / command-less junk.
 * Does not rewrite managed server bodies — callers upsert those separately.
 */
export function sanitizeHermesMcpServers(mcpServers: unknown): {
  servers: ConfigRecord;
  stripped: string[];
} {
  const input = asRecord(mcpServers);
  const servers: ConfigRecord = {};
  const stripped: string[] = [];

  for (const [name, value] of Object.entries(input)) {
    if (isJoshuManagedMcpServerName(name)) {
      servers[name] = value;
      continue;
    }
    if (isStdioMcpServer(value) || !extraHttpUrl(value)) {
      stripped.push(name);
      continue;
    }
    servers[name] = value;
  }

  return { servers, stripped };
}
