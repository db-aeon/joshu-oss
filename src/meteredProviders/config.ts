/**
 * Metered provider config: the fleet relay of the control plane, or a key of the owner (self-hosted box).
 * Each provider is one definition in METERED_PROVIDER_DEFINITIONS; the functions below take a definition.
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
  /** Key that the owner of a self-hosted box saves in Connectors, for example FAL_KEY. */
  ossEnvKey: string;
  /** One sentence for the owner of a self-hosted box: where to get the key. */
  ossKeyHint: string;
  /** Other process env names of the key on a self-hosted box. */
  ossEnvKeyAliases: string[];
  /** MCP URL of the provider for a self-hosted box. Hermes sends `Authorization: Bearer <key>`. */
  ossMcpUrl: string;
  localMcpPort: number;
  /** Env name that overrides the base URL of the local metered MCP relay. */
  localMcpEnvUrl: string;
  /** Instance env names that the control plane writes for the fleet relay. */
  modeEnv: string;
  relayUrlEnv: string;
  usageSummaryUrlEnv: string;
  /** Owner switch in `.joshu/connectors-providers.env`. */
  userEnabledKey: string;
  hermesServerName: string;
  hermesToolset: string;
};

/**
 * MCP servers and toolsets of metered providers that a release removed. The gateway sync deletes
 * them, because the local port of a removed provider can now serve another provider. Change
 * content-router replaced provider `treg` with provider `router` on port 8798.
 */
export const RETIRED_METERED_PROVIDERS: ReadonlyArray<{ hermesServerName: string; hermesToolset: string }> = [
  { hermesServerName: "treg", hermesToolset: "mcp-treg" },
];

export const METERED_PROVIDER_DEFINITIONS: MeteredProviderDefinition[] = [
  {
    id: "fal",
    displayName: "fal.ai",
    description: "Generate images, video, audio, and 3D via fal MCP tools.",
    ossEnvKey: "FAL_KEY",
    ossKeyHint: "Create a key in your fal.ai dashboard.",
    ossEnvKeyAliases: ["FAL_API_KEY"],
    ossMcpUrl: "https://mcp.fal.ai/mcp",
    localMcpPort: 8797,
    localMcpEnvUrl: "JOSHU_FAL_MCP_HTTP_URL",
    modeEnv: "JOSHU_FAL_MODE",
    relayUrlEnv: "JOSHU_FAL_RELAY_URL",
    usageSummaryUrlEnv: "JOSHU_FAL_USAGE_SUMMARY_URL",
    userEnabledKey: "FAL_MCP_USER_ENABLED",
    hermesServerName: "fal_ai",
    hermesToolset: "mcp-fal",
  },
  {
    id: "router",
    displayName: "Content router",
    description:
      "Read social posts, transcripts, comments, prediction markets, and other data, and make images and videos, through the Joshu content router.",
    ossEnvKey: "JOSHU_ROUTER_API_KEY",
    ossKeyHint:
      "Create a router API key in your account on hello.joshu.me. Each call takes the provider price plus the router markup from your usage wallet.",
    ossEnvKeyAliases: [],
    ossMcpUrl: "https://hello.joshu.me/api/router/mcp",
    localMcpPort: 8798,
    localMcpEnvUrl: "JOSHU_ROUTER_MCP_HTTP_URL",
    modeEnv: "JOSHU_ROUTER_MODE",
    relayUrlEnv: "JOSHU_ROUTER_RELAY_URL",
    usageSummaryUrlEnv: "JOSHU_ROUTER_USAGE_SUMMARY_URL",
    userEnabledKey: "ROUTER_MCP_USER_ENABLED",
    hermesServerName: "joshu_router",
    hermesToolset: "mcp-joshu-router",
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

/** Provision env first (the instance agent updates it at runtime), then the process env. */
function provisionOrProcess(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return provisionEnvTrim(name) || env[name]?.trim() || "";
}

/**
 * A fleet box: the control plane provisioned it, so it has the control plane URL and its agent
 * token. A fleet box reaches every metered provider through the relay of the control plane with no
 * setting of its own.
 */
export function isFleetBox(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(provisionOrProcess("CONTROL_PLANE_URL", env) && provisionOrProcess("INSTANCE_AGENT_TOKEN", env));
}

/**
 * Mode of a metered provider. `JOSHU_<ID>_MODE` (relay, direct, off) wins when it is set. Else a
 * fleet box uses the relay, and a self-hosted box uses its own key (direct).
 */
export function resolveMeteredProviderMode(def: MeteredProviderDefinition): MeteredProviderMode {
  for (const raw of [provisionEnvTrim(def.modeEnv), envTrim(def.modeEnv)]) {
    const mode = (raw || "").toLowerCase();
    if (mode === "relay" || mode === "direct" || mode === "off") return mode;
  }
  return isFleetBox() ? "relay" : "direct";
}

export function resolveMeteredProviderUserEnabled(
  def: MeteredProviderDefinition,
  projectRoot = process.cwd(),
): boolean {
  const mode = resolveMeteredProviderMode(def);
  if (mode === "off") return false;
  const raw = readMeteredProviderConfig(projectRoot)[def.userEnabledKey]?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false;
  if (raw === "true" || raw === "1" || raw === "on" || raw === "yes") return true;
  // Fleet relay: enabled by default; OSS direct follows key presence.
  if (mode === "relay") return true;
  return Boolean(resolveMeteredProviderApiKey(def, projectRoot));
}

export function setMeteredProviderUserEnabled(
  def: MeteredProviderDefinition,
  enabled: boolean,
  projectRoot = process.cwd(),
): void {
  writeMeteredProviderConfig({ [def.userEnabledKey]: enabled ? "true" : "false" }, projectRoot);
}

export function meteredProviderRelayConfigured(def: MeteredProviderDefinition): boolean {
  if (resolveMeteredProviderMode(def) !== "relay") return false;
  // The relay URL comes from JOSHU_<ID>_RELAY_URL, else from the control plane URL.
  return Boolean(provisionOrProcess(def.relayUrlEnv) || provisionOrProcess("CONTROL_PLANE_URL"));
}

/** True when at least one metered provider uses the fleet relay of the control plane. */
export function anyMeteredProviderRelayConfigured(): boolean {
  return METERED_PROVIDER_DEFINITIONS.some(meteredProviderRelayConfigured);
}

export function resolveMeteredProviderApiKey(
  def: MeteredProviderDefinition,
  projectRoot = process.cwd(),
): string {
  const mode = resolveMeteredProviderMode(def);
  // Fleet relay: never read the provider key from provision env or local overrides.
  if (mode === "relay" || mode === "off") return "";

  // OSS direct: user-pasted key in Connectors config, then local process env only.
  const fromFile = readMeteredProviderConfig(projectRoot)[def.ossEnvKey]?.trim();
  if (fromFile) return fromFile;
  for (const name of [def.ossEnvKey, ...def.ossEnvKeyAliases]) {
    const value = envTrim(name);
    if (value) return value;
  }
  return "";
}

/** Base URL of the local metered MCP relay of one provider, for example http://127.0.0.1:8797. */
export function resolveMeteredProviderLocalBaseUrl(def: MeteredProviderDefinition): string {
  return envTrim(def.localMcpEnvUrl, `http://127.0.0.1:${def.localMcpPort}`).replace(/\/+$/, "");
}

export function resolveMeteredProviderMcpHttpUrl(def: MeteredProviderDefinition): string {
  return `${resolveMeteredProviderLocalBaseUrl(def)}/mcp`;
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
  const def = getMeteredProviderDefinition(providerId);
  const explicit = def ? provisionOrProcess(def.relayUrlEnv, env) : "";
  if (explicit) return explicit.replace(/\/+$/, "");
  const cp = provisionOrProcess("CONTROL_PLANE_URL", env);
  if (!cp) throw new Error("CONTROL_PLANE_URL is not set (metered provider relay mode)");
  return `${cp.replace(/\/+$/, "")}/api/instances/providers/${providerId}/mcp`;
}

/** One usage summary serves each provider: the first usage summary URL that is set wins. */
export function usageSummaryUrl(env: NodeJS.ProcessEnv = process.env): string {
  for (const def of METERED_PROVIDER_DEFINITIONS) {
    const explicit = provisionOrProcess(def.usageSummaryUrlEnv, env);
    if (explicit) return explicit.replace(/\/+$/, "");
  }
  const cp = provisionOrProcess("CONTROL_PLANE_URL", env);
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
  if (!anyMeteredProviderRelayConfigured()) return null;
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

export function meteredProviderMcpEnabled(
  def: MeteredProviderDefinition,
  projectRoot = process.cwd(),
): boolean {
  const mode = resolveMeteredProviderMode(def);
  if (mode === "off") return false;
  if (!resolveMeteredProviderUserEnabled(def, projectRoot)) return false;
  if (mode === "relay") {
    if (!meteredProviderRelayConfigured(def)) return false;
    const cached = cachedUsageSummary.value;
    if (cached) return cached.balanceUsd > 0;
    // Before first poll, assume disabled until balance confirmed.
    return false;
  }
  return Boolean(resolveMeteredProviderApiKey(def, projectRoot));
}

/** Clear the cached usage summary. Tests use this. */
export function clearUsageSummaryCache(): void {
  cachedUsageSummary = { at: 0, value: null };
}

export function controlPlaneUsageDashboardUrl(): string {
  const cp = provisionEnvTrim("CONTROL_PLANE_URL") || process.env.CONTROL_PLANE_URL?.trim() || "";
  if (!cp) return "https://hello.joshu.me/joshu#usage-billing";
  return `${cp.replace(/\/+$/, "")}/joshu#usage-billing`;
}
