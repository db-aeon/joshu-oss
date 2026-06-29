import { spawn, type ChildProcessByStdio } from "node:child_process";
import { execFile as execFileCb } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import YAML from "yaml";
import { bootstrapHermesLearning } from "./hermesLearning.js";
import { loadProductSkillsPolicy } from "./hermesSkillsConfig.js";
import { syncHermesContextFile } from "./hermesContextFile.js";
import type { RunEvent, RunRecord, RunStatus } from "./types.js";
import {
  joshuFilesPathEnv,
  resolveJoshuFilesPaths,
  resolveJoshuHermesWorkspaceScope,
} from "./joshuFilesPaths.js";
import {
  migrateHermesUserConfig,
  readManagedHermesConfig,
  writeMergedHermesConfig,
} from "./hermesConfigSplit.js";
import { toolsetsWithComposio } from "./composioHermesMcpPolicy.js";
import { isActionGuardEnabled, loadActionGuardPolicy, resolveComposioMcpGuardProxyUrl } from "./actionGuard/index.js";
import { resolveEnvWithLocalFallback } from "./safetySettings/localEnv.js";
import { buildHermesMessagingDotenvEntries } from "./hermesMessagingEnv.js";
import {
  probeMcpHttpHealth,
  resolveConnectorsMcpHealthUrl,
  waitForJoshuMcpDependencies,
} from "./mcpDependencyHealth.js";
import { buildOwnerTimeSystemMessage } from "./ownerLocalTime.js";

const execFile = promisify(execFileCb);
const HERMES_GATEWAY_PID_FILE = path.join(homedir(), ".hermes", "gateway.pid");
const APPLY_HERMES_HITL_PATCH_SCRIPT = path.resolve(process.cwd(), "scripts/apply-hermes-hitl-patch.sh");
const APPLY_HERMES_CONTENT_FILTER_PATCH_SCRIPT = path.resolve(
  process.cwd(),
  "scripts/apply-hermes-content-filter-patch.sh",
);
const MAX_HISTORY_MESSAGES = 12;
const MAX_OBSERVATION_CHARS = 14_000;
const DEFAULT_JOSHU_HERMES_SKILLS_DIR = path.resolve(process.cwd(), "integrations/hermes/skills");

/** Fleet-only hourly learning GitHub sync — module absent in AGPL-only checkouts. */
async function trySyncHermesLearningGitCron(): Promise<void> {
  try {
    const { syncHermesLearningGitCron } = await import("./hermesLearningGitCron.js");
    const cronOutcome = await syncHermesLearningGitCron();
    if (cronOutcome !== "skipped") {
      console.log(`[hermes-api] Hermes learning GitHub cron ${cronOutcome}`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND") return;
    console.warn(`[hermes-api] Hermes learning GitHub cron install skipped: ${(err as Error).message}`);
  }
}
import {
  JOSHU_OPENROUTER_DEFAULT_MODEL,
  JOSHU_OPENROUTER_SESSION_SEARCH_MODEL,
} from "./joshuOpenRouterDefaults.js";

const DEFAULT_JOSHU_HERMES_MODEL = JOSHU_OPENROUTER_DEFAULT_MODEL;
const DEFAULT_JOSHU_HERMES_PROVIDER = "openrouter";
const DEFAULT_JOSHU_HERMES_TOOLSETS =
  '["mcp-gbrain", "mcp-joshu-connectors", "kanban", "hermes-cli", "browser"]';

export type ComposioMcpEndpoint = {
  url: string;
  headers: Record<string, string>;
  type?: string;
  enabled: boolean;
};

/** Merge Composio tool-router MCP into ~/.hermes/config.yaml (Hermes toolset mcp-composio). */
export async function applyComposioMcpToHermesConfig(endpoint: ComposioMcpEndpoint | null): Promise<boolean> {
  const hermesHome = getHermesHome();
  const configPath = path.join(hermesHome, "config.yaml");
  await mkdir(hermesHome, { recursive: true });

  const { managed, recoveredFromCorrupt } = await readManagedHermesConfig(hermesHome);
  let config: ConfigRecord = managed;
  if (recoveredFromCorrupt) {
    console.warn(
      `[hermes-api] corrupt Hermes config at ${configPath}; applying Composio MCP to rebuilt defaults`,
    );
  }

  let changed = false;
  const mcpServers = asRecord(config.mcp_servers);
  const composioServer = asRecord(mcpServers.composio);

  const sessionUrl = endpoint?.url?.trim() ?? "";
  const composioSessionActive = Boolean(sessionUrl && endpoint?.enabled !== false);

  if (!sessionUrl) {
    if (composioServer.enabled !== false) {
      mcpServers.composio = { ...composioServer, enabled: false };
      changed = true;
    }
  } else {
    const guardActive = isActionGuardEnabled();
    const hermesUrl = guardActive ? resolveComposioMcpGuardProxyUrl() : sessionUrl;
    const connectTimeout = guardActive ? 1800 : 120;
    const desired: ConfigRecord = {
      url: hermesUrl,
      enabled: true,
      connect_timeout: connectTimeout,
      headers: guardActive ? {} : endpoint!.headers,
    };
    if (!guardActive && endpoint!.type) desired.type = endpoint!.type;
    const headersMatch =
      JSON.stringify(asRecord(composioServer.headers)) === JSON.stringify(desired.headers ?? {});
    if (
      composioServer.url !== desired.url ||
      composioServer.enabled !== true ||
      composioServer.connect_timeout !== desired.connect_timeout ||
      !headersMatch ||
      composioServer.type !== desired.type
    ) {
      mcpServers.composio = desired;
      changed = true;
    }
  }
  config.mcp_servers = mcpServers;

  let toolsets = parseToolsets(config.toolsets);
  if (toolsets.length === 0) toolsets = parseToolsets(envString("JOSHU_HERMES_TOOLSETS", DEFAULT_JOSHU_HERMES_TOOLSETS));
  if (toolsets.length === 0) toolsets = ["mcp-gbrain", "mcp-joshu-connectors", "kanban", "hermes-cli", "browser"];

  const orderedToolsets = toolsetsWithComposio(toolsets, composioSessionActive);
  if (JSON.stringify(parseToolsets(config.toolsets)) !== JSON.stringify(orderedToolsets)) {
    config.toolsets = orderedToolsets;
    changed = true;
  }

  if (!changed) return false;

  await writeMergedHermesConfig(hermesHome, config);
  console.log(
    `[hermes-api] ${composioSessionActive ? "enabled" : "disabled"} Composio MCP in ${configPath}`,
  );
  return true;
}

/** Hermes checkout that owns tools/browser_camofox.py (HERMES_DIR or parent of venv/bin/hermes). */
function resolveHermesCheckoutDir(hermesBinary: string): string | undefined {
  const fromEnv = process.env.HERMES_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (!hermesBinary.includes(path.sep)) return undefined;
  return path.resolve(path.dirname(hermesBinary), "..");
}

type ConfigRecord = Record<string, unknown>;

function asRecord(value: unknown): ConfigRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigRecord) : {};
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function getHermesHome(): string {
  return process.env.HERMES_HOME || path.join(homedir(), ".hermes");
}

/** Joshu-supervised gbrain MCP HTTP endpoint (Hermes connects here, not stdio). */
function resolveGbrainMcpHttpUrl(): string {
  const base = envString("GBRAIN_MCP_HTTP_URL", "http://127.0.0.1:8794").replace(/\/+$/, "");
  return `${base}/mcp`;
}

/** Thin connectors MCP (sync + send; mail search is gbrain). */
function resolveJoshuConnectorsMcpHttpUrl(): string {
  const base = envString("JOSHU_CONNECTORS_MCP_HTTP_URL", "http://127.0.0.1:8795").replace(/\/+$/, "");
  return `${base}/mcp`;
}

/** Shell-safe .env value for `source` (spaces, quotes, apostrophes in paths). */
function formatHermesDotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Keep ~/.hermes/.env aligned so Hermes tool workers see the shared HITL Camofox identity. */
export async function syncHermesDotenv(entries: Record<string, string>): Promise<void> {
  const envPath = path.join(getHermesHome(), ".env");
  let lines: string[] = [];
  try {
    lines = (await readFile(envPath, "utf8")).split("\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[hermes-api] could not read ${envPath}: ${(err as Error).message}`);
      return;
    }
  }

  let changed = false;
  for (const [key, value] of Object.entries(entries)) {
    if (!value.trim()) continue;
    const next = `${key}=${formatHermesDotenvValue(value)}`;
    const idx = lines.findIndex((line) => line === next || line.startsWith(`${key}=`));
    if (idx >= 0) {
      if (lines[idx] !== next) {
        lines[idx] = next;
        changed = true;
      }
    } else {
      lines.push(next);
      changed = true;
    }
  }

  if (!changed) return;
  const body = lines.join("\n").replace(/\n*$/, "\n");
  await writeFile(envPath, body, "utf8");
  console.log(`[hermes-api] synced Hermes env in ${envPath}`);
}

/** Push Telegram + Slack messaging vars from Joshu env/local-env into ~/.hermes/.env. */
export async function syncHermesMessagingEnv(projectRoot = process.cwd()): Promise<void> {
  await syncHermesDotenv(buildHermesMessagingDotenvEntries(projectRoot));
}

function getJoshuHermesModel(): string {
  return envString("JOSHU_HERMES_MODEL", DEFAULT_JOSHU_HERMES_MODEL);
}

function getJoshuHermesProvider(): string {
  return envString("JOSHU_HERMES_PROVIDER", DEFAULT_JOSHU_HERMES_PROVIDER);
}

function getConfiguredJoshuPluginNames(): string[] {
  return (process.env.JOSHU_HERMES_PLUGIN_NAMES || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function envString(name: string, fallback = ""): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

/** Langfuse Users view id: explicit env, else box slug from CUSTOMER_DOMAIN (VPS). */
function resolveLangfuseUserId(): string {
  const explicit = envString("HERMES_LANGFUSE_USER_ID");
  if (explicit) return explicit;
  const domain = envString("CUSTOMER_DOMAIN");
  if (!domain) return "";
  const suffix = envString("CUSTOMER_DOMAIN_SUFFIX", "box.joshu.me").replace(/^\.+|\.+$/g, "");
  const hostSuffix = `.${suffix}`;
  if (domain.endsWith(hostSuffix)) {
    return domain.slice(0, -hostSuffix.length);
  }
  const dot = domain.indexOf(".");
  return dot > 0 ? domain.slice(0, dot) : domain;
}

/** Read a secret from process env, then from synced ~/.hermes/.env. */
function resolveHermesHomeSecret(key: string): string {
  const fromEnv = envString(key);
  if (fromEnv) return fromEnv;
  const envPath = path.join(getHermesHome(), ".env");
  try {
    const prefix = `${key}=`;
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      if (line.startsWith(prefix)) {
        const value = line.slice(prefix.length).trim();
        if (value) return value;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[hermes-api] could not read ${envPath} for ${key}: ${(err as Error).message}`);
    }
  }
  return "";
}

/** Joshu may start before compose env_file is visible; fall back to synced ~/.hermes/.env. */
function resolveAnthropicApiKey(): string {
  return resolveHermesHomeSecret("ANTHROPIC_API_KEY");
}

function resolveOpenRouterApiKey(): string {
  return resolveHermesHomeSecret("OPENROUTER_API_KEY");
}

function parseEnvBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function isJoshuHindsightEnabled(): boolean {
  const value = process.env.JOSHU_HINDSIGHT_ENABLED?.trim().toLowerCase();
  if (value && ["1", "true", "yes", "on"].includes(value)) return true;
  if (value && ["0", "false", "no", "off"].includes(value)) return false;

  // In auto mode, enable Hindsight only when the local API has enough LLM
  // configuration to start. This keeps ordinary dev runs from failing.
  return Boolean(
    envString("HINDSIGHT_API_LLM_API_KEY") ||
      envString("HINDSIGHT_API_LLM_PROVIDER") ||
      envString("HINDSIGHT_API_LLM_BASE_URL"),
  );
}

function parseToolsets(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    } catch {
      return [value.trim()];
    }
  }
  return [];
}

function buildHindsightConfig(): ConfigRecord {
  const config: ConfigRecord = {
    mode: "local_external",
    api_url: envString("HINDSIGHT_API_URL", "http://127.0.0.1:8888"),
    bank_id: envString("HINDSIGHT_BANK_ID", "joshu"),
    recall_budget: envString("HINDSIGHT_RECALL_BUDGET", envString("HINDSIGHT_BUDGET", "mid")),
    memory_mode: envString("HINDSIGHT_MEMORY_MODE", "hybrid"),
    auto_recall: parseEnvBoolean("HINDSIGHT_AUTO_RECALL", true),
    auto_retain: parseEnvBoolean("HINDSIGHT_AUTO_RETAIN", true),
    retain_async: parseEnvBoolean("HINDSIGHT_RETAIN_ASYNC", true),
    retain_context: envString("HINDSIGHT_RETAIN_CONTEXT", "conversation between Hermes Agent and the User in Joshu"),
    retain_source: envString("HINDSIGHT_RETAIN_SOURCE", "joshu"),
  };

  const optionalEnv: Array<[string, string]> = [
    ["bank_id_template", "HINDSIGHT_BANK_ID_TEMPLATE"],
    ["bank_mission", "HINDSIGHT_BANK_MISSION"],
    ["bank_retain_mission", "HINDSIGHT_BANK_RETAIN_MISSION"],
    ["retain_tags", "HINDSIGHT_RETAIN_TAGS"],
    ["recall_tags", "HINDSIGHT_RECALL_TAGS"],
    ["recall_tags_match", "HINDSIGHT_RECALL_TAGS_MATCH"],
    ["recall_prefetch_method", "HINDSIGHT_RECALL_PREFETCH_METHOD"],
    ["recall_max_tokens", "HINDSIGHT_RECALL_MAX_TOKENS"],
    ["recall_max_input_chars", "HINDSIGHT_RECALL_MAX_INPUT_CHARS"],
  ];

  for (const [key, envName] of optionalEnv) {
    const value = envString(envName);
    if (value) config[key] = /^\d+$/.test(value) ? Number(value) : value;
  }

  return config;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StartRunParams {
  prompt: string;
  initialUrl?: string;
  currentUrl?: string;
  browserObservation?: string;
  conversationId?: string;
  browserUrlChanged?: boolean;
}

export type HermesChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface HermesChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | HermesChatContentPart[];
  /** Required for role=tool result messages in multi-turn frontend tool loops. */
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface HermesChatToolEvent {
  tool: string;
  emoji?: string;
  label?: string;
  toolCallId?: string;
  status?: "running" | "completed";
  raw?: unknown;
}

export interface StreamHermesChatParams {
  sessionId: string;
  /** Override Hermes session key prefix (default joshu-hermes-chat). */
  sessionKey?: string;
  messages: HermesChatMessage[];
  model?: string;
  signal?: AbortSignal;
  /** CopilotKit frontend tools — passed to the LLM; executed client-side only. */
  clientTools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  /** Names of client-side tools (skip Hermes MCP progress events for these). */
  clientToolNames?: Set<string>;
}

export interface HermesClientToolCallEvent {
  toolCallId: string;
  toolCallName: string;
  /** Incremental JSON args chunk (phase args) or full args (phase end). */
  argumentsDelta?: string;
  phase: "start" | "args" | "end";
}

export interface StreamHermesChatCallbacks {
  onSession?: (sessionId: string) => void;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onTool?: (event: HermesChatToolEvent) => void;
  /** OpenAI stream tool_calls for CopilotKit frontend tools (not executed server-side). */
  onClientToolCall?: (event: HermesClientToolCallEvent) => void;
}

export type BrowserSyncMessageLevel = "light" | "full";

/** Inject before Hermes Chat turns so the model sees the live noVNC page, not stale tool history. */
export function buildBrowserSyncSystemMessage(params: {
  level: BrowserSyncMessageLevel;
  currentUrl?: string;
  title?: string;
  browserObservation?: string;
  priorUrl?: string;
}): HermesChatMessage {
  const currentPage = params.currentUrl || "unknown";
  const title = params.title?.trim();

  if (params.level === "light") {
    const lines = [
      "Shared Camofox tab (human may have changed it in noVNC since your last turn):",
      title ? `${currentPage} — ${title}` : currentPage,
      "Browser tool output in chat history may be stale. Call browser snapshot/observe before acting on page content.",
    ];
    if (params.priorUrl && params.priorUrl !== currentPage) {
      lines.push(`URL changed since last Joshu sync (was ${params.priorUrl}).`);
    }
    return { role: "system", content: lines.join("\n") };
  }

  const lines = [
    "IMPORTANT: The human may have changed the shared Camofox browser through noVNC since your previous turn.",
    "Treat the live browser observation below as authoritative. Older browser tool outputs in chat history may be stale.",
    "Before browser actions, snapshot/observe the shared tab again — do not rely on prior-turn browser tool output.",
    title ? `Current shared Camofox tab: ${currentPage} — ${title}` : `Current shared Camofox tab URL: ${currentPage}`,
  ];
  if (params.priorUrl && params.priorUrl !== currentPage) {
    lines.push(`Note: URL changed since the last Joshu sync (was ${params.priorUrl}).`);
  }
  const observation = params.browserObservation?.trim();
  if (observation) {
    lines.push(
      "",
      "Live browser observation captured immediately before this message:",
      "```",
      observation.slice(0, MAX_OBSERVATION_CHARS),
      observation.length > MAX_OBSERVATION_CHARS ? "\n[Snapshot truncated by HITL host]" : "",
      "```",
    );
  } else {
    lines.push("", "No live snapshot was captured. Call browser snapshot on the shared tab before relying on page content.");
  }
  return { role: "system", content: lines.join("\n") };
}

/** System messages injected before each Joshu-hosted Hermes chat turn (owner clock + optional browser). */
export function buildTurnSystemMessages(
  projectRoot: string,
  options?: { browser?: HermesChatMessage | null; now?: Date },
): HermesChatMessage[] {
  const messages: HermesChatMessage[] = [buildOwnerTimeSystemMessage(projectRoot, options?.now)];
  if (options?.browser) messages.push(options.browser);
  return messages;
}

function composePrompt(params: StartRunParams): string {
  const currentPage = params.currentUrl || params.initialUrl || "unknown";
  const observation = params.browserObservation?.trim();
  const lines = [
    "IMPORTANT: The human may have changed the browser through VNC since your previous turn.",
    "Treat the live browser observation below as authoritative. Older browser snapshots or tool outputs in chat history may be stale.",
    "If you need to verify page content, call a browser snapshot/observe tool on the shared tab before answering — do not rely on prior-turn browser tool output.",
    `Current shared Camofox tab URL reported by the host: ${currentPage}`,
    "",
  ];

  if (params.browserUrlChanged) {
    lines.push(
      "The browser URL changed since the last Joshu prompt. Prior browser tool results in conversation history are for an older page.",
      "",
    );
  }

  if (observation) {
    lines.push(
      "Authoritative live browser observation captured immediately before this prompt:",
      "```",
      observation.slice(0, MAX_OBSERVATION_CHARS),
      observation.length > MAX_OBSERVATION_CHARS ? "\n[Snapshot truncated by HITL host]" : "",
      "```",
      "",
    );
  } else {
    lines.push("No host snapshot was available. Inspect the current shared Camofox tab before relying on browser state.", "");
  }

  lines.push("User request:", params.prompt);
  return lines.join("\n");
}

export class HermesApiRunner extends EventEmitter {
  private readonly runs = new Map<string, RunRecord>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly histories = new Map<string, ChatMessage[]>();
  private gateway?: ChildProcessByStdio<null, Readable, Readable>;
  private lastSessionId?: string;
  private lastBrowserUrl?: string;
  private lastCamofoxUserId?: string;
  private hitlBrowserPatchEnsured = false;
  private learningBootstrapPromise?: Promise<void>;
  private workspaceScopeLogged = false;
  private syncedLangfuseUserId = "";
  private mcpGatewayWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastConnectorsMcpHealthy = true;
  private gatewayMcpReloadPending = false;
  private mcpGatewayReloadInFlight = false;
  private gatewayAutoStart: boolean;

  constructor(
    private readonly opts: {
      binary: string;
      camofoxUrl: string;
      apiBaseUrl: string;
      apiKey: string;
      autoStartGateway: boolean;
      hitlCamofoxUserId: string;
      hitlCamofoxSessionKey: string;
    },
  ) {
    super();
    this.gatewayAutoStart = opts.autoStartGateway;
  }

  isAutoStartGateway(): boolean {
    return this.gatewayAutoStart;
  }

  getRun(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  listRuns(): RunRecord[] {
    return Array.from(this.runs.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  getActiveSessionId(): string | undefined {
    return this.lastSessionId;
  }

  getLastBrowserUrl(): string | undefined {
    return this.lastBrowserUrl;
  }

  getLastCamofoxUserId(): string | undefined {
    return this.lastCamofoxUserId;
  }

  rememberBrowserTarget(url: string, camofoxUserId?: string): void {
    this.lastBrowserUrl = url;
    this.lastCamofoxUserId = camofoxUserId || this.lastCamofoxUserId;
  }

  async probe(): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const { stdout } = await execFile(this.opts.binary, ["--version"], { timeout: 5_000 });
      if (!this.gatewayAutoStart) {
        const running = await this.health();
        return {
          available: running,
          version: `${stdout.trim()}\nAPI: ${running ? "ready" : "stopped"}`,
          error: running ? undefined : "Hermes gateway is stopped",
        };
      }
      const api = await this.ensureApiServer().catch((err: Error) => ({ ok: false as const, error: err.message }));
      return {
        available: api.ok,
        version: `${stdout.trim()}\nAPI: ${api.ok ? "ready" : "unavailable"}`,
        error: api.ok ? undefined : api.error,
      };
    } catch (err) {
      return { available: false, error: (err as Error).message };
    }
  }

  async ensureGatewayReady(): Promise<void> {
    await this.ensureApiServer();
  }

  /**
   * VPS boot: vps-start starts connectors MCP after Joshu listens. Call only after
   * connectors/composio health checks pass so Hermes gets the full MCP tool catalog.
   */
  async prepareGatewayAfterMcpBoot(): Promise<void> {
    // vps-start already wait_for_mcp_http_health'd; confirm quickly then start gateway once.
    let mcpReady = await waitForJoshuMcpDependencies({ attempts: 20, intervalMs: 500 });
    if (!mcpReady.allReady) {
      console.warn("[hermes-api] MCP boot confirm missed; retrying before Hermes gateway start");
      mcpReady = await waitForJoshuMcpDependencies({ attempts: 40, intervalMs: 500 });
    }
    if (!mcpReady.allReady) {
      this.gatewayMcpReloadPending = true;
      throw new Error("MCP HTTP dependencies not healthy after boot wait");
    }
    this.gatewayMcpReloadPending = false;
    this.lastConnectorsMcpHealthy = true;
    this.startMcpGatewayWatchdog();
    if (await this.health()) {
      console.log("[hermes-api] restarting Hermes gateway after MCP boot for full tool catalog");
      await this.stopGatewayDaemon();
      this.gateway = undefined;
    }
    await this.ensureApiServer();
  }

  /** Health checks only — does not start or restart the gateway (avoids 180s health hangs). */
  async probeGatewayHealth(): Promise<boolean> {
    return this.health();
  }

  async getGatewayStatus(): Promise<{ running: boolean; autoStart: boolean }> {
    return {
      running: await this.health(),
      autoStart: this.gatewayAutoStart,
    };
  }

  /** Start or stop the Hermes gateway and update the in-process auto-start flag. */
  async setGatewayEnabled(enabled: boolean): Promise<{ running: boolean; autoStart: boolean }> {
    this.gatewayAutoStart = enabled;
    if (enabled) {
      this.startMcpGatewayWatchdog();
      await this.ensureApiServer();
    } else {
      await this.stopGatewayDaemon();
      this.gateway = undefined;
    }
    return this.getGatewayStatus();
  }

  async streamHermesChat(
    params: StreamHermesChatParams,
    callbacks: StreamHermesChatCallbacks,
  ): Promise<{ sessionId?: string; finalText: string }> {
    await this.ensureApiServer();

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    params.signal?.addEventListener("abort", abort, { once: true });

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      };

      if (params.sessionId) {
        headers["X-Hermes-Session-Id"] = params.sessionId;
        headers["X-Hermes-Session-Key"] =
          params.sessionKey ?? `joshu-hermes-chat:${params.sessionId}`;
      }

      const res = await fetch(`${this.opts.apiBaseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: params.model?.trim() || getJoshuHermesModel(),
          messages: params.messages,
          stream: true,
          ...(params.clientTools?.length ? { tools: params.clientTools, tool_choice: "auto" } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Hermes chat request failed: ${res.status} ${await res.text().catch(() => "")}`);
      }

      const responseSessionId = res.headers.get("x-hermes-session-id") ?? undefined;
      if (responseSessionId) {
        this.lastSessionId = responseSessionId;
        callbacks.onSession?.(responseSessionId);
      }

      const finalText = await this.readChatCompletionStream(res.body, callbacks, params.clientToolNames);
      return { sessionId: responseSessionId, finalText };
    } finally {
      params.signal?.removeEventListener("abort", abort);
    }
  }

  startRun(params: StartRunParams): RunRecord {
    const id = randomUUID();
    const record: RunRecord = {
      id,
      prompt: params.prompt,
      initialUrl: params.initialUrl,
      sessionId: this.lastSessionId,
      status: "pending",
      startedAt: new Date().toISOString(),
      events: [],
    };
    this.runs.set(id, record);
    this.markStatus(record, "running");
    this.pushEvent(record, "system", "Hermes /v1/responses stream started");
    this.runResponsesApi(record, params).catch((err: Error) => {
      if (record.status === "cancelled") return;
      this.pushEvent(record, "stderr", err.message);
      record.endedAt = new Date().toISOString();
      this.markStatus(record, "failed");
    });
    return record;
  }

  cancelRun(id: string): boolean {
    const record = this.runs.get(id);
    if (!record || record.status !== "running") return false;
    this.activeControllers.get(id)?.abort();
    this.pushEvent(record, "system", "Cancelled Hermes API response stream.");
    record.endedAt = new Date().toISOString();
    this.markStatus(record, "cancelled");
    return true;
  }

  async reset(): Promise<void> {
    for (const controller of this.activeControllers.values()) controller.abort();
    this.activeControllers.clear();
    this.histories.clear();
    this.lastSessionId = undefined;
    if (this.gateway && !this.gateway.killed && this.gateway.exitCode === null) this.gateway.kill("SIGTERM");
    this.gateway = undefined;
    await this.stopGatewayDaemon();
  }

  /**
   * Restart gateway so Slack/Telegram messaging env in ~/.hermes/.env is picked up.
   * No-op start when gateway auto-start is disabled.
   */
  async restartGateway(projectRoot = process.cwd()): Promise<{ running: boolean; autoStart: boolean }> {
    await syncHermesMessagingEnv(projectRoot);
    if (this.gateway && !this.gateway.killed && this.gateway.exitCode === null) {
      this.gateway.kill("SIGTERM");
    }
    this.gateway = undefined;
    await this.stopGatewayDaemon();
    if (!this.gatewayAutoStart) {
      return this.getGatewayStatus();
    }
    await this.ensureApiServer();
    return this.getGatewayStatus();
  }

  private async runResponsesApi(record: RunRecord, params: StartRunParams): Promise<void> {
    await this.ensureApiServer();
    const controller = new AbortController();
    const historyKey = params.conversationId || "hitl-camofox";
    const conversationHistory = this.histories.get(historyKey) ?? [];
    this.activeControllers.set(record.id, controller);

    try {
      const res = await fetch(`${this.opts.apiBaseUrl.replace(/\/+$/, "")}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "hermes-agent",
          input: composePrompt(params),
          conversation_history: conversationHistory,
          store: false,
          stream: true,
          instructions: "You are driving a human-in-the-loop Camofox browser. The human may also interact via VNC. Use browser tools when useful.",
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw new Error(`Hermes API request failed: ${res.status} ${await res.text().catch(() => "")}`);
      const hermesSessionId = res.headers.get("x-hermes-session-id");
      if (hermesSessionId) {
        this.lastSessionId = hermesSessionId;
        record.sessionId = hermesSessionId;
      }
      await this.readResponsesStream(record, res.body);
      if (record.status === "succeeded" && record.finalResponse) {
        this.rememberHistory(historyKey, params.prompt, record.finalResponse);
      }
    } finally {
      this.activeControllers.delete(record.id);
    }
  }

  private rememberHistory(key: string, userPrompt: string, assistantResponse: string): void {
    const next: ChatMessage[] = [
      ...(this.histories.get(key) ?? []),
      { role: "user", content: userPrompt },
      { role: "assistant", content: assistantResponse },
    ];
    this.histories.set(key, next.slice(-MAX_HISTORY_MESSAGES));
  }

  private async readResponsesStream(record: RunRecord, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let finalText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let data = "";
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (eventName === "response.output_text.delta" && typeof parsed.delta === "string") {
          finalText += parsed.delta;
          this.pushEvent(record, "stdout", parsed.delta);
        } else if ((eventName === "response.output_item.added" || eventName === "response.output_item.done") && typeof parsed.item === "object" && parsed.item) {
          const item = parsed.item as { type?: string; name?: string; arguments?: string };
          if (item.type === "function_call") this.pushEvent(record, "system", `tool ${item.name ?? "function_call"} ${item.arguments ?? ""}`.trim());
        } else if (eventName === "response.completed") {
          record.finalResponse = finalText;
          record.endedAt = new Date().toISOString();
          this.markStatus(record, "succeeded");
        } else if (eventName === "response.failed") {
          record.finalResponse = finalText || "Hermes API response failed.";
          record.endedAt = new Date().toISOString();
          this.markStatus(record, "failed");
        }
        eventName = "message";
      }
    }

    if (record.status === "running") {
      record.finalResponse = finalText;
      record.endedAt = new Date().toISOString();
      this.markStatus(record, "succeeded");
    }
  }

  private async readChatCompletionStream(
    body: ReadableStream<Uint8Array>,
    callbacks: StreamHermesChatCallbacks,
    clientToolNames?: Set<string>,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalText = "";
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string; started: boolean; ended: boolean }
    >();

    const flushClientToolEnd = (pending: {
      id: string;
      name: string;
      arguments: string;
      started: boolean;
      ended: boolean;
    }): void => {
      if (pending.ended || !pending.started) return;
      pending.ended = true;
      callbacks.onClientToolCall?.({
        toolCallId: pending.id,
        toolCallName: pending.name,
        argumentsDelta: pending.arguments,
        phase: "end",
      });
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = this.parseSseEvent(raw);
        if (!event.data || event.data === "[DONE]") continue;

        if (event.name === "hermes.tool.progress" || event.name === "claude.tool.progress") {
          const parsed = this.parseJson(event.data);
          if (parsed && typeof parsed === "object") {
            const normalized = this.normalizeToolEvent(parsed as Record<string, unknown>);
            const shortName = normalized.tool.replace(/^.*\./, "");
            if (clientToolNames?.has(normalized.tool) || clientToolNames?.has(shortName)) {
              continue;
            }
            callbacks.onTool?.(normalized);
          }
          continue;
        }

        const parsed = this.parseJson(event.data) as
          | {
              choices?: Array<{
                finish_reason?: string | null;
                delta?: {
                  content?: string | null;
                  reasoning?: string | null;
                  reasoning_content?: string | null;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
            }
          | undefined;
        const choice = parsed?.choices?.[0];
        const delta = choice?.delta;
        const content = delta?.content || "";
        const reasoning = delta?.reasoning || delta?.reasoning_content || "";
        if (content) {
          finalText += content;
          callbacks.onDelta?.(content);
        } else if (reasoning) {
          callbacks.onReasoning?.(reasoning);
        }

        if (delta?.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            const index = typeof tc.index === "number" ? tc.index : 0;
            let pending = pendingToolCalls.get(index);
            if (!pending) {
              pending = {
                id: tc.id ?? `call_${index}_${Date.now()}`,
                name: tc.function?.name ?? "",
                arguments: "",
                started: false,
                ended: false,
              };
              pendingToolCalls.set(index, pending);
            }
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
            if (tc.function?.arguments) {
              pending.arguments += tc.function.arguments;
              if (!pending.started && pending.name) {
                pending.started = true;
                callbacks.onClientToolCall?.({
                  toolCallId: pending.id,
                  toolCallName: pending.name,
                  phase: "start",
                });
              }
              callbacks.onClientToolCall?.({
                toolCallId: pending.id,
                toolCallName: pending.name,
                argumentsDelta: tc.function.arguments,
                phase: "args",
              });
            } else if (!pending.started && pending.name && tc.id) {
              pending.started = true;
              callbacks.onClientToolCall?.({
                toolCallId: pending.id,
                toolCallName: pending.name,
                phase: "start",
              });
            }
          }
        }

        if (choice?.finish_reason === "tool_calls") {
          for (const pending of pendingToolCalls.values()) {
            flushClientToolEnd(pending);
          }
        }
      }
    }

    for (const pending of pendingToolCalls.values()) {
      flushClientToolEnd(pending);
    }

    return finalText;
  }

  private parseSseEvent(raw: string): { name: string; data: string } {
    let name = "message";
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        name = line.slice(6).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    return { name, data: dataLines.join("\n") };
  }

  private parseJson(value: string): unknown | undefined {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  private normalizeToolEvent(raw: Record<string, unknown>): HermesChatToolEvent {
    const statusRaw = typeof raw.status === "string" ? raw.status : undefined;
    const status = statusRaw === "running" || statusRaw === "completed" ? statusRaw : undefined;
    return {
      tool: typeof raw.tool === "string" ? raw.tool : typeof raw.name === "string" ? raw.name : "tool",
      emoji: typeof raw.emoji === "string" ? raw.emoji : undefined,
      label: typeof raw.label === "string" ? raw.label : undefined,
      toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : typeof raw.tool_call_id === "string" ? raw.tool_call_id : undefined,
      status,
      raw,
    };
  }

  private async ensureApiServer(): Promise<{ ok: true }> {
    await this.ensureJoshuHermesConfig();
    if (await this.health()) {
      // Joshu restarted but a prior gateway may still own :8642 with stale env
      // (e.g. Langfuse region). Replace it when this process did not spawn it.
      const ownsGateway =
        this.gateway !== undefined && !this.gateway.killed && this.gateway.exitCode === null;
      const connectorsOk = await probeMcpHttpHealth(resolveConnectorsMcpHealthUrl());
      const needsMcpCatalogRefresh = this.gatewayMcpReloadPending || !connectorsOk;
      if (ownsGateway && !needsMcpCatalogRefresh) return { ok: true };
      if (!ownsGateway && !needsMcpCatalogRefresh && !this.gatewayAutoStart) return { ok: true };
      if (ownsGateway && needsMcpCatalogRefresh) {
        console.log("[hermes-api] restarting owned Hermes gateway to refresh MCP tool catalog");
        await this.stopGatewayDaemon();
        this.gateway = undefined;
      } else if (!ownsGateway && this.gatewayAutoStart) {
        console.log("[hermes-api] replacing existing Hermes gateway with current process env");
        await this.stopGatewayDaemon();
      }
      await this.releaseStaleGbrainMcp();
    }
    if (!this.gatewayAutoStart) throw new Error("Hermes API server is not running");
    await this.releaseStaleGbrainMcp();
    const mcpReady = await waitForJoshuMcpDependencies();
    if (!mcpReady.allReady) {
      this.gatewayMcpReloadPending = true;
      console.warn(
        "[hermes-api] starting Hermes gateway before all MCP servers are healthy; will reload when connectors MCP is ready",
      );
    } else {
      this.gatewayMcpReloadPending = false;
      this.lastConnectorsMcpHealthy = true;
    }
    this.startGateway();
    // Cold start: gbrain MCP connect_timeout can be 120s + plugin load.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (await this.health()) return { ok: true };
      if (this.gateway && this.gateway.exitCode !== null) {
        console.warn(
          `[hermes-api] Hermes gateway exited (${this.gateway.exitCode}); restarting`,
        );
        await this.releaseStaleGbrainMcp();
        const mcpReady = await waitForJoshuMcpDependencies();
        if (!mcpReady.allReady) this.gatewayMcpReloadPending = true;
        this.startGateway();
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("Timed out waiting for Hermes API server");
  }

  private async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.opts.apiBaseUrl.replace(/\/+$/, "")}/health`, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Start gateway in the background (e.g. when Joshu listens). Does not throw on timeout. */
  warmGatewayInBackground(): void {
    if (!this.gatewayAutoStart) return;
    this.startMcpGatewayWatchdog();
    void this.ensureApiServer().catch((err: Error) => {
      console.warn(`[hermes-api] Hermes gateway warm-up: ${err.message}`);
    });
  }

  /**
   * After hard factory reset: re-seed joshu skills, re-merge skills.disabled, restart gateway.
   * Safe on VPS (HERMES_DIR=/opt/hermes-agent) and local dev (HERMES_BIN walk-up).
   */
  async resyncHermesAfterBoxHardReset(): Promise<void> {
    if (!this.gatewayAutoStart) return;
    this.learningBootstrapPromise = undefined;
    await bootstrapHermesLearning({ seedMode: "overwrite" });
    await this.stopGatewayDaemon();
    this.gateway = undefined;
    await this.ensureApiServer();
  }

  /** VPS boot: start MCP recovery watchdog without starting the gateway yet. */
  startMcpGatewayWatchdogOnly(): void {
    if (!this.gatewayAutoStart) return;
    this.startMcpGatewayWatchdog();
  }

  /** Nudge gateway reload after MCP supervisor observes connectors/composio recovery. */
  nudgeGatewayAfterMcpRecovery(label: string): void {
    if (label !== "connectors MCP" && label !== "composio MCP guard") return;
    this.gatewayMcpReloadPending = true;
    void this.syncGatewayWithMcpHealth();
  }

  private startMcpGatewayWatchdog(): void {
    if (this.mcpGatewayWatchdogTimer) return;
    this.mcpGatewayWatchdogTimer = setInterval(() => {
      void this.syncGatewayWithMcpHealth();
    }, 30_000);
  }

  /** Restart gateway when connectors MCP recovers so Hermes re-runs tools/list. */
  private async syncGatewayWithMcpHealth(): Promise<void> {
    if (!this.gatewayAutoStart || this.mcpGatewayReloadInFlight) return;

    const connectorsOk = await probeMcpHttpHealth(resolveConnectorsMcpHealthUrl());
    if (!connectorsOk) {
      this.lastConnectorsMcpHealthy = false;
      this.gatewayMcpReloadPending = true;
      return;
    }

    if (!this.gatewayMcpReloadPending && this.lastConnectorsMcpHealthy) return;

    this.lastConnectorsMcpHealthy = true;
    if (!this.gatewayMcpReloadPending) return;

    const ownsGateway =
      this.gateway !== undefined && !this.gateway.killed && this.gateway.exitCode === null;
    const gatewayUp = ownsGateway || (await this.health());
    if (!gatewayUp) {
      this.gatewayMcpReloadPending = false;
      return;
    }

    this.mcpGatewayReloadInFlight = true;
    try {
      console.log("[hermes-api] connectors MCP ready; restarting Hermes gateway for full MCP tool catalog");
      await this.stopGatewayDaemon();
      this.gateway = undefined;
      this.gatewayMcpReloadPending = false;
      await this.ensureApiServer();
    } catch (err) {
      console.warn(`[hermes-api] MCP gateway reload failed: ${(err as Error).message}`);
      this.gatewayMcpReloadPending = true;
    } finally {
      this.mcpGatewayReloadInFlight = false;
    }
  }

  /** Kill legacy Hermes-spawned stdio gbrain proxies only (Joshu owns HTTP MCP). */
  private async releaseStaleGbrainMcp(): Promise<void> {
    try {
      await execFile("pkill", ["-f", "gbrain-mcp-readonly-proxy"], { timeout: 5_000 });
    } catch {
      /* no legacy proxy running */
    }
  }

  private startGateway(): void {
    if (this.gateway && !this.gateway.killed && this.gateway.exitCode === null) return;
    const anthropicKey = resolveAnthropicApiKey();
    const openRouterKey = resolveOpenRouterApiKey();
    const hermesProvider = getJoshuHermesProvider();
    if (hermesProvider === "openrouter" && !openRouterKey) {
      console.warn(
        "[hermes-api] OPENROUTER_API_KEY missing; Hermes gateway will return empty completions. " +
          "Set OPENROUTER_API_KEY in .env or run: hermes config set OPENROUTER_API_KEY sk-or-...",
      );
    } else if (hermesProvider !== "openrouter" && !anthropicKey) {
      console.warn("[hermes-api] ANTHROPIC_API_KEY missing; Hermes gateway will return empty completions");
    }
    const langfuseUserId = resolveLangfuseUserId();
    const gateway = spawn(this.opts.binary, ["gateway", "run", "--replace", "--quiet", "--accept-hooks"], {
      env: {
        ...process.env,
        API_SERVER_ENABLED: "true",
        API_SERVER_KEY: this.opts.apiKey,
        ANTHROPIC_API_KEY: anthropicKey,
        OPENROUTER_API_KEY: openRouterKey,
        JOSHU_HERMES_MODEL: getJoshuHermesModel(),
        JOSHU_HERMES_PROVIDER: hermesProvider,
        API_SERVER_HOST: "127.0.0.1",
        API_SERVER_PORT: "8642",
        ...(langfuseUserId ? { HERMES_LANGFUSE_USER_ID: langfuseUserId } : {}),
        CAMOFOX_URL: this.opts.camofoxUrl,
        // Project plugins live under <repo>/.hermes/plugins. This repo is trusted
        // by the Joshu host, so enable Hermes's opt-in project plugin scanner.
        HERMES_ENABLE_PROJECT_PLUGINS: process.env.HERMES_ENABLE_PROJECT_PLUGINS || "true",
        CAMOFOX_USER_ID: process.env.CAMOFOX_USER_ID || this.opts.hitlCamofoxUserId,
        CAMOFOX_SESSION_KEY: process.env.CAMOFOX_SESSION_KEY || this.opts.hitlCamofoxSessionKey,
        CAMOFOX_ADOPT_EXISTING_TAB: process.env.CAMOFOX_ADOPT_EXISTING_TAB || "true",
        HITL_CAMOFOX_USER_ID: this.opts.hitlCamofoxUserId,
        HITL_CAMOFOX_SESSION_KEY: this.opts.hitlCamofoxSessionKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.gateway = gateway;
    gateway.stderr.setEncoding("utf8");
    gateway.stderr.on("data", (chunk) => console.warn(`[hermes-api] ${String(chunk).trim()}`));
  }

  /** Idempotent: apply HITL Camofox patches to the external Hermes checkout before gateway/tools run. */
  private async ensureHermesHitlBrowserPatch(): Promise<boolean> {
    if (this.hitlBrowserPatchEnsured) return false;
    this.hitlBrowserPatchEnsured = true;

    const hermesDir = resolveHermesCheckoutDir(this.opts.binary);
    if (!hermesDir) return false;

    const target = path.join(hermesDir, "tools/browser_camofox.py");
    try {
      await execFile("test", ["-f", target]);
    } catch {
      return false;
    }

    try {
      await execFile("bash", [APPLY_HERMES_HITL_PATCH_SCRIPT], {
        env: { ...process.env, HERMES_DIR: hermesDir },
        timeout: 15_000,
      });
      return false;
    } catch (err) {
      const execErr = err as NodeJS.ErrnoException & { code?: string | number; status?: number };
      const exitCode = typeof execErr.status === "number" ? execErr.status : Number(execErr.code);
      if (exitCode === 2) {
        console.log("[hermes-api] Camofox tab resync patch applied; Hermes gateway will restart");
        return true;
      }
      console.warn(`[hermes-api] HITL Camofox patch skipped: ${(err as Error).message}`);
      return false;
    }
  }

  private async ensureHermesContentFilterPatch(): Promise<boolean> {
    const hermesDir = resolveHermesCheckoutDir(this.opts.binary);
    if (!hermesDir) return false;

    const target = path.join(hermesDir, "run_agent.py");
    try {
      await execFile("test", ["-f", target]);
    } catch {
      return false;
    }

    try {
      const { stdout } = await execFile("bash", [APPLY_HERMES_CONTENT_FILTER_PATCH_SCRIPT], {
        env: { ...process.env, HERMES_DIR: hermesDir },
        timeout: 15_000,
      });
      return stdout.includes("applying from");
    } catch (err) {
      console.warn(`[hermes-api] content filter patch skipped: ${(err as Error).message}`);
      return false;
    }
  }

  private async ensureJoshuHermesConfig(): Promise<void> {
    const resyncPatchApplied = await this.ensureHermesHitlBrowserPatch();
    const contentFilterPatchApplied = await this.ensureHermesContentFilterPatch();
    if (resyncPatchApplied || contentFilterPatchApplied) {
      await this.stopGatewayDaemon();
      this.gateway = undefined;
    }

    const hermesHome = getHermesHome();
    const configPath = path.join(hermesHome, "config.yaml");
    const hindsightConfigPath = path.join(hermesHome, "hindsight", "config.json");
    const skillDir = path.resolve(process.env.JOSHU_HERMES_SKILLS_DIR || DEFAULT_JOSHU_HERMES_SKILLS_DIR);
    const pluginNames = getConfiguredJoshuPluginNames();

    await mkdir(hermesHome, { recursive: true });

    await migrateHermesUserConfig(hermesHome).catch((err) => {
      console.warn(`[hermes-api] config.user.yaml migration skipped: ${(err as Error).message}`);
    });

    const { managed, recoveredFromCorrupt } = await readManagedHermesConfig(hermesHome);
    let config: ConfigRecord = managed;
    if (recoveredFromCorrupt) {
      console.warn(
        `[hermes-api] corrupt Hermes config at ${configPath}; rebuilding product defaults + config.user.yaml`,
      );
    }

    const skills = asRecord(config.skills);
    const externalDirs = asStringArray(skills.external_dirs);
    let changed = false;
    // Product skills live in $HERMES_HOME/skills/joshu/ (seeded, writable). Drop read-only external_dirs.
    const resolvedSkillDir = path.resolve(skillDir);
    const filteredExternalDirs = externalDirs.filter((d) => path.resolve(d) !== resolvedSkillDir);
    if (JSON.stringify(filteredExternalDirs) !== JSON.stringify(externalDirs)) {
      skills.external_dirs = filteredExternalDirs;
      changed = true;
    }

    const denylistEnabled = process.env.JOSHU_HERMES_SKILLS_DENYLIST_ENABLED?.trim() !== "false";
    const { disabled: productDisabledRaw, enabled: productEnabled } = await loadProductSkillsPolicy();
    const productDisabled = denylistEnabled ? productDisabledRaw : [];
    let skillsDisabledChanged = false;
    if (JSON.stringify(asStringArray(skills.disabled)) !== JSON.stringify(productDisabled)) {
      skills.disabled = productDisabled;
      changed = true;
      skillsDisabledChanged = true;
    }
    if (skillsDisabledChanged && productDisabled.length > 0) {
      console.log(
        `[hermes-api] Hermes skills policy: ${productEnabled.length} enabled, ${productDisabled.length} bundled disabled (allowlist; agent skills in ~/.hermes/skills stay enabled)`,
      );
    }

    config.skills = skills;

    let pluginsChanged = false;
    if (pluginNames.length > 0) {
      const plugins = asRecord(config.plugins);
      const enabled = asStringArray(plugins.enabled);
      for (const pluginName of pluginNames) {
        if (!enabled.includes(pluginName)) {
          enabled.push(pluginName);
          changed = true;
          pluginsChanged = true;
        }
      }
      plugins.enabled = enabled;
      config.plugins = plugins;
    }

    // Product sandboxes need an explicit default model; skills/browser alone are not enough.
    const modelBlock = asRecord(config.model);
    const desiredModel = getJoshuHermesModel();
    const desiredProvider = getJoshuHermesProvider();
    if (modelBlock.default !== desiredModel) {
      modelBlock.default = desiredModel;
      changed = true;
    }
    if (modelBlock.provider !== desiredProvider) {
      modelBlock.provider = desiredProvider;
      changed = true;
    }
    config.model = modelBlock;

    const desiredToolsetsRaw = envString("JOSHU_HERMES_TOOLSETS", DEFAULT_JOSHU_HERMES_TOOLSETS);
    let toolsets = parseToolsets(config.toolsets);
    if (toolsets.length === 0) {
      toolsets = parseToolsets(desiredToolsetsRaw);
    }
    if (toolsets.length === 0) {
      toolsets = ["hermes-cli", "browser"];
    }
    if (!toolsets.includes("mcp-gbrain")) {
      toolsets.push("mcp-gbrain");
    }
    if (!toolsets.includes("mcp-joshu-connectors")) {
      toolsets.push("mcp-joshu-connectors");
    }
    if (!toolsets.includes("kanban")) {
      toolsets.push("kanban");
    }
    if (pluginNames.includes("joshu-desktop") && !toolsets.includes("joshu-desktop")) {
      toolsets.push("joshu-desktop");
      changed = true;
    }
    {
      const plugins = asRecord(config.plugins);
      const enabled = asStringArray(plugins.enabled);
      if (!enabled.includes("joshu-app-gui")) {
        enabled.push("joshu-app-gui");
        changed = true;
        pluginsChanged = true;
      }
      plugins.enabled = enabled;
      config.plugins = plugins;
    }
    if (!toolsets.includes("joshu-app-gui")) {
      toolsets.push("joshu-app-gui");
      changed = true;
    }

    // Hermes tool workers read ~/.hermes/config.yaml; gateway env alone is not always
    // enough. Pin the shared HITL Camofox identity so browser_scroll etc. reuse the
    // noVNC tab instead of creating hermes_* sessions that fight Joshu.
    const browser = asRecord(config.browser);
    const camofox = asRecord(browser.camofox);
    const hitlUserId =
      envString("CAMOFOX_USER_ID") || envString("HITL_CAMOFOX_USER_ID") || this.opts.hitlCamofoxUserId;
    const hitlSessionKey =
      envString("CAMOFOX_SESSION_KEY") || envString("HITL_CAMOFOX_SESSION_KEY") || this.opts.hitlCamofoxSessionKey;
    if (camofox.user_id !== hitlUserId) {
      camofox.user_id = hitlUserId;
      changed = true;
    }
    if (camofox.session_key !== hitlSessionKey) {
      camofox.session_key = hitlSessionKey;
      changed = true;
    }
    if (camofox.adopt_existing_tab !== true) {
      camofox.adopt_existing_tab = true;
      changed = true;
    }
    browser.camofox = camofox;
    config.browser = browser;

    const mcpServers = asRecord(config.mcp_servers);
    const gbrainServer = asRecord(mcpServers.gbrain);
    const filesPaths = resolveJoshuFilesPaths(process.cwd());
    const workspaceScope = filesPaths ? resolveJoshuHermesWorkspaceScope(filesPaths) : null;

    if (workspaceScope) {
      const terminal = asRecord(config.terminal);
      if (terminal.cwd !== workspaceScope.terminalCwd) {
        terminal.cwd = workspaceScope.terminalCwd;
        changed = true;
      }
      config.terminal = terminal;
    }
    const gbrainMcpUrl = resolveGbrainMcpHttpUrl();
    const desiredGbrain = {
      url: gbrainMcpUrl,
      connect_timeout: 120,
      enabled: true,
    };
    if (
      gbrainServer.url !== desiredGbrain.url ||
      typeof gbrainServer.command === "string" ||
      gbrainServer.connect_timeout !== desiredGbrain.connect_timeout ||
      gbrainServer.enabled !== true
    ) {
      mcpServers.gbrain = desiredGbrain;
      changed = true;
    }

    const connectorsServer = asRecord(mcpServers.joshu_connectors);
    const guardActive = isActionGuardEnabled();
    const desiredConnectors = {
      url: resolveJoshuConnectorsMcpHttpUrl(),
      connect_timeout: guardActive ? 1800 : 60,
      enabled: true,
    };
    if (
      connectorsServer.url !== desiredConnectors.url ||
      connectorsServer.connect_timeout !== desiredConnectors.connect_timeout ||
      connectorsServer.enabled !== true
    ) {
      mcpServers.joshu_connectors = desiredConnectors;
      changed = true;
    }

    // aeon MCP blocks local boot when nothing listens on :8001 (60s × retries).
    const aeonServer = asRecord(mcpServers.aeon);
    if (Object.keys(aeonServer).length > 0 && process.env.JOSHU_AEON_MCP_ENABLED?.trim() !== "true") {
      if (aeonServer.enabled !== false) {
        mcpServers.aeon = { ...aeonServer, enabled: false };
        changed = true;
      }
    }

    config.mcp_servers = mcpServers;

    const composioServer = asRecord(mcpServers.composio);
    const composioSessionActive =
      composioServer.enabled !== false &&
      typeof composioServer.url === "string" &&
      composioServer.url.length > 0;
    const orderedToolsets = toolsetsWithComposio(toolsets, composioSessionActive);
    if (JSON.stringify(parseToolsets(config.toolsets)) !== JSON.stringify(orderedToolsets)) {
      config.toolsets = orderedToolsets;
      changed = true;
    }

    // Ad-hoc project boards use triage + auto_decompose. EA scheduling stays safe:
    // ingress/meeting tasks are created with assignee → ready (never triage); bridge
    // rejects triage creates on ea-sched-* boards.
    const kanban = asRecord(config.kanban);
    if (kanban.auto_decompose !== true) {
      kanban.auto_decompose = true;
      changed = true;
    }
    if (kanban.dispatch_in_gateway !== true) {
      kanban.dispatch_in_gateway = true;
      changed = true;
    }
    const dispatchInterval = Number(kanban.dispatch_interval_seconds);
    if (!Number.isFinite(dispatchInterval) || dispatchInterval <= 0) {
      kanban.dispatch_interval_seconds = 60;
      changed = true;
    }
    config.kanban = kanban;

    const auxiliary = asRecord(config.auxiliary);
    const sessionSearch = asRecord(auxiliary.session_search);
    const desiredSessionSearchModel = envString(
      "JOSHU_HERMES_SESSION_SEARCH_MODEL",
      JOSHU_OPENROUTER_SESSION_SEARCH_MODEL,
    );
    const desiredSessionSearchProvider = envString(
      "JOSHU_HERMES_SESSION_SEARCH_PROVIDER",
      DEFAULT_JOSHU_HERMES_PROVIDER,
    );
    if (sessionSearch.provider !== desiredSessionSearchProvider) {
      sessionSearch.provider = desiredSessionSearchProvider;
      changed = true;
    }
    if (sessionSearch.model !== desiredSessionSearchModel) {
      sessionSearch.model = desiredSessionSearchModel;
      changed = true;
    }
    auxiliary.session_search = sessionSearch;
    config.auxiliary = auxiliary;

    const memory = asRecord(config.memory);
    const hindsightEnabled = isJoshuHindsightEnabled();
    if (hindsightEnabled) {
      if (memory.provider !== "hindsight") {
        memory.provider = "hindsight";
        changed = true;
      }
    } else if (process.env.JOSHU_HINDSIGHT_ENABLED?.trim().toLowerCase() !== "auto" && memory.provider === "hindsight") {
      delete memory.provider;
      changed = true;
    }
    if (Object.keys(memory).length > 0) config.memory = memory;

    const wroteConfig = await writeMergedHermesConfig(hermesHome, config);
    if (wroteConfig && recoveredFromCorrupt) {
      console.warn(`[hermes-api] repaired Hermes config at ${configPath}`);
    } else if (wroteConfig && changed) {
      console.log(`[hermes-api] configured Joshu Hermes runtime at ${configPath}`);
    }
    if (changed && browser.camofox) {
      console.log(
        `[hermes-api] Camofox identity ${hitlUserId} / ${hitlSessionKey} (adopt_existing_tab=true). ` +
          "Restart the Hermes gateway if browser tools still open a second tab.",
      );
    }

    // Learning bootstrap runs once per Joshu process (vps-start also runs at container boot).
    // Health probes may call ensureJoshuHermesConfig concurrently — single-flight the bootstrap.
    if (!this.learningBootstrapPromise) {
      this.learningBootstrapPromise = (async () => {
        await bootstrapHermesLearning();
        await trySyncHermesLearningGitCron();
      })();
    }
    await this.learningBootstrapPromise;

    if (pluginsChanged || skillsDisabledChanged) {
      const reason = pluginsChanged ? "Langfuse hooks" : "skills denylist";
      console.log(`[hermes-api] Hermes ${reason} changed; restarting gateway`);
      await this.stopGatewayDaemon();
      this.gateway = undefined;
    }

    const dotenvSync: Record<string, string> = {
      CAMOFOX_URL: this.opts.camofoxUrl,
      CAMOFOX_USER_ID: hitlUserId,
      CAMOFOX_SESSION_KEY: hitlSessionKey,
      CAMOFOX_ADOPT_EXISTING_TAB: "true",
      HITL_CAMOFOX_USER_ID: hitlUserId,
      HITL_CAMOFOX_SESSION_KEY: hitlSessionKey,
    };
    const anthropicKey = resolveAnthropicApiKey();
    if (anthropicKey) dotenvSync.ANTHROPIC_API_KEY = anthropicKey;
    const openRouterKey = resolveOpenRouterApiKey();
    if (openRouterKey) dotenvSync.OPENROUTER_API_KEY = openRouterKey;
    if (filesPaths && workspaceScope) {
      Object.assign(dotenvSync, joshuFilesPathEnv(filesPaths));
      dotenvSync.JOSHU_REPO_ROOT = process.cwd();
      dotenvSync.HERMES_WRITE_SAFE_ROOT = workspaceScope.writeSafeRoot;
    }
    const gatewayKey = envString("HERMES_API_KEY") || this.opts.apiKey;
    if (gatewayKey) {
      dotenvSync.HERMES_API_KEY = gatewayKey;
      dotenvSync.API_SERVER_KEY = envString("API_SERVER_KEY") || gatewayKey;
    }
    const langfuseBaseUrl =
      envString("HERMES_LANGFUSE_BASE_URL") || envString("HERMES_LANGFUSE_URL");
    if (langfuseBaseUrl) dotenvSync.HERMES_LANGFUSE_BASE_URL = langfuseBaseUrl;
    for (const key of [
      "HERMES_LANGFUSE_PUBLIC_KEY",
      "HERMES_LANGFUSE_SECRET_KEY",
      "HERMES_LANGFUSE_ENV",
      "HERMES_LANGFUSE_RELEASE",
      "HERMES_LANGFUSE_SAMPLE_RATE",
      "HERMES_LANGFUSE_MAX_CHARS",
      "HERMES_LANGFUSE_DEBUG",
    ] as const) {
      const value = envString(key);
      if (value) dotenvSync[key] = value;
    }
    const langfuseUserId = resolveLangfuseUserId();
    if (langfuseUserId) dotenvSync.HERMES_LANGFUSE_USER_ID = langfuseUserId;
    Object.assign(dotenvSync, buildHermesMessagingDotenvEntries(process.cwd()));

    const connectorsApiBase = envString(
      "JOSHU_CONNECTORS_API_BASE",
      `http://127.0.0.1:${envString("PORT", "8788")}/joshu`,
    );
    dotenvSync.JOSHU_CONNECTORS_API_BASE = connectorsApiBase;
    const guardPolicy = loadActionGuardPolicy(process.cwd());
    if (guardPolicy.browserGateWrites) {
      dotenvSync.JOSHU_ACTION_GUARD_BROWSER_GATE = "true";
    }
    const terminalMailGuard = resolveEnvWithLocalFallback("JOSHU_TERMINAL_MAIL_GUARD");
    if (terminalMailGuard) {
      dotenvSync.JOSHU_TERMINAL_MAIL_GUARD = terminalMailGuard;
    }

    await syncHermesDotenv(dotenvSync);

    if (
      langfuseUserId &&
      langfuseUserId !== this.syncedLangfuseUserId &&
      this.gateway &&
      this.gateway.exitCode === null &&
      !this.gateway.killed
    ) {
      console.log(
        `[hermes-api] HERMES_LANGFUSE_USER_ID=${langfuseUserId}; restarting gateway for Langfuse user attribution`,
      );
      await this.stopGatewayDaemon();
      this.gateway = undefined;
    }
    if (langfuseUserId) this.syncedLangfuseUserId = langfuseUserId;

    if (workspaceScope && !this.workspaceScopeLogged) {
      console.log(
        `[hermes-api] Hermes workspace scoped to ArozOS Desktop: terminal.cwd=${workspaceScope.terminalCwd}, ` +
          `HERMES_WRITE_SAFE_ROOT=${workspaceScope.writeSafeRoot}`,
      );
      this.workspaceScopeLogged = true;
    }

    if (syncHermesContextFile(process.cwd())) {
      console.log("[hermes-api] synced HERMES.md project context on Desktop");
    }

    if (hindsightEnabled) {
      await mkdir(path.dirname(hindsightConfigPath), { recursive: true });
      const next = `${JSON.stringify(buildHindsightConfig(), null, 2)}\n`;
      let current = "";
      try {
        current = await readFile(hindsightConfigPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[hermes-api] could not read Hindsight config at ${hindsightConfigPath}: ${(err as Error).message}`);
        }
      }
      if (current !== next) {
        await writeFile(hindsightConfigPath, next, "utf8");
        console.log(`[hermes-api] configured Hermes Hindsight provider at ${hindsightConfigPath}`);
      }
    }
  }

  private async stopGatewayDaemon(): Promise<void> {
    try {
      await execFile(this.opts.binary, ["gateway", "stop"], { timeout: 10_000 });
    } catch {
      // Fallback below handles older/broken gateway stop behavior.
    }
    if (await this.waitForGatewayDown(8_000)) return;
    await this.killByPidFile();
    await this.waitForGatewayDown(8_000);
  }

  private async waitForGatewayDown(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.health())) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  private async killByPidFile(): Promise<void> {
    try {
      const raw = await readFile(HERMES_GATEWAY_PID_FILE, "utf8");
      const { pid } = JSON.parse(raw) as { pid?: number };
      if (pid) process.kill(pid, "SIGTERM");
    } catch {
      // Best-effort only.
    }
  }

  private pushEvent(record: RunRecord, stream: RunEvent["stream"], text: string): void {
    const event: RunEvent = { ts: new Date().toISOString(), stream, text };
    record.events.push(event);
    this.emit("event", { runId: record.id, event });
  }

  private markStatus(record: RunRecord, status: RunStatus): void {
    if (record.status === status) return;
    record.status = status;
    this.emit("status", { runId: record.id, status });
  }
}
