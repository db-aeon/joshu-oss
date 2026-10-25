/**
 * Composio tool-router sessions for jChat: OAuth connections + Hermes MCP exposure.
 * @see https://docs.composio.dev/docs/configuring-sessions.md
 * @see https://docs.composio.dev/cookbooks/app-connections-dashboard.md
 */

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { composioClient } from "./connectors/composio/client.js";
import { listActiveConnectedAccounts } from "./connectors/composio/connectedAccountsList.js";
import { resolveJoshuFilesPaths } from "./joshuFilesPaths.js";
import { joshuConfigDir } from "./nylas/paths.js";
import { applyComposioMcpToHermesConfig, type ComposioMcpEndpoint } from "./hermesApi.js";
import {
  composioCustomAuthSetupMessage,
  composioToolkitAuthConfigId,
  composioToolkitNeedsCustomAuth,
  formatComposioConnectError,
  resolveComposioToolkitAuthConfigs,
  ComposioSlackbotSetupRequiredError,
} from "./composioAuthConfigs.js";

const DEFAULT_FEATURED_TOOLKITS = [
  "gmail",
  "github",
  "slack",
  "slackbot",
  "notion",
  "googlecalendar",
  "googledrive",
  "onenote",
  "linear",
  "hubspot",
  "outlook",
  "dropbox",
];

export type ComposioConnectedAccountSummary = {
  connectedAccountId: string;
  label?: string;
};

export type ComposioToolkitRow = {
  slug: string;
  name: string;
  logo?: string;
  isConnected: boolean;
  /** First connected account — kept for single-account UIs. */
  connectedAccountId?: string;
  connectedAccounts: ComposioConnectedAccountSummary[];
};

const CONNECTED_ACCOUNTS_CACHE_MS = 20_000;
const TOOLKIT_LIST_CACHE_MS = 45_000;

let connectedAccountsCache:
  | { userId: string; at: number; map: Map<string, ComposioConnectedAccountSummary[]> }
  | null = null;
const toolkitListCache = new Map<
  string,
  { at: number; data: { toolkits: ComposioToolkitRow[]; cursor?: string } }
>();

/** Bust in-memory list caches after connect/disconnect/sync. */
export function invalidateComposioToolkitCache(): void {
  connectedAccountsCache = null;
  toolkitListCache.clear();
}

async function listConnectedAccountsByToolkit(
  projectRoot: string,
): Promise<Map<string, ComposioConnectedAccountSummary[]>> {
  const userId = resolveComposioUserId(projectRoot);
  const now = Date.now();
  if (
    connectedAccountsCache &&
    connectedAccountsCache.userId === userId &&
    now - connectedAccountsCache.at < CONNECTED_ACCOUNTS_CACHE_MS
  ) {
    return connectedAccountsCache.map;
  }

  const items = await listActiveConnectedAccounts({ userIds: [userId] });
  const byToolkit = new Map<string, ComposioConnectedAccountSummary[]>();

  for (const row of items) {
    const slug = row.toolkit?.slug?.toLowerCase() ?? row.appUniqueId?.toLowerCase() ?? "";
    if (!slug) continue;
    const list = byToolkit.get(slug) ?? [];
    list.push({
      connectedAccountId: row.id,
      label: row.appName?.trim() || undefined,
    });
    byToolkit.set(slug, list);
  }

  connectedAccountsCache = { userId, at: now, map: byToolkit };
  return byToolkit;
}

/** Read persisted session id without Hermes MCP side effects (listing must stay fast). */
async function resolveComposioSessionId(projectRoot: string): Promise<string> {
  const userId = resolveComposioUserId(projectRoot);
  const existing = await readStore(projectRoot);
  if (existing?.sessionId && existing.userId === userId) {
    return existing.sessionId;
  }
  const created = await getOrCreateComposioSession(projectRoot);
  return created.sessionId;
}

type ComposioStore = {
  userId: string;
  sessionId: string;
  mcp?: ComposioMcpEndpoint;
  /** Auth configs last sent to this session (stable key), so a restart does not update again. */
  authConfigsKey?: string;
  /** True once the Composio workbench is off on this session (new sessions start with it off). */
  workbenchOff?: boolean;
  /** The read session of the same user: read-only tools and the Composio workbench on. */
  readSession?: ComposioReadSession;
  updatedAt: string;
};

type ComposioReadSession = { sessionId: string; mcp: ComposioMcpEndpoint; authConfigsKey?: string };

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function isComposioEnabled(): boolean {
  return Boolean(envTrim("COMPOSIO_API_KEY"));
}

export function resolveComposioUserId(projectRoot = process.cwd()): string {
  // Per-box isolation: provision sets COMPOSIO_USER_ID=<customer-slug> while ArozOS login stays owner email.
  const explicit = envTrim("COMPOSIO_USER_ID");
  if (explicit) return explicit;
  const paths = resolveJoshuFilesPaths(projectRoot);
  if (paths?.arozUser) return paths.arozUser;
  const override = envTrim("JOSHU_AROZ_USER");
  if (override) return override;
  return "joshu-local";
}

function featuredToolkitSlugs(): string[] {
  const raw = envTrim("JOSHU_COMPOSIO_FEATURED_TOOLKITS");
  if (!raw) return DEFAULT_FEATURED_TOOLKITS;
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function storePath(projectRoot: string): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, "composio-session.json");
}

async function readStore(projectRoot: string): Promise<ComposioStore | null> {
  const file = storePath(projectRoot);
  if (!file) return null;
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as ComposioStore;
    if (typeof parsed.sessionId === "string" && typeof parsed.userId === "string") return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[composio] could not read store: ${(err as Error).message}`);
    }
  }
  return null;
}

async function writeStore(projectRoot: string, store: ComposioStore): Promise<void> {
  const file = storePath(projectRoot);
  if (!file) throw new Error("Could not resolve Joshu config dir for Composio session storage");
  await mkdir(path.dirname(file), { recursive: true });
  // Write a temp file and rename it, so a parallel reader never sees a half-written file.
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Upstream Composio cloud MCP endpoints (for guard proxy pass-through): the main session, and the
 * read session when it exists.
 */
export async function readComposioUpstreamMcp(
  projectRoot = process.cwd(),
): Promise<{ mcp: ComposioMcpEndpoint; readMcp: ComposioMcpEndpoint | null } | null> {
  const store = await readStore(projectRoot);
  const mcp = store?.mcp;
  if (!mcp?.url?.trim()) return null;
  const readMcp = store?.readSession?.mcp;
  return { mcp, readMcp: readMcp?.url?.trim() ? readMcp : null };
}

function mcpEndpointFromSession(session: { mcp: { type?: string; url: string; headers?: Record<string, string> } }): ComposioMcpEndpoint {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(session.mcp.headers ?? {})) {
    if (typeof value === "string" && value.length > 0) headers[key] = value;
  }
  return {
    url: session.mcp.url,
    headers,
    type: typeof session.mcp.type === "string" ? session.mcp.type : undefined,
    enabled: true,
  };
}

export function createSessionConfig(authConfigs: Record<string, string>): {
  manageConnections: { enable: boolean };
  workbench: { enable: boolean };
  authConfigs?: Record<string, string>;
} {
  return {
    manageConnections: { enable: true },
    workbench: { enable: false },
    ...(Object.keys(authConfigs).length > 0 ? { authConfigs } : {}),
  };
}

/**
 * The read session: the same Composio user, with only the tools that have the MCP hint
 * readOnlyHint, and the Composio workbench on with proxy execution off. Code in the workbench can
 * call only the tools of its own session, so it can read mail but not send, delete, or write.
 * Never add a per-toolkit enable or disable list here: Composio then skips the tag filter for
 * that toolkit.
 */
export function createReadSessionConfig(authConfigs: Record<string, string>): {
  manageConnections: { enable: boolean };
  tags: "readOnlyHint"[];
  workbench: { enable: boolean; enableProxyExecution: boolean };
  authConfigs?: Record<string, string>;
} {
  return {
    manageConnections: { enable: false },
    tags: ["readOnlyHint"],
    workbench: { enable: true, enableProxyExecution: false },
    ...(Object.keys(authConfigs).length > 0 ? { authConfigs } : {}),
  };
}

/** Same auth configs in any key order give the same key. */
function authConfigsKey(authConfigs: Record<string, string>): string {
  return JSON.stringify(Object.entries(authConfigs).sort(([a], [b]) => a.localeCompare(b)));
}

function composioErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") return status;
  const match = /^\s*(\d{3})\b/.exec(err instanceof Error ? err.message : String(err));
  return match ? Number(match[1]) : undefined;
}

/**
 * True only when Composio says the session does not exist. A 409 (config version conflict),
 * a 429 (rate limit), or a network error is not a reason to make a new session: each new
 * session makes more conflicts, and Composio rate-limits a project that makes too many.
 */
export function isComposioSessionNotFoundError(err: unknown): boolean {
  const status = composioErrorStatus(err);
  if (status === 404 || status === 410) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /session[^"]*not[ _]?found|SessionNotFound/i.test(msg);
}

export type ComposioSessionInfo = { userId: string; sessionId: string; mcp: ComposioMcpEndpoint };

type ComposioUsableSession = {
  sessionId?: string;
  mcp: { type?: string; url: string; headers?: Record<string, string> };
  update?: (config: ComposioSessionUpdate) => Promise<unknown>;
};

type ComposioSessionUpdate = { authConfigs?: Record<string, string>; workbench?: { enable: boolean } };

/** How long a process trusts its session before it checks the session with Composio again. */
const COMPOSIO_SESSION_TTL_MS = 10 * 60_000;

let sessionCache: { key: string; authKey: string; at: number; value: ComposioSessionInfo } | null = null;
let sessionInFlight: { key: string; authKey: string; promise: Promise<ComposioSessionInfo> } | null = null;

/** Forget the session of this process (after the store is cleared, and in tests). */
export function resetComposioSessionCache(): void {
  sessionCache = null;
  sessionInFlight = null;
}

/**
 * Send the auth configs, or turn the Composio workbench off, or both, in one session update.
 * On a 409, re-fetch the session and retry once.
 */
async function updateSession(
  sessionId: string,
  session: ComposioUsableSession,
  update: ComposioSessionUpdate,
): Promise<boolean> {
  if (typeof session.update !== "function") return false;
  try {
    await session.update(update);
    return true;
  } catch (err) {
    if (composioErrorStatus(err) !== 409) {
      console.warn(`[composio] session ${sessionId}: session update failed: ${(err as Error).message}`);
      return false;
    }
  }
  try {
    const fresh = (await composioClient().use(sessionId)) as ComposioUsableSession;
    if (typeof fresh.update !== "function") return false;
    await fresh.update(update);
    return true;
  } catch (err) {
    console.warn(`[composio] session ${sessionId}: session update failed after re-fetch: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Resume or create the read session. The read session gets changed auth configs in a session
 * update, like the main session. A failure leaves the main session working without the
 * Composio workbench.
 */
async function refreshComposioReadSession(
  existing: ComposioReadSession | undefined,
  userId: string,
  authConfigs: Record<string, string>,
  authKey: string,
): Promise<ComposioReadSession | undefined> {
  const composio = composioClient();
  try {
    if (existing?.sessionId) {
      let session: ComposioUsableSession | null = null;
      try {
        session = (await composio.use(existing.sessionId)) as ComposioUsableSession;
      } catch (err) {
        if (!isComposioSessionNotFoundError(err)) throw err;
        console.warn(`[composio] read session ${existing.sessionId} not found; creating a new one`);
      }
      if (session) {
        let appliedKey = existing.authConfigsKey;
        if (appliedKey !== authKey) {
          const needsUpdate = Object.keys(authConfigs).length > 0;
          if (!needsUpdate || (await updateSession(existing.sessionId, session, { authConfigs }))) appliedKey = authKey;
        }
        return { sessionId: existing.sessionId, mcp: mcpEndpointFromSession(session), authConfigsKey: appliedKey };
      }
    }
    const session = await composio.create(userId, createReadSessionConfig(authConfigs));
    return { sessionId: session.sessionId, mcp: mcpEndpointFromSession(session), authConfigsKey: authKey };
  } catch (err) {
    console.warn(`[composio] read session: ${(err as Error).message}`);
    return existing;
  }
}

async function refreshComposioSession(
  projectRoot: string,
  userId: string,
  authConfigs: Record<string, string>,
  authKey: string,
): Promise<ComposioSessionInfo> {
  const composio = composioClient();
  const existing = await readStore(projectRoot);
  const sameUser = existing?.userId === userId;
  let main: Pick<ComposioStore, "sessionId" | "mcp" | "authConfigsKey" | "workbenchOff"> | null = null;

  if (existing?.sessionId && sameUser) {
    let session: ComposioUsableSession | null = null;
    try {
      session = (await composio.use(existing.sessionId)) as ComposioUsableSession;
    } catch (err) {
      if (!isComposioSessionNotFoundError(err)) throw err;
      console.warn(`[composio] session ${existing.sessionId} not found; creating a new one: ${(err as Error).message}`);
    }
    if (session) {
      let appliedKey = existing.authConfigsKey;
      let workbenchOff = existing.workbenchOff === true;
      // A session made before the workbench was off gets it turned off once, in the same update.
      const update: ComposioSessionUpdate = {};
      if (appliedKey !== authKey && Object.keys(authConfigs).length > 0) update.authConfigs = authConfigs;
      if (!workbenchOff) update.workbench = { enable: false };
      const updated = Object.keys(update).length > 0 && (await updateSession(existing.sessionId, session, update));
      if (appliedKey !== authKey && (updated || !update.authConfigs)) appliedKey = authKey;
      if (updated) workbenchOff = true;
      main = { sessionId: existing.sessionId, mcp: mcpEndpointFromSession(session), authConfigsKey: appliedKey, workbenchOff };
    }
  }

  if (!main) {
    const session = await composio.create(userId, createSessionConfig(authConfigs));
    main = { sessionId: session.sessionId, mcp: mcpEndpointFromSession(session), authConfigsKey: authKey, workbenchOff: true };
  }

  const readSession = await refreshComposioReadSession(
    sameUser ? existing?.readSession : undefined,
    userId,
    authConfigs,
    authKey,
  );
  const next: Omit<ComposioStore, "updatedAt"> = { userId, ...main, ...(readSession ? { readSession } : {}) };
  const { updatedAt: _updatedAt, ...previous } = existing ?? { updatedAt: "" };
  if (JSON.stringify(next) !== JSON.stringify(previous)) {
    await writeStore(projectRoot, { ...next, updatedAt: new Date().toISOString() });
  }
  const mcp = main.mcp!;
  await applyComposioMcpToHermesConfig(mcp);
  return { userId, sessionId: main.sessionId, mcp };
}

/**
 * Create or resume the Composio tool-router session for the sandbox user.
 * The process keeps the session for COMPOSIO_SESSION_TTL_MS, and parallel callers share one
 * request. The session gets the auth configs only when they change.
 */
export async function getOrCreateComposioSession(projectRoot = process.cwd()): Promise<ComposioSessionInfo> {
  if (!isComposioEnabled()) throw new Error("Composio is not configured (set COMPOSIO_API_KEY)");

  const userId = resolveComposioUserId(projectRoot);
  const authConfigs = resolveComposioToolkitAuthConfigs(projectRoot);
  const authKey = authConfigsKey(authConfigs);
  const key = `${projectRoot}\0${userId}`;

  if (
    sessionCache &&
    sessionCache.key === key &&
    sessionCache.authKey === authKey &&
    Date.now() - sessionCache.at < COMPOSIO_SESSION_TTL_MS
  ) {
    return sessionCache.value;
  }
  if (sessionInFlight && sessionInFlight.key === key && sessionInFlight.authKey === authKey) {
    return sessionInFlight.promise;
  }

  const inFlight = {
    key,
    authKey,
    promise: refreshComposioSession(projectRoot, userId, authConfigs, authKey),
  };
  sessionInFlight = inFlight;
  try {
    const value = await inFlight.promise;
    if (sessionInFlight === inFlight) sessionCache = { key, authKey, at: Date.now(), value };
    return value;
  } finally {
    if (sessionInFlight === inFlight) sessionInFlight = null;
  }
}

/** jChat polls /hermes-chat/status often — debounce Composio session refresh. */
const COMPOSIO_HERMES_SYNC_MIN_MS = 5 * 60_000;
let lastComposioHermesSyncAt = 0;
let composioHermesSyncInFlight: Promise<{ ok: boolean; enabled: boolean; configChanged: boolean }> | null =
  null;

async function syncComposioHermesMcpInner(
  projectRoot: string,
): Promise<{ ok: boolean; enabled: boolean; configChanged: boolean }> {
  if (!isComposioEnabled()) {
    const configChanged = await applyComposioMcpToHermesConfig(null);
    return { ok: true, enabled: false, configChanged };
  }
  const { mcp } = await getOrCreateComposioSession(projectRoot);
  const configChanged = await applyComposioMcpToHermesConfig(mcp);
  return { ok: true, enabled: Boolean(mcp.url), configChanged };
}

export async function syncComposioHermesMcp(
  projectRoot = process.cwd(),
  opts?: { force?: boolean },
): Promise<{ ok: boolean; enabled: boolean; configChanged: boolean }> {
  if (!opts?.force) {
    if (composioHermesSyncInFlight) return composioHermesSyncInFlight;
    if (Date.now() - lastComposioHermesSyncAt < COMPOSIO_HERMES_SYNC_MIN_MS) {
      return { ok: true, enabled: isComposioEnabled(), configChanged: false };
    }
  }
  composioHermesSyncInFlight = syncComposioHermesMcpInner(projectRoot).finally(() => {
    composioHermesSyncInFlight = null;
    lastComposioHermesSyncAt = Date.now();
  });
  return composioHermesSyncInFlight;
}

export async function listComposioToolkits(
  projectRoot: string,
  options: { search?: string; cursor?: string; limit?: number } = {},
): Promise<{ toolkits: ComposioToolkitRow[]; cursor?: string }> {
  // Composio toolkit search rejects queries shorter than 3 characters (HTTP 400 / 10400).
  const rawSearch = options.search?.trim() || "";
  const search = rawSearch.length >= 3 ? rawSearch : "";
  const requested = options.limit ?? (search ? 40 : 50);
  const limit = Math.min(50, Math.max(1, requested));
  const cacheKey = `${search}|${options.cursor ?? ""}|${limit}`;
  const cached = toolkitListCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TOOLKIT_LIST_CACHE_MS) {
    return cached.data;
  }

  const sessionId = await resolveComposioSessionId(projectRoot);
  const composio = composioClient();
  const session = await composio.use(sessionId);

  const result = await session.toolkits({
    limit,
    cursor: options.cursor,
    search: search || undefined,
    toolkits: search ? undefined : featuredToolkitSlugs(),
  });

  const connectedByToolkit = await listConnectedAccountsByToolkit(projectRoot);

  const toolkits = result.items
    .filter((t) => !t.isNoAuth)
    .map((t) => {
      const slug = t.slug.toLowerCase();
      const connectedAccounts = connectedByToolkit.get(slug) ?? [];
      const isConnected = connectedAccounts.length > 0;
      return {
        slug: t.slug,
        name: t.name,
        logo: t.logo,
        isConnected,
        connectedAccountId: connectedAccounts[0]?.connectedAccountId,
        connectedAccounts,
      };
    })
    .sort((a, b) => {
      const byConnected = Number(b.isConnected) - Number(a.isConnected);
      if (byConnected !== 0) return byConnected;
      return a.name.localeCompare(b.name);
    });

  const payload = { toolkits, cursor: result.cursor };
  toolkitListCache.set(cacheKey, { at: Date.now(), data: payload });
  return payload;
}

export async function connectComposioToolkit(
  projectRoot: string,
  toolkit: string,
  callbackUrl: string,
): Promise<{ redirectUrl: string }> {
  const slug = toolkit.trim().toLowerCase();
  if (!slug) throw new Error("toolkit is required");

  if (composioToolkitNeedsCustomAuth(slug) && !composioToolkitAuthConfigId(slug, projectRoot)) {
    if (slug === "slackbot") throw new ComposioSlackbotSetupRequiredError();
    throw new Error(composioCustomAuthSetupMessage(slug));
  }

  try {
    // getOrCreateComposioSession sends changed auth configs to the session.
    const { sessionId } = await getOrCreateComposioSession(projectRoot);
    const composio = composioClient();
    const session = await composio.use(sessionId);
    const connectionRequest = await session.authorize(slug, {
      callbackUrl: callbackUrl.trim() || undefined,
    });
    if (!connectionRequest.redirectUrl) {
      throw new Error("Composio did not return a redirect URL for OAuth");
    }
    return { redirectUrl: connectionRequest.redirectUrl };
  } catch (error) {
    if (error instanceof ComposioSlackbotSetupRequiredError) throw error;
    throw new Error(formatComposioConnectError(error, slug));
  }
}

function isComposioAccountNotFoundError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("ConnectedAccount_ResourceNotFound") ||
    (/\b404\b/.test(msg) && /not found/i.test(msg))
  );
}

/** Reconcile toolkit rows with live Composio connected-account list (disk cache must not own connection state). */
export async function applyComposioConnectionState(
  projectRoot: string,
  toolkits: ComposioToolkitRow[],
): Promise<ComposioToolkitRow[]> {
  const connectedByToolkit = await listConnectedAccountsByToolkit(projectRoot);
  return toolkits
    .map((t) => {
      const slug = t.slug.toLowerCase();
      const connectedAccounts = connectedByToolkit.get(slug) ?? [];
      return {
        ...t,
        isConnected: connectedAccounts.length > 0,
        connectedAccountId: connectedAccounts[0]?.connectedAccountId,
        connectedAccounts,
      };
    })
    .sort((a, b) => {
      const byConnected = Number(b.isConnected) - Number(a.isConnected);
      if (byConnected !== 0) return byConnected;
      return a.name.localeCompare(b.name);
    });
}

export async function disconnectComposioAccount(connectedAccountId: string): Promise<void> {
  const id = connectedAccountId.trim();
  if (!id) throw new Error("connectedAccountId is required");
  const composio = composioClient();
  try {
    await composio.connectedAccounts.delete(id);
  } catch (error) {
    // Stale UI / disk cache may reference accounts already removed in Composio cloud.
    if (isComposioAccountNotFoundError(error)) return;
    throw error;
  }
}

export type DisconnectAllComposioResult = {
  ok: boolean;
  skipped?: boolean;
  userId?: string;
  disconnected: string[];
  errors: string[];
};

/** Remove all Composio connected accounts for this sandbox user (OAuth lives in Composio cloud). */
export async function disconnectAllComposioConnections(
  projectRoot = process.cwd(),
): Promise<DisconnectAllComposioResult> {
  if (!isComposioEnabled()) {
    return { ok: true, skipped: true, disconnected: [], errors: [] };
  }

  const userId = resolveComposioUserId(projectRoot);
  const composio = composioClient();
  const listFn = (
    composio.connectedAccounts as {
      list: (params: { userIds: string[] }) => Promise<{ items?: { id: string }[] }>;
    }
  ).list;

  let items: { id: string }[] = [];
  try {
    const result = await listFn({ userIds: [userId] });
    items = result.items ?? [];
  } catch (err) {
    return {
      ok: false,
      userId,
      disconnected: [],
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }

  const disconnected: string[] = [];
  const errors: string[] = [];
  for (const row of items) {
    const id = row.id?.trim();
    if (!id) continue;
    try {
      await composio.connectedAccounts.delete(id);
      disconnected.push(id);
    } catch (err) {
      errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await clearComposioSessionStore(projectRoot);
  await applyComposioMcpToHermesConfig(null);

  return { ok: errors.length === 0, userId, disconnected, errors };
}

/** Delete local Composio session pointer (metadata only; tokens are in Composio cloud). */
export async function clearComposioSessionStore(projectRoot: string): Promise<void> {
  resetComposioSessionCache();
  const file = storePath(projectRoot);
  if (!file) return;
  try {
    await unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[composio] could not clear session store: ${(err as Error).message}`);
    }
  }
}
