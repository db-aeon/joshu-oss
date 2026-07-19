import "dotenv/config";
import "./observability/langfuse.js";
import express, { type Request, type Response, type Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import httpProxy from "http-proxy";
import type { IncomingMessage } from "node:http";
import morgan from "morgan";
import type { Duplex } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { getCamofoxStatus } from "./camofox.js";
import { CamofoxSessionCoordinator } from "./camofoxSession.js";
import { DockerSupervisor } from "./docker.js";
import { HermesApiRunner, buildBrowserSyncSystemMessage, buildTurnSystemMessages } from "./hermesApi.js";
import {
  browserSyncModeFromEnv,
  extractLastUserMessageText,
  resolveBrowserSyncLevel,
  type BrowserSyncMode,
} from "./hermesBrowserSyncPolicy.js";
import { registerMovieEditorRoutes } from "./movieEditorApi.js";
import type { HermesChatMessage } from "./hermesApi.js";
import { audioMimeForPath, getHermesHomeDir, spawnHermesPython } from "./hermesVoiceRuntime.js";
import { registerInstanceHealthRoutes } from "./instanceHealth.js";
import { readHermesGatewayPreference, writeHermesGatewayPreference } from "./hermesGatewayPreference.js";
import { syncCompanionIdentityFromEnv } from "./companionIdentitySync.js";
import { registerBoxStateRoutes } from "./boxStateApi.js";
import { registerBoxSecretsRoutes } from "./boxSecrets/routes.js";
import { registerOnboardingRoutes } from "./onboardingApi.js";
import { registerDay0Routes } from "./day0/day0Api.js";
import { registerHermesCronRoutes } from "./hermesCronApi.js";
import {
  handleHermesDashboardUpgrade,
  hermesDashboardPathSegment,
  hermesDashboardProxyPath,
  hermesDashboardUpgradePrefixes,
  registerHermesDashboardRoutes,
} from "./hermesDashboard.js";
import { registerBrainRoutes, probeGbrainHealth } from "./brainApi.js";
import { registerShareChatRoutes, registerShareChatSlackEventsRoute, registerShareChatComposioTriggersRoute } from "./shareChat/routes.js";
import { registerFilesRoutes } from "./filesApi.js";
import { registerDesktopActionRoutes, drainDesktopActionsForChat, desktopActionFromHermesToolRaw } from "./desktopActionApi.js";
import { registerAppGuiActionRoutes } from "./appGuiActionApi.js";
import { registerNylasRoutes } from "./nylas/routes.js";
import { registerComposioRoutes } from "./composioRoutes.js";
import { registerConnectorRoutes } from "./connectors/routes.js";
import { registerConnectorComposioRoutes } from "./connectors/composioRoutes.js";
import { registerEaTriageRoutes } from "./ea/triageRoutes.js";
import { registerActionGuardRoutes } from "./actionGuard/routes.js";
import { registerOwnerChannelRoutes } from "./ownerChannel/routes.js";
import { registerSafetySettingsRoutes } from "./safetySettings/routes.js";
import {
  isConnectorsMcpRequiredForHealth,
  probeMcpHttpHealth,
  resolveConnectorsMcpHealthUrl,
  waitForJoshuMcpDependencies,
} from "./mcpDependencyHealth.js";
import { isJoshuMcpSupervisorEnabled, startJoshuMcpSupervisor } from "./mcpSupervisor.js";
import { startConnectorScheduler } from "./connectors/scheduler.js";
import { isComposioEnabled, syncComposioHermesMcp } from "./composioApi.js";
import { registerVoiceWebRoutes } from "./voiceWebApi.js";
import { createTwilioUpgradeHandler, registerTwilioVoiceRoutes } from "./twilioPhoneGateway.js";
import { registerAgUiRoutes } from "./agUiApi.js";
import { registerAppInvokeRoutes } from "./appInvokeApi.js";
import { registerHindsightRecallRoute } from "./hindsightRecallApi.js";
import type { CreateRunRequest, CreateRunResponse, RunRecord, StatusReport } from "./types.js";

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

/** CAMOFOX_START_URL — http(s) or about:blank. Never coerce about:blank → news.google. */
function normalizeHttpUrl(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === "about:blank") return "about:blank";
  if (lower === "about:home") return "about:home";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return parsed.toString();
  } catch {
    // Prefer blank over a surprise News navigation when env is malformed.
    return "about:blank";
  }
}

function isBlankBrowserUrl(url: string | undefined): boolean {
  const value = (url ?? "").trim().toLowerCase();
  return !value || value === "about:blank" || value === "about:home";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function novncPathFilter(clientPath: string, proxyPath: string): (pathname: string) => boolean {
  const prefixes = new Set<string>();
  for (const p of [clientPath, proxyPath]) {
    const normalized = (p.startsWith("/") ? p : `/${p}`).replace(/\/+$/, "") || "/";
    if (normalized !== "/") prefixes.add(normalized);
  }
  return (pathname) => [...prefixes].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Forward /joshu/novnc/websockify → /websockify on Camofox :6080 (bypasses http-proxy-middleware WS quirks). */
function handleNovncUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  proxy: httpProxy,
  clientPath: string,
  proxyPath: string,
): boolean {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  for (const prefix of [clientPath, proxyPath]) {
    if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
      const rest = url.pathname.slice(prefix.length) || "/";
      req.url = (rest.startsWith("/") ? rest : `/${rest}`) + url.search;
      stripWsCompressionHeaders(req);
      proxy.ws(req, socket, head);
      return true;
    }
  }
  return false;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBrowserSyncMode(value: unknown): BrowserSyncMode | undefined {
  if (typeof value !== "string") return undefined;
  const mode = value.trim().toLowerCase();
  if (mode === "auto" || mode === "off" || mode === "light" || mode === "full") return mode;
  return undefined;
}

/** Normalize chat TTS payload: invisible chars + NBSP so trim/JSON parity matches the Hermes Chat client. */
function normalizeTtsPayloadText(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHermesChatMessage(value: unknown): value is HermesChatMessage {
  if (!isRecord(value)) return false;
  if (value.role !== "system" && value.role !== "user" && value.role !== "assistant") return false;
  if (typeof value.content === "string") return true;
  if (!Array.isArray(value.content)) return false;
  return value.content.every((part) => {
    if (!isRecord(part) || typeof part.type !== "string") return false;
    if (part.type === "text") return typeof part.text === "string";
    if (part.type === "image_url") {
      return isRecord(part.image_url) && typeof part.image_url.url === "string" && part.image_url.url.startsWith("data:image/");
    }
    return false;
  });
}

/** When set (e.g. /joshu), all HTTP routes and noVNC are mounted under this prefix (ArozOS subservice). */
const PUBLIC_BASE_PATH = envOr("PUBLIC_BASE_PATH", "").replace(/\/+$/, "");

function withPublicBase(urlPath: string): string {
  const p = (urlPath.startsWith("/") ? urlPath : `/${urlPath}`).replace(/\/+$/, "") || "/";
  if (!PUBLIC_BASE_PATH) return p;
  const base = PUBLIC_BASE_PATH.replace(/\/+$/, "");
  // Env may already include the prefix (e.g. NOVNC_CLIENT_PATH=/joshu/novnc); do not double-prefix.
  if (p === base || p.startsWith(`${base}/`)) return p;
  return `${base}${p}`.replace(/\/+$/, "") || "/";
}

const PORT = Number(envOr("JOSHU_PORT", envOr("PORT", "8788")));
const HOST = envOr("HOST", "127.0.0.1");
const VOICE_REALTIME_TARGET = envOr("VOICE_REALTIME_URL", "http://127.0.0.1:8792").replace(/\/+$/, "");
const CAMOFOX_URL = envOr("CAMOFOX_URL", "http://localhost:9377");
const NOVNC_URL = envOr("NOVNC_URL", "http://localhost:6080");
const NOVNC_CLIENT_PATH = envOr("NOVNC_CLIENT_PATH", NOVNC_URL.startsWith("/") ? NOVNC_URL : "/novnc");
const NOVNC_PROXY_TARGET = envOr("NOVNC_PROXY_TARGET", NOVNC_URL.startsWith("/") ? "http://localhost:6080" : NOVNC_URL);
const HERMES_BIN = envOr("HERMES_BIN", "/Users/danbenyamin/Documents/dev/hermes-agent/venv/bin/hermes");
const HERMES_API_BASE_URL = envOr("HERMES_API_BASE_URL", "http://127.0.0.1:8642");
const HERMES_API_KEY = envOr("HERMES_API_KEY", "change-me-local-dev");
const HERMES_API_AUTO_START_ENV = envOr("HERMES_API_AUTO_START", "true") !== "false";
const JOSHU_DEFER_HERMES_GATEWAY_WARM = envOr("JOSHU_DEFER_HERMES_GATEWAY_WARM", "false") === "true";
const HITL_CAMOFOX_USER_ID = envOr("HITL_CAMOFOX_USER_ID", "hitl-camofox");
const HITL_CAMOFOX_SESSION_KEY = envOr("HITL_CAMOFOX_SESSION_KEY", "hitl-main");
const HITL_CAMOFOX_SINGLE_TAB = envOr("HITL_CAMOFOX_SINGLE_TAB", "true") !== "false";
const CAMOFOX_AUTO_RESTART = envOr("CAMOFOX_AUTO_RESTART", "true") !== "false";
const CAMOFOX_CONTAINER = envOr("CAMOFOX_CONTAINER", "camofox-hitl");
const DOCKER_BIN = envOr("DOCKER_BIN", "docker");
const CAMOFOX_RESTART_COOLDOWN_MS = Number(envOr("CAMOFOX_RESTART_COOLDOWN_MS", "15000"));
const CAMOFOX_VIEWPORT_WIDTH = Number(envOr("CAMOFOX_VIEWPORT_WIDTH", "1024"));
const CAMOFOX_VIEWPORT_HEIGHT = Number(envOr("CAMOFOX_VIEWPORT_HEIGHT", "768"));
const CAMOFOX_START_URL = normalizeHttpUrl(envOr("CAMOFOX_START_URL", "https://news.google.com/"));
const HINDSIGHT_API_URL = envOr("HINDSIGHT_API_URL", "http://127.0.0.1:8888").replace(/\/+$/, "");
const HINDSIGHT_BANK_ID = envOr("HINDSIGHT_BANK_ID", "joshu");
const HINDSIGHT_API_KEY = envOr("HINDSIGHT_API_KEY", "");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const HERMES_API_AUTO_START =
  readHermesGatewayPreference(PROJECT_ROOT) ?? HERMES_API_AUTO_START_ENV;
const PUBLIC_DIR = path.resolve(PROJECT_ROOT, "public");
const normalizedNovncProxyPath = (NOVNC_CLIENT_PATH.startsWith("/") ? NOVNC_CLIENT_PATH : `/${NOVNC_CLIENT_PATH}`).replace(/\/+$/, "") || "/";
const normalizedNovncClientPath = withPublicBase(NOVNC_CLIENT_PATH).replace(/\/+$/, "") || "/";

const runner = new HermesApiRunner({
  binary: HERMES_BIN,
  camofoxUrl: CAMOFOX_URL,
  apiBaseUrl: HERMES_API_BASE_URL,
  apiKey: HERMES_API_KEY,
  autoStartGateway: HERMES_API_AUTO_START,
  hitlCamofoxUserId: HITL_CAMOFOX_USER_ID,
  hitlCamofoxSessionKey: HITL_CAMOFOX_SESSION_KEY,
});

const camofoxSession = new CamofoxSessionCoordinator({
  camofoxUrl: CAMOFOX_URL,
  userId: HITL_CAMOFOX_USER_ID,
  sessionKey: HITL_CAMOFOX_SESSION_KEY,
  singleTab: HITL_CAMOFOX_SINGLE_TAB,
  viewportWidth: CAMOFOX_VIEWPORT_WIDTH,
  viewportHeight: CAMOFOX_VIEWPORT_HEIGHT,
});

const dockerSupervisor = new DockerSupervisor({
  dockerBin: DOCKER_BIN,
  containerName: CAMOFOX_CONTAINER,
  enabled: CAMOFOX_AUTO_RESTART,
  cooldownMs: CAMOFOX_RESTART_COOLDOWN_MS,
});

let lastCamofoxBootstrapAt = 0;

/** Open Google News (or CAMOFOX_START_URL) when Camofox has no tab or only a blank page. */
async function bootstrapCamofoxStartUrl(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastCamofoxBootstrapAt < 5_000) return;
  lastCamofoxBootstrapAt = now;

  try {
    const health = await fetch(`${CAMOFOX_URL.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!health.ok) return;

    // Retry once — a brief /tabs glitch must not treat a live session as missing
    // (ensureTab used to navigate existing tabs to CAMOFOX_START_URL).
    let tab = await camofoxSession.currentTab().catch(() => undefined);
    if (!tab) {
      tab = await camofoxSession.currentTab().catch(() => undefined);
    }
    // Camofox rejects about: tabs — never call ensureTab(about:blank). Leave an
    // existing blank alone; only create when missing and start URL is http(s).
    if (!tab) {
      if (isBlankBrowserUrl(CAMOFOX_START_URL)) {
        console.warn("[joshu] Camofox has no tab and CAMOFOX_START_URL is blank; skip create");
        return;
      }
      tab = await camofoxSession.ensureTab(CAMOFOX_START_URL);
      runner.rememberBrowserTarget(tab.url, HITL_CAMOFOX_USER_ID);
      console.log(`[joshu] Camofox opened start URL: ${tab.url}`);
    } else if (isBlankBrowserUrl(tab.url) && !isBlankBrowserUrl(CAMOFOX_START_URL)) {
      tab = await camofoxSession.ensureTab(CAMOFOX_START_URL);
      runner.rememberBrowserTarget(tab.url, HITL_CAMOFOX_USER_ID);
      console.log(`[joshu] Camofox opened start URL: ${tab.url}`);
    }
    await camofoxSession.fitViewport(tab.tabId).catch((err: Error) => {
      console.warn(`[joshu] Camofox viewport fit skipped: ${err.message}`);
    });
    const metrics = await camofoxSession.readViewportMetrics(tab.tabId);
    const targetW = CAMOFOX_VIEWPORT_WIDTH;
    const targetH = CAMOFOX_VIEWPORT_HEIGHT;
    if (metrics && Math.abs(metrics.innerWidth - targetW) > 8) {
      console.warn(
        `[joshu] Camofox layout width is ${metrics.innerWidth}px (expected ~${targetW}px). ` +
          `Recreate the Camofox container: bash scripts/ensure-camofox-container.sh`,
      );
    }
  } catch (err) {
    console.warn(`[joshu] Camofox start URL bootstrap skipped: ${(err as Error).message}`);
  }
}

/** Keep Joshu's Camofox view aligned with the single shared HITL tab Hermes should adopt. */
async function alignSharedBrowserTab(opts: { observe?: boolean } = {}): Promise<{
  tab?: Awaited<ReturnType<CamofoxSessionCoordinator["currentTab"]>>;
  observation?: Awaited<ReturnType<CamofoxSessionCoordinator["observe"]>>;
}> {
  const tab = await camofoxSession.enforceSingleTab().catch(() => undefined);
  if (!tab) return {};

  if (opts.observe) {
    const observation = await camofoxSession.observe(tab).catch((err: Error) => {
      console.warn(`[joshu] failed to observe shared Camofox tab: ${err.message}`);
      return undefined;
    });
    const url = observation?.url ?? tab.url;
    runner.rememberBrowserTarget(url, HITL_CAMOFOX_USER_ID);
    return {
      tab: observation?.tab ?? { ...tab, url },
      observation,
    };
  }

  runner.rememberBrowserTarget(tab.url, HITL_CAMOFOX_USER_ID);
  return { tab };
}

function hindsightHeaders(): Record<string, string> {
  return HINDSIGHT_API_KEY ? { Authorization: `Bearer ${HINDSIGHT_API_KEY}` } : {};
}

function addQueryIfPresent(target: URLSearchParams, source: Request["query"], name: string): void {
  const value = source[name];
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string" && first.trim()) target.set(name, first.trim());
}

async function proxyHindsightJson(pathname: string, query = new URLSearchParams()): Promise<{ status: number; body: unknown }> {
  const url = new URL(pathname, `${HINDSIGHT_API_URL}/`);
  for (const [key, value] of query) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: hindsightHeaders(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { status: response.status, body: { error: "Hindsight request failed", upstreamStatus: response.status, upstreamBody: body } };
  }

  return { status: 200, body: await response.json() };
}

function buildAppRouter(): {
  router: Router;
  novncProxy: ReturnType<typeof createProxyMiddleware> | undefined;
  hermesDashboardProxy:
    | (ReturnType<typeof createProxyMiddleware> & {
        upgrade?: (req: unknown, socket: unknown, head: unknown) => void;
      })
    | undefined;
} {
  const router = express.Router();
  router.use(morgan("dev"));

  registerTwilioVoiceRoutes(router, runner, PUBLIC_BASE_PATH);

  registerBrainRoutes(router);
  registerFilesRoutes(router);
  // Share-chat JSON routes register after express.json() below.

  registerInstanceHealthRoutes(router, {
    probeHermes: async () => {
      const running = await runner.probeGatewayHealth();
      if (!runner.isAutoStartGateway() && !running) {
        return { available: true };
      }
      return { available: running };
    },
    probeCamofox: async () => {
      try {
        const health = await fetch(`${CAMOFOX_URL.replace(/\/+$/, "")}/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        return { reachable: health.ok };
      } catch {
        return { reachable: false };
      }
    },
    probeHindsight: async () => {
      if (envOr("JOSHU_HINDSIGHT_ENABLED", "auto") === "false") return { ok: true };
      try {
        const url = new URL("/health", `${HINDSIGHT_API_URL}/`);
        const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        return { ok: res.ok };
      } catch {
        return { ok: false };
      }
    },
    probeGbrain: probeGbrainHealth,
    probeConnectorsMcp: async () => {
      const ok = await probeMcpHttpHealth(resolveConnectorsMcpHealthUrl());
      return { ok };
    },
    connectorsMcpRequired: isConnectorsMcpRequiredForHealth(),
    probeTwilio: async () => {
      if (!process.env.TWILIO_AUTH_TOKEN?.trim()) return { ok: true };
      const available = await runner.probeGatewayHealth();
      return { ok: available };
    },
  });

  // Raw body routes must register before express.json().
  registerShareChatSlackEventsRoute(router);
  registerShareChatComposioTriggersRoute(router);
  router.post("/api/hermes-chat/transcribe", express.raw({ limit: "15mb", type: "*/*" }), async (req: Request, res: Response) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: "Expected raw audio body (WAV)" });
    }

    let tmpDir: string | undefined;
    try {
      tmpDir = await mkdtemp(path.join(tmpdir(), "joshu-stt-"));
      const wavPath = path.join(tmpDir, "clip.wav");
      await writeFile(wavPath, body);

      const { stdout, stderr, code } = await spawnHermesPython("hermes-chat-transcribe.py", [wavPath]);
      const trimmed = stdout.trim();
      const lastLine = trimmed.split("\n").pop() ?? trimmed;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(lastLine) as Record<string, unknown>;
      } catch {
        console.warn("[joshu] transcribe JSON parse failed:", lastLine.slice(0, 500), stderr);
        return res.status(502).json({
          error: "Hermes transcribe produced invalid JSON",
          stderr: stderr.slice(0, 2000),
          exitCode: code,
        });
      }

      if (!parsed.success) {
        return res.status(502).json({
          success: false,
          transcript: "",
          error: typeof parsed.error === "string" ? parsed.error : "Transcription failed",
        });
      }

      res.json({
        success: true,
        transcript: typeof parsed.transcript === "string" ? parsed.transcript : "",
        provider: parsed.provider,
      });
    } catch (error) {
      console.warn("[joshu] transcribe error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  router.use(express.json({ limit: "12mb" }));

  registerShareChatRoutes(router);

  registerDesktopActionRoutes(router);
  registerAppGuiActionRoutes(router, PROJECT_ROOT);

  registerBoxStateRoutes(router, {
    onHardResetComplete: () => runner.resyncHermesAfterBoxHardReset(),
  });
  registerOnboardingRoutes(router, { projectRoot: PROJECT_ROOT });
  registerBoxSecretsRoutes(router, { projectRoot: PROJECT_ROOT, runner });
  registerDay0Routes(router, { projectRoot: PROJECT_ROOT });

  registerHermesCronRoutes(router);
  registerNylasRoutes(router, { projectRoot: PROJECT_ROOT });
  registerComposioRoutes(router, { projectRoot: PROJECT_ROOT, runner });
  registerConnectorComposioRoutes(router, { projectRoot: PROJECT_ROOT, runner });
  registerConnectorRoutes(router, { projectRoot: PROJECT_ROOT, runner });
  registerEaTriageRoutes(router, { projectRoot: PROJECT_ROOT });
  registerSafetySettingsRoutes(router, { projectRoot: PROJECT_ROOT, hermesBinary: HERMES_BIN, runner });
  registerOwnerChannelRoutes(router, { projectRoot: PROJECT_ROOT });
  registerActionGuardRoutes(router, { projectRoot: PROJECT_ROOT });
  registerVoiceWebRoutes(router);

  const joshuApiBase = `http://127.0.0.1:${PORT}${withPublicBase("/api")}`;
  registerAppInvokeRoutes(router, PROJECT_ROOT, joshuApiBase);
  registerAgUiRoutes(router, runner, PROJECT_ROOT);

  registerMovieEditorRoutes(router);

  router.get("/api/hermes-chat/voice-settings", async (_req: Request, res: Response) => {
    try {
      const cfgPath = path.join(getHermesHomeDir(), "config.yaml");
      const raw = await readFile(cfgPath, "utf8").catch(() => "");
      let silenceThreshold = 200;
      let silenceDurationSec = 3;
      if (raw.trim()) {
        try {
          const doc = YAML.parse(raw) as Record<string, unknown> | null | undefined;
          const voice = doc?.voice;
          if (voice && typeof voice === "object" && !Array.isArray(voice)) {
            const v = voice as Record<string, unknown>;
            const st = v.silence_threshold;
            const sd = v.silence_duration;
            if (typeof st === "number" && !Number.isNaN(st)) silenceThreshold = st;
            if (typeof sd === "number" && !Number.isNaN(sd)) silenceDurationSec = sd;
          }
        } catch {
          /* ignore malformed YAML */
        }
      }
      res.json({ ok: true, silenceThreshold, silenceDurationSec });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/hermes-chat/tts", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { text?: unknown };
    const rawText = typeof body.text === "string" ? body.text : "";
    const payloadText = normalizeTtsPayloadText(rawText);
    if (!payloadText) {
      // Container/platform logs often capture stdout only; use console.info for visibility.
      console.info("[joshu] tts: missing or empty text", {
        contentType: req.headers["content-type"],
        typeofText: typeof (body as { text?: unknown }).text,
        bodyKeys: body && typeof body === "object" ? Object.keys(body as object) : [],
        rawLength: typeof body.text === "string" ? body.text.length : 0,
      });
      return res.status(400).json({ error: "text is required" });
    }
    if (payloadText.length > 32000) {
      return res.status(400).json({ error: "text too long (max 32000 chars)" });
    }

    try {
      const { stdout, stderr, code } = await spawnHermesPython("hermes-chat-tts.py", [], payloadText);
      const trimmed = stdout.trim();
      const lastLine = trimmed.split("\n").pop() ?? trimmed;

      let meta: { success?: boolean; file_path?: string; error?: string };
      try {
        meta = JSON.parse(lastLine) as { success?: boolean; file_path?: string; error?: string };
      } catch {
        console.warn("[joshu] tts JSON parse failed:", lastLine.slice(0, 500), stderr);
        return res.status(502).json({
          error: "Hermes TTS produced invalid JSON",
          stderr: stderr.slice(0, 2000),
          exitCode: code,
        });
      }

      if (!meta.success || !meta.file_path) {
        return res.status(502).json({ error: meta.error || "TTS generation failed" });
      }

      const audioBuf = await readFile(meta.file_path);
      await rm(meta.file_path, { force: true }).catch(() => undefined);

      res.setHeader("Content-Type", audioMimeForPath(meta.file_path));
      res.send(audioBuf);
    } catch (error) {
      console.warn("[joshu] tts error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  const novncProxy = (
    normalizedNovncProxyPath.startsWith("/")
      ? createProxyMiddleware({
          target: NOVNC_PROXY_TARGET,
          changeOrigin: true,
          ws: false,
          pathFilter: novncPathFilter(normalizedNovncClientPath, normalizedNovncProxyPath),
          pathRewrite: {
            [`^${escapeRegExp(normalizedNovncClientPath)}`]: "",
            [`^${escapeRegExp(normalizedNovncProxyPath)}`]: "",
          },
        })
      : undefined
  ) as ReturnType<typeof createProxyMiddleware> | undefined;

  const hermesDashboardProxy = registerHermesDashboardRoutes(router, {
    proxyPath: hermesDashboardPathSegment(),
    publicBasePath: PUBLIC_BASE_PATH,
  });

  router.use(express.static(PUBLIC_DIR, {
    etag: false,
    extensions: ["html"],
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store");
    },
  }));

  router.get("/api/status", async (_req: Request, res: Response) => {
    let [hermes, cam, docker] = await Promise.all([
      runner.probe(),
      getCamofoxStatus({
        camofoxUrl: CAMOFOX_URL,
        novncUrl: NOVNC_URL,
        novncClientUrl: normalizedNovncClientPath,
        appBasePath: PUBLIC_BASE_PATH || "/",
      }),
      dockerSupervisor.report(),
    ]);

    if (!cam.camofox.reachable && dockerSupervisor.enabled) {
      docker = await dockerSupervisor.ensureRunning("camofox health probe failed");
      cam = await getCamofoxStatus({
        camofoxUrl: CAMOFOX_URL,
        novncUrl: NOVNC_URL,
        novncClientUrl: normalizedNovncClientPath,
        appBasePath: PUBLIC_BASE_PATH || "/",
        timeoutMs: 5_000,
      });
    }

    // Do not bootstrap on status poll — every 8s from jWeb was treating blank/proxy
    // errors as a cue to ensureTab(START_URL) and fought mid-flow Slack work.
    // Bootstrap only on boot / fit-viewport / explicit restart (force=true callers).
    const currentTab = await camofoxSession.currentTab().catch(() => undefined);
    if (currentTab) {
      runner.rememberBrowserTarget(currentTab.url, HITL_CAMOFOX_USER_ID);
    }

    const report: StatusReport = {
      hermes: { available: hermes.available, binary: HERMES_BIN, version: hermes.version, error: hermes.error },
      camofox: cam.camofox,
      docker,
      novnc: cam.novnc,
      browserViewport: { width: CAMOFOX_VIEWPORT_WIDTH, height: CAMOFOX_VIEWPORT_HEIGHT },
      activeSessionId: runner.getActiveSessionId(),
      lastBrowserUrl: runner.getLastBrowserUrl(),
      lastCamofoxUserId: runner.getLastCamofoxUserId() ?? HITL_CAMOFOX_USER_ID,
    };
    res.json(report);
  });

  router.post("/api/camofox/restart", async (_req: Request, res: Response) => {
    const docker = await dockerSupervisor.restart("manual API request");
    const cam = await getCamofoxStatus({
      camofoxUrl: CAMOFOX_URL,
      novncUrl: NOVNC_URL,
      novncClientUrl: normalizedNovncClientPath,
      appBasePath: PUBLIC_BASE_PATH || "/",
      timeoutMs: 5_000,
    });
    await bootstrapCamofoxStartUrl(true);
    res.json({ docker, camofox: cam.camofox, novnc: cam.novnc });
  });

  router.post("/api/camofox/sync", async (_req: Request, res: Response) => {
    try {
      await runner.ensureGatewayReady().catch(() => undefined);
      const priorUrl = runner.getLastBrowserUrl();
      const aligned = await alignSharedBrowserTab({ observe: true });
      const currentUrl = aligned.observation?.url ?? aligned.tab?.url;
      res.json({
        ok: true,
        tab: aligned.tab,
        currentUrl,
        priorUrl,
        urlChanged: Boolean(priorUrl && currentUrl && priorUrl !== currentUrl),
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post("/api/camofox/fit-viewport", async (_req: Request, res: Response) => {
    try {
      await bootstrapCamofoxStartUrl(true);
      let tab = (await alignSharedBrowserTab()).tab;
      if (!tab) {
        tab = await camofoxSession.ensureTab(CAMOFOX_START_URL);
        runner.rememberBrowserTarget(tab.url, HITL_CAMOFOX_USER_ID);
      }
      await camofoxSession.fitViewport(tab.tabId);
      const metrics = await camofoxSession.readViewportMetrics(tab.tabId);
      res.json({
        ok: true,
        width: CAMOFOX_VIEWPORT_WIDTH,
        height: CAMOFOX_VIEWPORT_HEIGHT,
        tab,
        metrics,
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post("/api/camofox/shim", async (_req: Request, res: Response) => {
    const { tab } = await alignSharedBrowserTab();
    res.json({ ok: true, tab });
  });

  /** Paste/type into the focused Camofox page control via Playwright (correct braces/JSON). */
  router.post("/api/camofox/insert-text", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { text?: unknown; selectAll?: unknown };
      const text = typeof body.text === "string" ? body.text : "";
      if (!text) return res.status(400).json({ error: "text is required" });
      const selectAll = body.selectAll !== false;
      await camofoxSession.insertText(text, { selectAll });
      const tab = await camofoxSession.currentTab().catch(() => undefined);
      res.json({ ok: true, chars: text.length, tab });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** Copy selection / focused Slack token from Camofox (bypasses broken VNC clipboard). */
  router.post("/api/camofox/copy-selection", async (_req: Request, res: Response) => {
    try {
      const text = await camofoxSession.readSelection();
      res.json({ ok: true, text, chars: text.length });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.post("/api/hermes/reset", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { purgeTabs?: boolean };
    await runner.reset();
    let closedTabs = 0;
    if (body.purgeTabs) {
      const before = await camofoxSession.listTabs().catch(() => []);
      await camofoxSession.closeAllTabs().catch(() => undefined);
      closedTabs = before.length;
    }
    res.json({ ok: true, closedTabs });
  });

  router.get("/api/hermes/gateway", async (_req: Request, res: Response) => {
    try {
      const status = await runner.getGatewayStatus();
      res.json({ ok: true, ...status, apiBaseUrl: HERMES_API_BASE_URL });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post("/api/hermes/gateway", async (req: Request, res: Response) => {
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled (boolean) is required" });
      return;
    }
    try {
      writeHermesGatewayPreference(PROJECT_ROOT, enabled);
      const status = await runner.setGatewayEnabled(enabled);
      res.json({ ok: true, ...status, apiBaseUrl: HERMES_API_BASE_URL });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/api/hermes-chat/status", async (req: Request, res: Response) => {
    try {
      if (isComposioEnabled()) {
        await syncComposioHermesMcp(PROJECT_ROOT).catch((err) => {
          console.warn(`[composio] startup sync skipped: ${(err as Error).message}`);
        });
      }
      if (req.query.after_mcp_boot === "1") {
        await runner.prepareGatewayAfterMcpBoot();
      } else {
        await runner.ensureGatewayReady();
      }
      res.json({
        ok: true,
        apiBaseUrl: HERMES_API_BASE_URL,
        composio: { enabled: isComposioEnabled() },
      });
    } catch (error) {
      res.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/hermes-chat/sessions", async (req: Request, res: Response) => {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 80) : 40;
    try {
      await runner.ensureGatewayReady().catch(() => undefined);
      const { listJchatHermesSessions } = await import("./hermesChatSessions.js");
      const sessions = await listJchatHermesSessions(limit);
      res.json({ ok: true, sessions });
    } catch (error) {
      res.status(503).json({
        ok: false,
        sessions: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/api/hermes-chat/sessions/:sessionId/messages", async (req: Request, res: Response) => {
    const sessionId = readString(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    try {
      await runner.ensureGatewayReady().catch(() => undefined);
      const { loadJchatSessionMessages } = await import("./hermesChatSessions.js");
      const payload = await loadJchatSessionMessages(sessionId);
      res.json({ ok: true, ...payload });
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/api/hindsight/status", async (_req: Request, res: Response) => {
    try {
      const health = await proxyHindsightJson("health");
      res.status(health.status).json({
        ok: health.status >= 200 && health.status < 300,
        bankId: HINDSIGHT_BANK_ID,
        apiUrl: HINDSIGHT_API_URL,
        health: health.body,
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        bankId: HINDSIGHT_BANK_ID,
        apiUrl: HINDSIGHT_API_URL,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerHindsightRecallRoute(router, {
    hindsightApiUrl: HINDSIGHT_API_URL,
    hindsightApiKey: HINDSIGHT_API_KEY,
    bankId: HINDSIGHT_BANK_ID,
    proxyHindsightJson,
  });

  router.get("/api/hindsight/graph/:kind", async (req: Request, res: Response) => {
    const kind = req.params.kind;
    const query = new URLSearchParams();
    const bankId = encodeURIComponent(HINDSIGHT_BANK_ID);
    let path: string;

    if (kind === "constellation") {
      path = `v1/default/banks/${bankId}/graph`;
      for (const name of ["limit", "type", "q", "tags", "tags_match", "document_id", "chunk_id"]) {
        addQueryIfPresent(query, req.query, name);
      }
    } else if (kind === "cooccurrence") {
      path = `v1/default/banks/${bankId}/entities/graph`;
      for (const name of ["limit", "min_count"]) {
        addQueryIfPresent(query, req.query, name);
      }
    } else {
      return res.status(400).json({ error: "kind must be constellation or cooccurrence" });
    }

    try {
      const upstream = await proxyHindsightJson(path, query);
      res.status(upstream.status).json(upstream.body);
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/hermes-chat/stream", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      sessionId?: unknown;
      model?: unknown;
      messages?: unknown;
      browserSync?: unknown;
    };
    const sessionId = readString(body.sessionId);
    const model = readString(body.model);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const browserSyncOverride = readBrowserSyncMode(body.browserSync);

    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    if (messages.length === 0 || !messages.every(isHermesChatMessage)) {
      return res.status(400).json({ error: "messages must contain valid Hermes chat messages" });
    }

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const controller = new AbortController();
    res.on("close", () => controller.abort());

    try {
      sseSend(res, "status", { status: "running" });
      if (isComposioEnabled()) {
        await syncComposioHermesMcp(PROJECT_ROOT).catch(() => undefined);
      }
      await runner.ensureGatewayReady().catch(() => undefined);
      const priorUrl = runner.getLastBrowserUrl();
      const aligned = await alignSharedBrowserTab({ observe: false });
      const tab = aligned.tab;
      const currentUrl = tab?.url;
      const syncMode = browserSyncOverride ?? browserSyncModeFromEnv();
      const syncLevel = resolveBrowserSyncLevel({
        userText: extractLastUserMessageText(messages),
        priorUrl,
        currentUrl,
        hasTab: Boolean(tab),
        mode: syncMode,
      });

      let browserObservation: string | undefined;
      if (syncLevel === "full" && tab) {
        const observation = await camofoxSession.observe(tab).catch((err: Error) => {
          console.warn(`[joshu] hermes-chat browser observe failed: ${err.message}`);
          return undefined;
        });
        if (observation) {
          const url = observation.url ?? observation.tab.url;
          runner.rememberBrowserTarget(url, HITL_CAMOFOX_USER_ID);
          browserObservation = formatBrowserObservation(observation);
        }
      } else if (currentUrl) {
        runner.rememberBrowserTarget(currentUrl, HITL_CAMOFOX_USER_ID);
      }

      const browserContext =
        syncLevel === "off"
          ? null
          : buildBrowserSyncSystemMessage({
              level: syncLevel,
              currentUrl: currentUrl ?? tab?.url,
              title: tab?.title,
              browserObservation,
              priorUrl,
            });

      const turnSystemMessages = buildTurnSystemMessages(PROJECT_ROOT, { browser: browserContext });

      let activeSessionId = sessionId;

      const result = await runner.streamHermesChat(
        {
          sessionId,
          model: model || undefined,
          messages: [...turnSystemMessages, ...messages],
          signal: controller.signal,
        },
        {
          onSession: (nextSessionId) => {
            activeSessionId = nextSessionId;
            sseSend(res, "session", { sessionId: nextSessionId });
          },
          onDelta: (text) => sseSend(res, "delta", { text }),
          onReasoning: (text) => sseSend(res, "reasoning", { text }),
          onTool: (tool) => {
            sseSend(res, "tool", tool);
            const toolName = tool.tool?.replace(/^.*\./, "") ?? "";
            if (toolName === "desktop_open" && tool.status === "completed") {
              let actions = drainDesktopActionsForChat(activeSessionId);
              if (actions.length === 0) {
                const fromTool = desktopActionFromHermesToolRaw(tool.raw);
                if (fromTool) actions = [fromTool];
              }
              for (const action of actions) {
                sseSend(res, "desktop_action", { action });
              }
            }
          },
        },
      );
      const actions = drainDesktopActionsForChat(activeSessionId);
      for (const action of actions) {
        sseSend(res, "desktop_action", { action });
      }
      sseSend(res, "done", result);
    } catch (error) {
      if (!controller.signal.aborted) {
        sseSend(res, "error", { error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      res.end();
    }
  });

  router.post("/api/runs", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<CreateRunRequest>;
    const prompt = (body.prompt ?? "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    let initialUrl: string | undefined;
    if (body.initialUrl?.trim()) {
      try {
        initialUrl = new URL(body.initialUrl.trim()).toString();
      } catch {
        return res.status(400).json({ error: `initialUrl is not a valid URL: ${body.initialUrl}` });
      }
    }

    let currentUrl: string | undefined;
    let browserObservation: string | undefined;
    const priorUrl = runner.getLastBrowserUrl();

    // Hermes must adopt the same tab the user sees in noVNC — enforce single-tab
    // and snapshot the live page before composing the run prompt.
    await runner.ensureGatewayReady().catch(() => undefined);

    if (initialUrl) {
      // Explicit run initialUrl — allowed to replace the current page.
      const tab = await camofoxSession.ensureTab(initialUrl, { navigateExisting: true });
      const observation = await camofoxSession.observe(tab).catch((err: Error) => {
        console.warn(`[joshu] failed to observe Camofox tab after initialUrl: ${err.message}`);
        return undefined;
      });
      currentUrl = observation?.url ?? tab.url;
      browserObservation = observation ? formatBrowserObservation(observation) : undefined;
      runner.rememberBrowserTarget(currentUrl, HITL_CAMOFOX_USER_ID);
    } else {
      const aligned = await alignSharedBrowserTab({ observe: true });
      currentUrl = aligned.observation?.url ?? aligned.tab?.url;
      browserObservation = aligned.observation ? formatBrowserObservation(aligned.observation) : undefined;
    }

    const browserUrlChanged = Boolean(priorUrl && currentUrl && priorUrl !== currentUrl);

    const record = runner.startRun({
      prompt,
      initialUrl,
      currentUrl,
      browserObservation,
      browserUrlChanged,
      conversationId: body.conversationId,
    });
    const out: CreateRunResponse = { runId: record.id };
    res.status(202).json(out);
  });

  router.get("/api/runs", (_req: Request, res: Response) => {
    res.json({ runs: runner.listRuns().map(summarize) });
  });

  router.get("/api/runs/:id", (req: Request, res: Response) => {
    const run = runner.getRun(req.params.id ?? "");
    if (!run) return res.status(404).json({ error: "run not found" });
    res.json(run);
  });

  router.post("/api/runs/:id/cancel", (req: Request, res: Response) => {
    const ok = runner.cancelRun(req.params.id ?? "");
    if (!ok) return res.status(404).json({ error: "run not found or already finished" });
    res.json({ ok: true });
  });

  router.get("/api/runs/:id/events", (req: Request, res: Response) => {
    const run = runner.getRun(req.params.id ?? "");
    if (!run) return res.status(404).end();

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    for (const event of run.events) sseSend(res, "log", event);
    sseSend(res, "status", { status: run.status });

    if (isTerminal(run.status)) {
      sseSend(res, "final", summarize(run));
      res.end();
      return;
    }

    const onEvent = (payload: { runId: string; event: unknown }): void => {
      if (payload.runId === run.id) sseSend(res, "log", payload.event);
    };
    const onStatus = (payload: { runId: string; status: string }): void => {
      if (payload.runId !== run.id) return;
      sseSend(res, "status", { status: payload.status });
      if (isTerminal(payload.status)) {
        void camofoxSession.enforceSingleTab().catch((err: Error) => {
          console.warn(`[joshu] post-run single-tab cleanup failed: ${err.message}`);
        });
        const fresh = runner.getRun(run.id);
        if (fresh) sseSend(res, "final", summarize(fresh));
        res.end();
      }
    };

    runner.on("event", onEvent);
    runner.on("status", onStatus);
    req.on("close", () => {
      runner.off("event", onEvent);
      runner.off("status", onStatus);
    });
  });

  return { router, novncProxy, hermesDashboardProxy };
}

const { router: appRouter, novncProxy, hermesDashboardProxy } = buildAppRouter();

const novncWsProxy = httpProxy.createProxyServer({
  target: NOVNC_PROXY_TARGET,
  ws: true,
  changeOrigin: true,
});
novncWsProxy.on("proxyReqWs", (proxyReq) => {
  proxyReq.removeHeader("sec-websocket-extensions");
});
novncWsProxy.on("error", (err, _req, socket) => {
  console.warn("[joshu] noVNC websocket proxy error:", err.message);
  if (socket && !socket.destroyed) socket.destroy();
});

function stripWsCompressionHeaders(req: IncomingMessage): void {
  delete req.headers["sec-websocket-extensions"];
}

function voiceRtPathFilter(publicBasePath: string): (pathname: string) => boolean {
  const prefixes = ["/voice-rt"];
  if (publicBasePath) {
    prefixes.push(`${publicBasePath.replace(/\/+$/, "")}/voice-rt`);
  }
  return (pathname) => prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Forward /voice-rt/* to packages/voice-realtime (local ngrok can use Joshu :8788 only). */
const voiceRealtimeProxy = createProxyMiddleware({
  target: VOICE_REALTIME_TARGET,
  changeOrigin: true,
  ws: true,
  pathFilter: voiceRtPathFilter(PUBLIC_BASE_PATH),
  on: {
    // Browser negotiates permessage-deflate with Joshu; forwarding it breaks frames (RSV1 / WS 1002).
    proxyReqWs: (proxyReq) => {
      proxyReq.removeHeader("sec-websocket-extensions");
    },
  },
}) as ReturnType<typeof createProxyMiddleware> & {
  upgrade?: (req: unknown, socket: unknown, head: unknown) => void;
};

const app = express();
app.use("/voice-rt", voiceRealtimeProxy);
if (novncProxy) {
  // Do not use app.use(prefix, proxy): Express strips the prefix on HTTP, which breaks
  // pathFilter/pathRewrite. Match the full browser path (/joshu/novnc/*) explicitly.
  const matchNovnc = novncPathFilter(normalizedNovncClientPath, normalizedNovncProxyPath);
  app.use((req, res, next) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (matchNovnc(pathname)) return novncProxy(req, res, next);
    next();
  });
}
if (PUBLIC_BASE_PATH) {
  app.use(`${PUBLIC_BASE_PATH}/voice-rt`, voiceRealtimeProxy);
  app.use(PUBLIC_BASE_PATH, appRouter);
  app.get("/", (_req: Request, res: Response) => {
    res.redirect(302, `${PUBLIC_BASE_PATH}/`);
  });
} else {
  app.use(appRouter);
}

function summarize(r: RunRecord): Omit<RunRecord, "events"> & { eventCount: number } {
  const { events, ...rest } = r;
  return { ...rest, eventCount: events.length };
}

function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function formatBrowserObservation(observation: Awaited<ReturnType<CamofoxSessionCoordinator["observe"]>>): string {
  return [
    `URL: ${observation.url ?? observation.tab.url}`,
    observation.title ? `Title: ${observation.title}` : undefined,
    typeof observation.refsCount === "number" ? `Element refs: ${observation.refsCount}` : undefined,
    "",
    observation.snapshot,
  ].filter((line): line is string => typeof line === "string").join("\n");
}

const server = app.listen(PORT, HOST, () => {
  console.log(
    `[joshu] listening on http://${HOST}:${PORT}\n` +
      `  PUBLIC_BASE_PATH=${PUBLIC_BASE_PATH || "(root)"}\n` +
      `  CAMOFOX_URL=${CAMOFOX_URL}\n` +
      `  CAMOFOX_START_URL=${CAMOFOX_START_URL}\n` +
      `  NOVNC_PROXY_PATH=${normalizedNovncProxyPath}\n` +
      `  NOVNC_CLIENT_PATH=${normalizedNovncClientPath} -> ${NOVNC_PROXY_TARGET}\n` +
      `  HERMES_BIN=${HERMES_BIN}`,
  );
  const companionSync = syncCompanionIdentityFromEnv(PROJECT_ROOT, { forceSoul: true });
  if (companionSync.identityWritten || companionSync.soulWritten || companionSync.hermesContextWritten) {
    console.log(
      `[joshu] companion identity synced identity=${companionSync.identityWritten} soul=${companionSync.soulWritten} hermesContext=${companionSync.hermesContextWritten}`,
    );
  }
  void bootstrapCamofoxStartUrl(true);
  void import("./shareChat/triggerSubscribe.js")
    .then(({ startShareChatSlackbotTriggerSubscribe }) =>
      startShareChatSlackbotTriggerSubscribe(PROJECT_ROOT),
    )
    .catch((err) => {
      console.warn(
        "[joshu] share-chat slackbot subscribe skipped:",
        err instanceof Error ? err.message : String(err),
      );
    });
  if (HERMES_API_AUTO_START) {
    if (JOSHU_DEFER_HERMES_GATEWAY_WARM) {
      console.log(
        "[joshu] Hermes gateway warm deferred until connectors MCP boot (vps-start after_mcp_boot nudge)",
      );
      runner.startMcpGatewayWatchdogOnly();
    } else {
      void (async () => {
        const mcpReady = await waitForJoshuMcpDependencies();
        if (!mcpReady.allReady) {
          console.warn(
            "[joshu] Hermes gateway warm delayed: MCP HTTP dependencies not fully healthy; watchdog will reload when ready",
          );
        }
        runner.warmGatewayInBackground();
      })();
    }
  }
  const connectorsCron = (process.env.JOSHU_CONNECTORS_CRON ?? "true").trim().toLowerCase();
  if (connectorsCron !== "false" && connectorsCron !== "0") {
    startConnectorScheduler(PROJECT_ROOT);
  }
  if (isJoshuMcpSupervisorEnabled()) {
    startJoshuMcpSupervisor({
      projectRoot: PROJECT_ROOT,
      onServiceRecovered: (label) => runner.nudgeGatewayAfterMcpRecovery(label),
    });
  }
});

// WebSocket upgrades: voice-realtime (/voice-rt), Twilio media, noVNC, Hermes dashboard.
const twilioUpgrade = createTwilioUpgradeHandler(PUBLIC_BASE_PATH, runner);
const hermesDashboardUpgradePrefixesList = hermesDashboardUpgradePrefixes(
  hermesDashboardProxyPath(PUBLIC_BASE_PATH),
  PUBLIC_BASE_PATH,
);

if (twilioUpgrade || voiceRealtimeProxy.upgrade || novncProxy || hermesDashboardProxy?.upgrade) {
  server.on("upgrade", (req, socket, head) => {
    const pathOnly = (req.url ?? "").split("?")[0] ?? "";
    const voiceRtPrefixes = ["/voice-rt"];
    if (PUBLIC_BASE_PATH) {
      voiceRtPrefixes.push(`${PUBLIC_BASE_PATH}/voice-rt`);
    }
    if (voiceRtPrefixes.some((p) => pathOnly.startsWith(p)) && voiceRealtimeProxy.upgrade) {
      stripWsCompressionHeaders(req);
      voiceRealtimeProxy.upgrade(req, socket, head);
      return;
    }
    if (pathOnly.startsWith("/voice-rt") && voiceRealtimeProxy.upgrade) {
      stripWsCompressionHeaders(req);
      voiceRealtimeProxy.upgrade(req, socket, head);
      return;
    }
    if (twilioUpgrade?.(req, socket as Duplex, head)) return;
    if (handleNovncUpgrade(req, socket as Duplex, head as Buffer, novncWsProxy, normalizedNovncClientPath, normalizedNovncProxyPath)) {
      return;
    }
    if (
      handleHermesDashboardUpgrade(
        req,
        socket as Duplex,
        head as Buffer,
        hermesDashboardProxy,
        hermesDashboardUpgradePrefixesList,
      )
    ) {
      return;
    }
  });
}
