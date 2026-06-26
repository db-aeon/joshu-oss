import type { Request, Response, Router } from "express";
import type { HermesApiRunner } from "../hermesApi.js";
import {
  connectComposioToolkit,
  disconnectComposioAccount,
  isComposioEnabled,
  listComposioToolkits,
  readComposioUpstreamMcp,
  resolveComposioUserId,
  syncComposioHermesMcp,
} from "../composioApi.js";
import { listGmailRegistryAccounts } from "./composio/gmailAccounts.js";
import { refreshConnectorsRegistry } from "./registry.js";
import { runMailSync } from "./syncHelpers.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function callbackFromRequest(req: Request, bodyCallback?: string): string {
  const fromBody = bodyCallback?.trim();
  if (fromBody) return fromBody;
  const origin = readString(req.headers.origin);
  if (origin) return origin;
  const referer = readString(req.headers.referer);
  if (referer) {
    try {
      const u = new URL(referer);
      return u.origin + u.pathname;
    } catch {
      return referer;
    }
  }
  return "";
}

function mountComposioHandlers(
  router: Router,
  basePath: string,
  projectRoot: string,
  runner: HermesApiRunner,
): void {
  router.get(`${basePath}/status`, (_req: Request, res: Response) => {
    res.json({
      enabled: isComposioEnabled(),
      userId: isComposioEnabled() ? resolveComposioUserId(projectRoot) : undefined,
    });
  });

  /** Localhost-only: Composio MCP guard proxy reads upstream URL + headers. */
  router.get(`${basePath}/mcp-upstream`, async (req: Request, res: Response) => {
    const host = readString(req.socket.remoteAddress);
    if (host !== "127.0.0.1" && host !== "::1" && host !== "::ffff:127.0.0.1") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const mcp = await readComposioUpstreamMcp(projectRoot);
      if (!mcp?.url) {
        res.status(404).json({ error: "No Composio MCP session" });
        return;
      }
      res.json({ ok: true, mcp });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get(`${basePath}/toolkits`, async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      return res.status(503).json({ error: "Composio is not configured (set COMPOSIO_API_KEY)" });
    }
    try {
      const search = readString(req.query.search);
      const cursor = readString(req.query.cursor);
      const limitRaw = readString(req.query.limit);
      const limitParsed = limitRaw ? Number(limitRaw) : NaN;
      const limit =
        Number.isFinite(limitParsed) && limitParsed > 0 ? Math.min(50, limitParsed) : undefined;
      const result = await listComposioToolkits(projectRoot, {
        search: search || undefined,
        cursor: cursor || undefined,
        limit,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get(`${basePath}/gmail/accounts`, async (_req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      return res.status(503).json({ error: "Composio is not configured (set COMPOSIO_API_KEY)" });
    }
    try {
      const accounts = await listGmailRegistryAccounts(projectRoot);
      res.json({ ok: true, accounts });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post(`${basePath}/connect`, async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      return res.status(503).json({ error: "Composio is not configured (set COMPOSIO_API_KEY)" });
    }
    const body = (req.body ?? {}) as { toolkit?: unknown; callbackUrl?: unknown };
    const toolkit = readString(body.toolkit);
    if (!toolkit) return res.status(400).json({ error: "toolkit is required" });

    try {
      const callbackUrl = callbackFromRequest(req, readString(body.callbackUrl));
      const result = await connectComposioToolkit(projectRoot, toolkit, callbackUrl);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post(`${basePath}/disconnect`, async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      return res.status(503).json({ error: "Composio is not configured (set COMPOSIO_API_KEY)" });
    }
    const body = (req.body ?? {}) as { connectedAccountId?: unknown };
    const connectedAccountId = readString(body.connectedAccountId);
    if (!connectedAccountId) return res.status(400).json({ error: "connectedAccountId is required" });

    try {
      await disconnectComposioAccount(connectedAccountId);
      const result = await syncComposioHermesMcp(projectRoot);
      if (result.configChanged) await runner.reset();
      await refreshConnectorsRegistry(projectRoot);
      res.json({ ok: true });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post(`${basePath}/sync`, async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      return res.status(503).json({ error: "Composio is not configured (set COMPOSIO_API_KEY)" });
    }
    const restart = (req.body as { restartGateway?: boolean })?.restartGateway === true;
    try {
      const result = await syncComposioHermesMcp(projectRoot);
      if (restart || result.configChanged) {
        await runner.reset();
      }
      await refreshConnectorsRegistry(projectRoot);
      res.json(result);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** After OAuth window closes — refresh MCP, registry, and sync newly connected Gmail. */
  router.post(`${basePath}/post-connect`, async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      return res.status(503).json({ error: "Composio is not configured (set COMPOSIO_API_KEY)" });
    }
    const body = (req.body ?? {}) as { toolkit?: unknown; restartGateway?: boolean };
    const toolkit = readString(body.toolkit).toLowerCase();
    const restart = body.restartGateway === true;
    try {
      const mcpResult = await syncComposioHermesMcp(projectRoot);
      if (restart || mcpResult.configChanged) await runner.reset();
      const registry = await refreshConnectorsRegistry(projectRoot);
      let gmailSync;
      if (toolkit === "gmail" || !toolkit) {
        // OAuth connect only — seed incremental cursor; Day 0 owns historical backfill.
        gmailSync = await runMailSync(projectRoot, "gmail", {
          syncMode: "incremental",
          syncCalendar: false,
        });
      }
      res.json({ ok: true, registry, gmailSync });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export function registerConnectorComposioRoutes(
  router: Router,
  opts: { projectRoot: string; runner: HermesApiRunner },
): void {
  const { projectRoot, runner } = opts;
  mountComposioHandlers(router, "/api/connectors/composio", projectRoot, runner);
}

/** Legacy jChat paths — forward to connectors composio API. */
export function registerLegacyHermesComposioRoutes(
  router: Router,
  opts: { projectRoot: string; runner: HermesApiRunner },
): void {
  const { projectRoot, runner } = opts;
  mountComposioHandlers(router, "/api/hermes-chat/composio", projectRoot, runner);
}
