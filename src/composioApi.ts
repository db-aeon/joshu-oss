/**
 * Composio tool-router sessions for jChat: OAuth connections + Hermes MCP exposure.
 * @see https://docs.composio.dev/docs/configuring-sessions.md
 * @see https://docs.composio.dev/cookbooks/app-connections-dashboard.md
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Composio } from "@composio/core";
import { resolveJoshuFilesPaths } from "./joshuFilesPaths.js";
import { joshuConfigDir } from "./nylas/paths.js";
import { applyComposioMcpToHermesConfig, type ComposioMcpEndpoint } from "./hermesApi.js";
import {
  composioCustomAuthSetupMessage,
  composioToolkitAuthConfigId,
  composioToolkitNeedsCustomAuth,
  formatComposioConnectError,
  resolveComposioToolkitAuthConfigs,
} from "./composioAuthConfigs.js";

const DEFAULT_FEATURED_TOOLKITS = [
  "gmail",
  "github",
  "slack",
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

type ComposioConnectedAccountRow = {
  id: string;
  status?: string;
  toolkit?: { slug?: string };
  appName?: string;
  appUniqueId?: string;
};

async function listConnectedAccountsByToolkit(
  projectRoot: string,
): Promise<Map<string, ComposioConnectedAccountSummary[]>> {
  const userId = resolveComposioUserId(projectRoot);
  const composio = composioClient();
  const listFn = (
    composio.connectedAccounts as {
      list: (params: { userIds: string[] }) => Promise<{ items?: ComposioConnectedAccountRow[] }>;
    }
  ).list;

  const result = await listFn({ userIds: [userId] });
  const byToolkit = new Map<string, ComposioConnectedAccountSummary[]>();

  for (const row of result.items ?? []) {
    const active = (row.status ?? "ACTIVE").toUpperCase() === "ACTIVE";
    if (!active) continue;
    const slug = row.toolkit?.slug?.toLowerCase() ?? row.appUniqueId?.toLowerCase() ?? "";
    if (!slug) continue;
    const list = byToolkit.get(slug) ?? [];
    list.push({
      connectedAccountId: row.id,
      label: row.appName?.trim() || undefined,
    });
    byToolkit.set(slug, list);
  }

  return byToolkit;
}

type ComposioStore = {
  userId: string;
  sessionId: string;
  mcp?: ComposioMcpEndpoint;
  updatedAt: string;
};

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

function composioClient(): Composio {
  const apiKey = envTrim("COMPOSIO_API_KEY");
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set");
  return new Composio({ apiKey });
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
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/** Upstream Composio cloud MCP endpoint (for guard proxy pass-through). */
export async function readComposioUpstreamMcp(projectRoot = process.cwd()): Promise<ComposioMcpEndpoint | null> {
  const store = await readStore(projectRoot);
  const mcp = store?.mcp;
  if (!mcp?.url?.trim()) return null;
  return mcp;
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

async function applyToolkitAuthConfigsToSession(
  session: { update?: (config: { authConfigs?: Record<string, string> }) => Promise<unknown> },
): Promise<void> {
  const authConfigs = resolveComposioToolkitAuthConfigs();
  if (Object.keys(authConfigs).length === 0) return;
  if (typeof session.update !== "function") return;
  await session.update({ authConfigs });
}

function createSessionConfig(): {
  manageConnections: { enable: boolean };
  workbench: { enable: boolean };
  authConfigs?: Record<string, string>;
} {
  const authConfigs = resolveComposioToolkitAuthConfigs();
  return {
    manageConnections: { enable: true },
    workbench: { enable: true },
    ...(Object.keys(authConfigs).length > 0 ? { authConfigs } : {}),
  };
}

/** Create or resume a Composio tool-router session for the sandbox user. */
export async function getOrCreateComposioSession(projectRoot = process.cwd()): Promise<{
  userId: string;
  sessionId: string;
  mcp: ComposioMcpEndpoint;
}> {
  if (!isComposioEnabled()) throw new Error("Composio is not configured (set COMPOSIO_API_KEY)");

  const composio = composioClient();
  const userId = resolveComposioUserId(projectRoot);
  const existing = await readStore(projectRoot);

  if (existing?.sessionId && existing.userId === userId) {
    try {
      const session = await composio.use(existing.sessionId);
      await applyToolkitAuthConfigsToSession(session);
      const mcp = mcpEndpointFromSession(session);
      const store: ComposioStore = {
        userId,
        sessionId: existing.sessionId,
        mcp,
        updatedAt: new Date().toISOString(),
      };
      await writeStore(projectRoot, store);
      await applyComposioMcpToHermesConfig(mcp);
      return { userId, sessionId: existing.sessionId, mcp };
    } catch (err) {
      console.warn(`[composio] stale session ${existing.sessionId}: ${(err as Error).message}`);
    }
  }

  const session = await composio.create(userId, createSessionConfig());
  const mcp = mcpEndpointFromSession(session);
  await writeStore(projectRoot, {
    userId,
    sessionId: session.sessionId,
    mcp,
    updatedAt: new Date().toISOString(),
  });
  await applyComposioMcpToHermesConfig(mcp);
  return { userId, sessionId: session.sessionId, mcp };
}

export async function syncComposioHermesMcp(
  projectRoot = process.cwd(),
): Promise<{ ok: boolean; enabled: boolean; configChanged: boolean }> {
  if (!isComposioEnabled()) {
    const configChanged = await applyComposioMcpToHermesConfig(null);
    return { ok: true, enabled: false, configChanged };
  }
  const { mcp } = await getOrCreateComposioSession(projectRoot);
  const configChanged = await applyComposioMcpToHermesConfig(mcp);
  return { ok: true, enabled: Boolean(mcp.url), configChanged };
}

export async function listComposioToolkits(
  projectRoot: string,
  options: { search?: string; cursor?: string; limit?: number } = {},
): Promise<{ toolkits: ComposioToolkitRow[]; cursor?: string }> {
  const { sessionId } = await getOrCreateComposioSession(projectRoot);
  const composio = composioClient();
  const session = await composio.use(sessionId);

  const search = options.search?.trim();
  const requested = options.limit ?? (search ? 40 : 50);
  const limit = Math.min(50, Math.max(1, requested));

  const result = await session.toolkits({
    limit,
    cursor: options.cursor,
    search: search || undefined,
    toolkits: search ? undefined : featuredToolkitSlugs(),
  });

  const connectedByToolkit = await listConnectedAccountsByToolkit(projectRoot);

  const toolkits = result.items.filter((t) => !t.isNoAuth).map((t) => {
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
  });

  return { toolkits, cursor: result.cursor };
}

export async function connectComposioToolkit(
  projectRoot: string,
  toolkit: string,
  callbackUrl: string,
): Promise<{ redirectUrl: string }> {
  const slug = toolkit.trim().toLowerCase();
  if (!slug) throw new Error("toolkit is required");

  if (composioToolkitNeedsCustomAuth(slug) && !composioToolkitAuthConfigId(slug)) {
    throw new Error(composioCustomAuthSetupMessage(slug));
  }

  try {
    const { sessionId } = await getOrCreateComposioSession(projectRoot);
    const composio = composioClient();
    const session = await composio.use(sessionId);
    await applyToolkitAuthConfigsToSession(session);
    const connectionRequest = await session.authorize(slug, {
      callbackUrl: callbackUrl.trim() || undefined,
    });
    if (!connectionRequest.redirectUrl) {
      throw new Error("Composio did not return a redirect URL for OAuth");
    }
    return { redirectUrl: connectionRequest.redirectUrl };
  } catch (error) {
    throw new Error(formatComposioConnectError(error, slug));
  }
}

export async function disconnectComposioAccount(connectedAccountId: string): Promise<void> {
  const id = connectedAccountId.trim();
  if (!id) throw new Error("connectedAccountId is required");
  const composio = composioClient();
  await composio.connectedAccounts.delete(id);
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
  const file = storePath(projectRoot);
  if (!file) return;
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[composio] could not clear session store: ${(err as Error).message}`);
    }
  }
}
