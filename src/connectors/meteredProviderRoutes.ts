import type { Request, Response, Router } from "express";
import type { HermesApiRunner } from "../hermesApi.js";
import {
  anyMeteredProviderRelayConfigured,
  controlPlaneUsageDashboardUrl,
  fetchUsageSummaryFromCp,
  getMeteredProviderDefinition,
  METERED_PROVIDER_DEFINITIONS,
  meteredProviderRelayConfigured,
  readMeteredProviderConfig,
  resolveMeteredProviderApiKey,
  resolveMeteredProviderMode,
  resolveMeteredProviderUserEnabled,
  setMeteredProviderUserEnabled,
  writeMeteredProviderConfig,
  type MeteredProviderDefinition,
} from "../meteredProviders/config.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  }
  return null;
}

async function buildProviderRow(
  def: MeteredProviderDefinition,
  projectRoot: string,
  usage: Awaited<ReturnType<typeof fetchUsageSummaryFromCp>>,
) {
  const mode = resolveMeteredProviderMode(def);
  const userEnabled = resolveMeteredProviderUserEnabled(def, projectRoot);
  const configured =
    mode === "relay"
      ? meteredProviderRelayConfigured(def)
      : mode === "direct"
        ? Boolean(resolveMeteredProviderApiKey(def, projectRoot))
        : false;
  const mcpActive =
    mode === "relay"
      ? userEnabled && configured && Boolean(usage && usage.balanceUsd > 0)
      : mode === "direct"
        ? userEnabled && configured
        : false;
  return {
    id: def.id,
    displayName: def.displayName,
    description: def.description,
    mode,
    configured,
    userEnabled,
    enabled: userEnabled,
    mcpActive,
    balanceUsd: usage?.balanceUsd ?? null,
    balanceUsdDisplay: usage?.balanceUsdDisplay ?? null,
    dashboardUrl: meteredProviderRelayConfigured(def) ? controlPlaneUsageDashboardUrl() : null,
    ossEnvKey: def.ossEnvKey,
    ossKeyHint: def.ossKeyHint,
  };
}

export function registerMeteredProviderRoutes(
  router: Router,
  projectRoot: string,
  runner?: HermesApiRunner,
): void {
  router.get("/api/connectors/providers", async (_req: Request, res: Response) => {
    try {
      const usage = anyMeteredProviderRelayConfigured() ? await fetchUsageSummaryFromCp() : null;
      const providers = await Promise.all(
        METERED_PROVIDER_DEFINITIONS.map((def) => buildProviderRow(def, projectRoot, usage)),
      );
      res.json({ ok: true, providers, usage });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/api/connectors/providers/:providerId/status", async (req: Request, res: Response) => {
    try {
      const providerId = readString(req.params.providerId).toLowerCase();
      const def = getMeteredProviderDefinition(providerId);
      if (!def) {
        res.status(404).json({ ok: false, error: "unknown_provider" });
        return;
      }
      const usage = anyMeteredProviderRelayConfigured() ? await fetchUsageSummaryFromCp() : null;
      const row = await buildProviderRow(def, projectRoot, usage);
      res.json({
        ok: true,
        ...row,
        hasKey: Boolean(readMeteredProviderConfig(projectRoot)[def.ossEnvKey]),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/api/connectors/providers/:providerId/toggle", async (req: Request, res: Response) => {
    try {
      const providerId = readString(req.params.providerId).toLowerCase();
      const def = getMeteredProviderDefinition(providerId);
      if (!def) {
        res.status(404).json({ ok: false, error: "unknown_provider" });
        return;
      }
      const enabled = readBoolean((req.body as { enabled?: unknown })?.enabled);
      if (enabled == null) {
        res.status(400).json({ ok: false, error: "enabled boolean required" });
        return;
      }
      const mode = resolveMeteredProviderMode(def);
      const hasKey =
        mode === "relay"
          ? meteredProviderRelayConfigured(def)
          : Boolean(resolveMeteredProviderApiKey(def, projectRoot));
      if (enabled && !hasKey) {
        res.status(400).json({
          ok: false,
          error:
            mode === "relay"
              ? `${def.displayName} relay is not configured on this box`
              : `Save ${def.ossEnvKey} before enabling ${def.displayName}`,
        });
        return;
      }
      // Direct/OSS: reject obviously bad keys before we rewrite Hermes MCP + restart.
      // A 401 MCP entry is non-fatal, but the restart race can leave :8642 unbound.
      if (enabled && mode === "direct") {
        const key = resolveMeteredProviderApiKey(def, projectRoot);
        const probe = await fetch(def.ossMcpUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
          signal: AbortSignal.timeout(8_000),
        }).catch(() => null);
        if (probe && (probe.status === 401 || probe.status === 403)) {
          res.status(400).json({
            ok: false,
            error: `${def.ossEnvKey} was rejected by ${def.displayName} (401/403). Update the key in Manage, then enable.`,
          });
          return;
        }
      }
      setMeteredProviderUserEnabled(def, enabled, projectRoot);
      // Prefer cached balance so toggle stays snappy; Hermes reload is backgrounded.
      const usage = anyMeteredProviderRelayConfigured()
        ? await fetchUsageSummaryFromCp({ ttlMs: 60_000 })
        : null;
      if (runner) {
        // Write config.yaml before responding; gateway restart continues in background.
        await runner.applyConfigAndReloadGatewayInBackground(
          `${def.id} MCP ${enabled ? "enable" : "disable"}`,
        );
      }
      const row = await buildProviderRow(def, projectRoot, usage);
      res.json({ ok: true, ...row });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/api/connectors/providers/:providerId/setup", async (req: Request, res: Response) => {
    try {
      const providerId = readString(req.params.providerId).toLowerCase();
      const def = getMeteredProviderDefinition(providerId);
      if (!def) {
        res.status(404).json({ ok: false, error: "unknown_provider" });
        return;
      }
      const mode = resolveMeteredProviderMode(def);
      if (mode === "relay") {
        res.status(400).json({
          ok: false,
          error: "API keys cannot be stored on fleet boxes (CP relay + shared balance).",
        });
        return;
      }
      const apiKey = readString((req.body as { apiKey?: string })?.apiKey);
      if (!apiKey) {
        res.status(400).json({ ok: false, error: "apiKey required" });
        return;
      }
      writeMeteredProviderConfig({ [def.ossEnvKey]: apiKey, [def.userEnabledKey]: "true" }, projectRoot);
      const usage = anyMeteredProviderRelayConfigured()
        ? await fetchUsageSummaryFromCp({ ttlMs: 60_000 })
        : null;
      if (runner) {
        await runner.applyConfigAndReloadGatewayInBackground(`${def.id} MCP key save`);
      }
      const row = await buildProviderRow(def, projectRoot, usage);
      res.json({ ok: true, ...row });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });
}
