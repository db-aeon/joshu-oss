/**
 * Health probes for Joshu-supervised MCP HTTP servers (gbrain, connectors, composio guard).
 * Hermes registers MCP tools once at gateway boot — these must be up first.
 */

import { isActionGuardEnabled } from "./actionGuard/index.js";

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function healthUrlFromBase(baseEnv: string, defaultBase: string): string {
  const base = envTrim(baseEnv, defaultBase).replace(/\/+$/, "");
  return `${base}/health`;
}

export function resolveGbrainMcpHealthUrl(): string {
  return healthUrlFromBase("GBRAIN_MCP_HTTP_URL", "http://127.0.0.1:8794");
}

export function resolveConnectorsMcpHealthUrl(): string {
  return healthUrlFromBase("JOSHU_CONNECTORS_MCP_HTTP_URL", "http://127.0.0.1:8795");
}

export function resolveComposioMcpGuardHealthUrl(): string {
  const base = envTrim("JOSHU_COMPOSIO_MCP_GUARD_URL", "http://127.0.0.1:8796").replace(/\/+$/, "");
  return `${base}/health`;
}

export function isComposioMcpGuardRequired(): boolean {
  return isActionGuardEnabled() || Boolean(envTrim("COMPOSIO_API_KEY"));
}

export function isConnectorsMcpRequiredForHealth(): boolean {
  return envTrim("JOSHU_CONNECTORS_MCP_OPTIONAL") !== "true";
}

type McpHealthBody = {
  ok?: boolean;
  ready?: boolean;
  joshu?: { ok?: boolean };
};

/** True when the MCP HTTP server is ready to serve tools (not just process-alive). */
export async function probeMcpHttpHealth(
  healthUrl: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const json = (await res.json()) as McpHealthBody;
    if (json.ok === false) return false;
    if (json.ready === false) return false;
    if (json.joshu?.ok === false) return false;
    return true;
  } catch {
    return false;
  }
}

export async function waitForMcpHttpHealth(
  healthUrl: string,
  opts: { attempts?: number; intervalMs?: number; label?: string } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 60;
  const intervalMs = opts.intervalMs ?? 1_000;
  const label = opts.label ?? healthUrl;

  for (let n = 0; n < attempts; n++) {
    if (await probeMcpHttpHealth(healthUrl)) {
      if (n > 0) {
        console.log(`[mcp-health] ${label} healthy after ${n + 1} attempt(s)`);
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.warn(`[mcp-health] ${label} not healthy after ${attempts} attempt(s)`);
  return false;
}

export type McpDependencyProbe = { label: string; healthUrl: string; required: boolean };

export function listJoshuMcpDependencies(): McpDependencyProbe[] {
  const deps: McpDependencyProbe[] = [
    { label: "gbrain MCP", healthUrl: resolveGbrainMcpHealthUrl(), required: true },
    { label: "connectors MCP", healthUrl: resolveConnectorsMcpHealthUrl(), required: true },
  ];
  if (isComposioMcpGuardRequired()) {
    deps.push({
      label: "composio MCP guard",
      healthUrl: resolveComposioMcpGuardHealthUrl(),
      required: true,
    });
  }
  return deps;
}

/** Block until required MCP HTTP servers respond healthy (or timeout). */
export async function waitForJoshuMcpDependencies(
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<{ allReady: boolean }> {
  const attempts = opts.attempts ?? 60;
  const intervalMs = opts.intervalMs ?? 1_000;
  let allReady = true;
  for (const dep of listJoshuMcpDependencies()) {
    const ok = await waitForMcpHttpHealth(dep.healthUrl, {
      attempts: dep.required ? attempts : Math.min(attempts, 15),
      intervalMs,
      label: dep.label,
    });
    if (!ok && dep.required) allReady = false;
  }
  return { allReady };
}
