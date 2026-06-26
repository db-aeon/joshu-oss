/**
 * Supervise Joshu MCP HTTP servers (gbrain, connectors, composio guard).
 * Restarts unhealthy processes and nudges Hermes gateway when connectors recover.
 */

import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { listJoshuMcpDependencies, probeMcpHttpHealth } from "./mcpDependencyHealth.js";

const execFile = promisify(execFileCb);

const START_SCRIPTS: Record<string, string> = {
  "gbrain MCP": "start-gbrain-mcp-http.sh",
  "connectors MCP": "start-joshu-connectors-mcp.sh",
  "composio MCP guard": "start-composio-mcp-guard.sh",
};

export type McpSupervisorOptions = {
  projectRoot: string;
  intervalMs?: number;
  minRestartIntervalMs?: number;
  onServiceRecovered?: (label: string) => void;
};

export function isJoshuMcpSupervisorEnabled(): boolean {
  const raw = process.env.JOSHU_MCP_SUPERVISOR?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return true;
}

/** Start periodic MCP health probes + restart scripts. Returns stop function. */
export function startJoshuMcpSupervisor(opts: McpSupervisorOptions): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  const minRestartMs = opts.minRestartIntervalMs ?? 60_000;
  const lastHealthy = new Map<string, boolean>();
  const lastRestartAt = new Map<string, number>();
  let tickInFlight = false;

  const tick = async (): Promise<void> => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      for (const dep of listJoshuMcpDependencies()) {
        if (!dep.required) continue;

        const ok = await probeMcpHttpHealth(dep.healthUrl);
        const wasOk = lastHealthy.get(dep.label) ?? true;

        if (!ok) {
          const script = START_SCRIPTS[dep.label];
          const now = Date.now();
          const lastRestart = lastRestartAt.get(dep.label) ?? 0;
          if (script && now - lastRestart >= minRestartMs) {
            console.warn(`[mcp-supervisor] ${dep.label} unhealthy — restarting (${dep.healthUrl})`);
            lastRestartAt.set(dep.label, now);
            try {
              await execFile("bash", [path.join(opts.projectRoot, "scripts", script)], {
                cwd: opts.projectRoot,
                timeout: 120_000,
                env: { ...process.env, APP_DIR: opts.projectRoot },
              });
            } catch (err) {
              console.warn(`[mcp-supervisor] ${dep.label} restart failed: ${(err as Error).message}`);
            }
          }
          lastHealthy.set(dep.label, false);
          continue;
        }

        if (!wasOk) {
          console.log(`[mcp-supervisor] ${dep.label} recovered (${dep.healthUrl})`);
          opts.onServiceRecovered?.(dep.label);
        }
        lastHealthy.set(dep.label, true);
      }
    } finally {
      tickInFlight = false;
    }
  };

  console.log(`[mcp-supervisor] watching MCP HTTP dependencies every ${intervalMs / 1000}s`);
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
