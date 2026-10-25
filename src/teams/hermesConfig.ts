/**
 * Team MCP servers in the Hermes config (design decision 4, task 4.4): one HTTP MCP
 * server `joshu_team_<slug>` for each team of this box, served by the connectors MCP
 * process at `/team/<slug>/mcp`. Servers of teams that the box left are removed.
 */
import fs from "node:fs";
import path from "node:path";

import { teamsDir } from "./membership.js";
import { teamMcpServerName } from "./service.js";

const TEAM_SERVER_PREFIX = "joshu_team_";

/** Local team slugs from memberships.json (sync: the Hermes config sync is not in a request). */
export function teamSlugsSync(projectRoot: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(teamsDir(projectRoot), "memberships.json"), "utf8")) as {
      teams?: Array<{ slug?: unknown }>;
    };
    return (raw.teams ?? []).map((t) => String(t.slug ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** Set `mcpServers` to exactly one team MCP server for each slug. Returns true when it changed. */
export function syncTeamMcpServers(mcpServers: Record<string, unknown>, slugs: string[], connectorsMcpUrl: string): boolean {
  const base = connectorsMcpUrl.replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
  const wanted = new Map(
    slugs.map((slug) => [teamMcpServerName(slug), { url: `${base}/team/${slug}/mcp`, connect_timeout: 60, enabled: true }]),
  );
  let changed = false;
  for (const name of Object.keys(mcpServers)) {
    if (name.startsWith(TEAM_SERVER_PREFIX) && !wanted.has(name)) {
      delete mcpServers[name];
      changed = true;
    }
  }
  for (const [name, desired] of wanted) {
    if (JSON.stringify(mcpServers[name]) !== JSON.stringify(desired)) {
      mcpServers[name] = desired;
      changed = true;
    }
  }
  return changed;
}
