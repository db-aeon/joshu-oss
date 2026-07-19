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
import { ComposioSlackbotSetupRequiredError } from "../composioAuthConfigs.js";
import { listGmailRegistryAccounts } from "./composio/gmailAccounts.js";
import {
  getSlackbotSetupStatus,
  saveSlackbotAuthConfigFromCredentials,
  slackbotManifestForProject,
} from "./composio/slackbotSetup.js";
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
      if (error instanceof ComposioSlackbotSetupRequiredError) {
        res.status(400).json({
          error: error.code,
          code: error.code,
          hint: error.message,
        });
        return;
      }
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get(`${basePath}/slackbot/setup`, (_req: Request, res: Response) => {
    res.json({ ok: true, ...getSlackbotSetupStatus(projectRoot) });
  });

  router.get(`${basePath}/slackbot/manifest`, (_req: Request, res: Response) => {
    const manifest = slackbotManifestForProject(projectRoot);
    res.json({
      ok: true,
      manifest,
      manifestText: JSON.stringify(manifest, null, 2),
      createAppUrl: "https://api.slack.com/apps?new_app=1",
    });
  });

  router.post(`${basePath}/slackbot/setup`, async (req: Request, res: Response) => {
    if (!isComposioEnabled()) {
      return res.status(503).json({ error: "Composio is not configured (set COMPOSIO_API_KEY)" });
    }
    const body = (req.body ?? {}) as {
      clientId?: unknown;
      clientSecret?: unknown;
      verificationToken?: unknown;
      connect?: unknown;
      callbackUrl?: unknown;
    };
    try {
      const saved = await saveSlackbotAuthConfigFromCredentials(
        {
          clientId: readString(body.clientId),
          clientSecret: readString(body.clientSecret),
          signingSecret: readString(
            (body as { signingSecret?: unknown }).signingSecret ??
              (body as { verificationToken?: unknown }).verificationToken,
          ),
          appToken: readString((body as { appToken?: unknown }).appToken),
          verificationToken: readString((body as { verificationToken?: unknown }).verificationToken),
        },
        projectRoot,
      );

      // Re-attach message triggers for any channels created before webhook was ready.
      let rebind: { ok: number; failed: Array<{ shareUuid: string; error: string }> } | undefined;
      try {
        const { rebindShareChatSlackbotTriggers } = await import(
          "../shareChat/triggerSubscribe.js"
        );
        rebind = await rebindShareChatSlackbotTriggers(projectRoot);
      } catch (rebindErr) {
        console.warn(
          "[slackbot-setup] rebind triggers:",
          rebindErr instanceof Error ? rebindErr.message : String(rebindErr),
        );
      }

      let redirectUrl: string | undefined;
      const shouldConnect = body.connect !== false;
      if (shouldConnect) {
        const callbackUrl = callbackFromRequest(req, readString(body.callbackUrl));
        const connected = await connectComposioToolkit(projectRoot, "slackbot", callbackUrl);
        redirectUrl = connected.redirectUrl;
      }

      res.json({
        ok: true,
        authConfigId: saved.authConfigId,
        reused: saved.reused,
        webhookUrl: saved.webhookUrl,
        webhookEndpointId: saved.webhookEndpointId,
        redirectUrl,
        rebind,
        status: getSlackbotSetupStatus(projectRoot),
        eventSubscriptionsHint:
          "In Slack app → Event Subscriptions, set Request URL to webhookUrl below and verify.",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const status =
        msg.endsWith("_required") ||
        msg === "composio_disabled" ||
        msg.includes("must_start_with")
          ? 400
          : 502;
      res.status(status).json({ error: msg });
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
