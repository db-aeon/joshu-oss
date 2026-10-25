/**
 * Metered provider config (fal.ai first) — OSS direct keys vs fleet CP relay.
 */
import fs from "node:fs";
import path from "node:path";
import { joshuStateDir } from "../joshuStateDir.js";
import { provisionEnvTrim } from "../provisionInstanceEnv.js";

export type MeteredProviderMode = "relay" | "direct" | "off";

export type MeteredProviderDefinition = {
  id: string;
  displayName: string;
  description: string;
  ossEnvKey: string;
  ossMcpUrl: string;
  localMcpPort: number;
  localMcpEnvUrl: string;
};

export const METERED_PROVIDER_DEFINITIONS: MeteredProviderDefinition[] = [
  {
    id: "fal",
    displayName: "fal.ai",
    description: "Generate images, video, audio, and 3D via fal MCP tools.",
    ossEnvKey: "FAL_KEY",
    ossMcpUrl: "https://mcp.fal.ai/mcp",
    localMcpPort: 8797,
    localMcpEnvUrl: "JOSHU_FAL_MCP_HTTP_URL",
  },
];

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function providersConfigPath(projectRoot = process.cwd()): string {
  return path.join(joshuStateDir(projectRoot), "connectors-providers.env");
}

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function serializeDotEnv(entries: Record<string, string>): string {
  const lines = ["# Managed by Joshu Connectors — metered provider keys (OSS self-host).", ""];
  for (const [key, value] of Object.entries(entries)) {
    if (!value) continue;
    const safe = value.replace(/\n/g, "\\n");
    if (/[\s#"']/.test(safe)) lines.push(`${key}="${safe.replace(/"/g, '\\"')}"`);
    else lines.push(`${key}=${safe}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function readMeteredProviderConfig(projectRoot = process.cwd()): Record<string, string> {
  const file = providersConfigPath(projectRoot);
  if (!fs.existsSync(file)) return {};
  try {
    return parseDotEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function writeMeteredProviderConfig(
  updates: Record<string, string | null>,
  projectRoot = process.cwd(),
): Record<string, string> {
  const file = providersConfigPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readMeteredProviderConfig(projectRoot);
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === "") delete current[key];
    else current[key] = value;
  }
  fs.writeFileSync(file, serializeDotEnv(current), "utf8");
  return current;
}

export function getMeteredProviderDefinition(id: string): MeteredProviderDefinition | null {
  return METERED_PROVIDER_DEFINITIONS.find((p) => p.id === id.trim().toLowerCase()) ?? null;
}

export function resolveFalMode(): MeteredProviderMode {
  const fromProvision = (provisionEnvTrim("JOSHU_FAL_MODE") || "").toLowerCase();
  if (fromProvision === "relay" || fromProvision === "direct" || fromProvision === "off") {
    return fromProvision;
  }
  const fromProcess = envTrim("JOSHU_FAL_MODE").toLowerCase();
  if (fromProcess === "relay" || fromProcess === "direct" || fromProcess === "off") {
    return fromProcess;
  }
  return "direct";
}

export function resolveFalUserEnabled(projectRoot = process.cwd()): boolean {
  const mode = resolveFalMode();
  if (mode === "off") return false;
  const raw = readMeteredProviderConfig(projectRoot).FAL_MCP_USER_ENABLED?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false;
  if (raw === "true" || raw === "1" || raw === "on" || raw === "yes") return true;
  // Fleet relay: enabled by default; OSS direct follows key presence.
  if (mode === "relay") return true;
  return Boolean(resolveFalApiKey(projectRoot));
}

export function setFalUserEnabled(enabled: boolean, projectRoot = process.cwd()): void {
  writeMeteredProviderConfig(
    { FAL_MCP_USER_ENABLED: enabled ? "true" : "false" },
    projectRoot,
  );
}

export function falRelayConfigured(): boolean {
  if (resolveFalMode() !== "relay") return false;
  return Boolean(
    provisionEnvTrim("JOSHU_FAL_RELAY_URL") || envTrim("JOSHU_FAL_RELAY_URL"),
  );
}

export function resolveFalApiKey(projectRoot = process.cwd()): string {
  const mode = resolveFalMode();
  // Fleet relay: never read FAL_KEY from provision env or local overrides.
  if (mode === "relay" || mode === "off") return "";

  // OSS direct: user-pasted key in Connectors config, then local process env only.
  const fromFile = readMeteredProviderConfig(projectRoot).FAL_KEY?.trim();
  if (fromFile) return fromFile;
  return envTrim("FAL_KEY") || envTrim("FAL_API_KEY");
}

export function resolveFalMcpHttpUrl(): string {
  const base = envTrim("JOSHU_FAL_MCP_HTTP_URL", "http://127.0.0.1:8797").replace(/\/+$/, "");
  return `${base}/mcp`;
}

export function instanceAgentBearerToken(env: NodeJS.ProcessEnv = process.env): string {
  const instanceId =
    provisionEnvTrim("JOSHU_INSTANCE_ID") || env.JOSHU_INSTANCE_ID?.trim() || "";
  const raw =
    provisionEnvTrim("INSTANCE_AGENT_TOKEN") || env.INSTANCE_AGENT_TOKEN?.trim() || "";
  if (!instanceId || !raw) {
    throw new Error("JOSHU_INSTANCE_ID / INSTANCE_AGENT_TOKEN required for metered provider relay");
  }
  if (raw.startsWith(`${instanceId}.`)) return raw;
  return `${instanceId}.${raw}`;
}

export function meteredProviderRelayUrl(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (providerId === "fal") {
    const explicit =
      provisionEnvTrim("JOSHU_FAL_RELAY_URL") || env.JOSHU_FAL_RELAY_URL?.trim() || "";
    if (explicit) return explicit.replace(/\/+$/, "");
  }
  const cp = provisionEnvTrim("CONTROL_PLANE_URL") || env.CONTROL_PLANE_URL?.trim() || "";
  if (!cp) throw new Error("CONTROL_PLANE_URL is not set (metered provider relay mode)");
  return `${cp.replace(/\/+$/, "")}/api/instances/providers/${providerId}/mcp`;
}

export function usageSummaryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit =
    provisionEnvTrim("JOSHU_FAL_USAGE_SUMMARY_URL") ||
    env.JOSHU_FAL_USAGE_SUMMARY_URL?.trim() ||
    "";
  if (explicit) return explicit.replace(/\/+$/, "");
  const cp = provisionEnvTrim("CONTROL_PLANE_URL") || env.CONTROL_PLANE_URL?.trim() || "";
  if (!cp) throw new Error("CONTROL_PLANE_URL is not set");
  return `${cp.replace(/\/+$/, "")}/api/instances/usage/summary`;
}

export type UsageSummarySnapshot = {
  balanceUsd: number;
  balanceUsdDisplay: string;
  providers: Array<{ id: string; displayName: string; enabled: boolean }>;
};

let cachedUsageSummary: { at: number; value: UsageSummarySnapshot | null } = {
  at: 0,
  value: null,
};

/** Cached CP usage summary for Hermes enable/disable + Connectors cards. */
export async function fetchUsageSummaryFromCp(
  opts: { ttlMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<UsageSummarySnapshot | null> {
  if (!falRelayConfigured()) return null;
  const ttlMs = opts.ttlMs ?? 15_000;
  const now = Date.now();
  if (cachedUsageSummary.value && now - cachedUsageSummary.at < ttlMs) {
    return cachedUsageSummary.value;
  }
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(usageSummaryUrl(), {
      headers: {
        Authorization: `Bearer ${instanceAgentBearerToken()}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
    });
    if (!res.ok) return cachedUsageSummary.value;
    const json = (await res.json()) as UsageSummarySnapshot;
    cachedUsageSummary = { at: now, value: json };
    return json;
  } catch {
    return cachedUsageSummary.value;
  }
}

export function falMcpEnabled(projectRoot = process.cwd()): boolean {
  const mode = resolveFalMode();
  if (mode === "off") return false;
  if (!resolveFalUserEnabled(projectRoot)) return false;
  if (mode === "relay") {
    if (!falRelayConfigured()) return false;
    const cached = cachedUsageSummary.value;
    if (cached) return cached.balanceUsd > 0;
    // Before first poll, assume disabled until balance confirmed.
    return false;
  }
  return Boolean(resolveFalApiKey(projectRoot));
}

export async function refreshFalMcpEnabled(projectRoot = process.cwd()): Promise<boolean> {
  if (resolveFalMode() === "relay") {
    await fetchUsageSummaryFromCp();
  }
  return falMcpEnabled(projectRoot);
}

export function controlPlaneUsageDashboardUrl(): string {
  const cp = provisionEnvTrim("CONTROL_PLANE_URL") || process.env.CONTROL_PLANE_URL?.trim() || "";
  if (!cp) return "https://hello.joshu.me/joshu#usage-billing";
  return `${cp.replace(/\/+$/, "")}/joshu#usage-billing`;
}
