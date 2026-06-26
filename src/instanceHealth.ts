/**
 * Deep health + version endpoints for the VPS instance agent and control plane.
 */

import type { Request, Response, Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  distRoutesPresent,
  evaluateDistProvenance,
  readDistProvenance,
  type DistProvenanceStatus,
} from "./distProvenance.js";
import { resolveJoshuIdentity } from "./joshuIdentity.js";
import {
  syncCompanionIdentityFromEnv,
  type CompanionIdentitySyncResult,
} from "./companionIdentitySync.js";
import { provisionEnvTrim } from "./provisionInstanceEnv.js";

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

/** Prefer /etc/joshu/instance.env — agent patches it before stack recreate; process env stays stale. */
function instanceEnvTrim(name: string, fallback = ""): string {
  return provisionEnvTrim(name) ?? envTrim(name, fallback);
}

function updateInProgressFromInstanceEnv(): boolean {
  return instanceEnvTrim("JOSHU_UPDATE_IN_PROGRESS") === "true";
}

function isLocalhostRequest(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  const host = (req.hostname ?? "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost";
}

export interface InstanceHealthReport {
  instanceId: string;
  releaseVersion: string;
  releaseChannel: string;
  imageRef: string;
  hermesRef: string;
  healthy: boolean;
  readyForUpdate: boolean;
  components: {
    joshu: { ok: boolean };
    camofox: { ok: boolean };
    hermes: { ok: boolean };
    hindsight: { ok: boolean };
    gbrain: { ok: boolean; indexed_ok?: boolean; page_count?: number; disk_markdown?: number };
    connectorsMcp: { ok: boolean };
    twilio: { ok: boolean };
    dist: DistProvenanceStatus & { routesPresent?: boolean };
  };
  uptimeSec: number;
}

const startedAt = Date.now();

export function registerInstanceHealthRoutes(
  router: Router,
  deps: {
    probeHermes: () => Promise<{ available: boolean }>;
    probeCamofox: () => Promise<{ reachable: boolean }>;
    probeHindsight: () => Promise<{ ok: boolean }>;
    probeGbrain: () => Promise<{
      ok: boolean;
      indexed_ok?: boolean;
      page_count?: number;
      disk_markdown?: number;
    }>;
    probeConnectorsMcp: () => Promise<{ ok: boolean }>;
    probeTwilio: () => Promise<{ ok: boolean }>;
    connectorsMcpRequired?: boolean;
  },
): void {
  router.get("/api/instance/version", (_req: Request, res: Response) => {
    res.json({
      instanceId: envTrim("JOSHU_INSTANCE_ID"),
      releaseVersion: instanceEnvTrim("JOSHU_RELEASE_VERSION", "0.0.0-dev"),
      releaseChannel: instanceEnvTrim("JOSHU_RELEASE_CHANNEL", "stable"),
      imageRef: instanceEnvTrim("JOSHU_IMAGE_REF", "local"),
      hermesRef: instanceEnvTrim("HERMES_AGENT_REF", "unknown"),
    });
  });

  router.get("/api/instance/health", async (_req: Request, res: Response) => {
    const [hermes, camofox, hindsight, gbrain, connectorsMcp, twilio] = await Promise.all([
      deps.probeHermes(),
      deps.probeCamofox(),
      deps.probeHindsight(),
      deps.probeGbrain(),
      deps.probeConnectorsMcp(),
      deps.probeTwilio(),
    ]);

    const updateInProgress = updateInProgressFromInstanceEnv();
    const imageRef = instanceEnvTrim("JOSHU_IMAGE_REF", "local");
    let releaseVersion = instanceEnvTrim("JOSHU_RELEASE_VERSION", "0.0.0-dev");
    const [provenance, routesPresent] = await Promise.all([
      readDistProvenance(process.cwd()),
      distRoutesPresent(process.cwd()),
    ]);
    // When dist was synced from the running image but instance.env still has a stale
    // JOSHU_RELEASE_VERSION (duplicate keys or failed update), trust provenance.
    if (
      provenance?.imageRef &&
      imageRef &&
      provenance.imageRef === imageRef &&
      provenance.version
    ) {
      releaseVersion = provenance.version;
    }
    let distStatus = evaluateDistProvenance(provenance, releaseVersion);
    // During release updates dist may lead instance.env briefly; do not fail health mid-update.
    if (updateInProgress && !distStatus.ok) {
      distStatus = { ...distStatus, ok: true, status: "updating" };
    }

    const components = {
      joshu: { ok: true },
      camofox: { ok: camofox.reachable },
      hermes: { ok: hermes.available },
      hindsight: { ok: hindsight.ok },
      gbrain: {
        ok: gbrain.ok,
        ...(gbrain.indexed_ok !== undefined ? { indexed_ok: gbrain.indexed_ok } : {}),
        ...(gbrain.page_count !== undefined ? { page_count: gbrain.page_count } : {}),
        ...(gbrain.disk_markdown !== undefined ? { disk_markdown: gbrain.disk_markdown } : {}),
      },
      connectorsMcp: { ok: connectorsMcp.ok },
      twilio: { ok: twilio.ok },
      dist: {
        ...distStatus,
        routesPresent,
      },
    };

    const connectorsMcpRequired = deps.connectorsMcpRequired !== false;
    const healthy =
      components.joshu.ok &&
      components.camofox.ok &&
      components.hermes.ok &&
      components.dist.ok &&
      (!connectorsMcpRequired || components.connectorsMcp.ok);

    const report: InstanceHealthReport = {
      instanceId: envTrim("JOSHU_INSTANCE_ID"),
      releaseVersion,
      releaseChannel: instanceEnvTrim("JOSHU_RELEASE_CHANNEL", "stable"),
      imageRef,
      hermesRef: instanceEnvTrim("HERMES_AGENT_REF", "unknown"),
      healthy,
      readyForUpdate: healthy && !updateInProgress,
      components,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    };

    res.status(healthy ? 200 : 503).json(report);
  });

  router.post("/api/instance/sync-companion-identity", (req: Request, res: Response) => {
    if (!isLocalhostRequest(req)) {
      res.status(403).json({ error: "sync-companion-identity is localhost-only" });
      return;
    }
    const forceSoul =
      req.body && typeof req.body === "object" && (req.body as { forceSoul?: boolean }).forceSoul === true;
    try {
      const result: CompanionIdentitySyncResult = syncCompanionIdentityFromEnv(process.cwd(), {
        forceSoul,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Per-instance assistant persona (name, owner, portrait, voice stubs). */
  router.get("/api/instance/identity", (_req: Request, res: Response) => {
    const identity = resolveJoshuIdentity();
    res.json({
      schemaVersion: identity.schemaVersion,
      name: identity.name,
      imageUrl: identity.imageUrl,
      avatarUrl: identity.avatarUrl,
      voiceId: identity.voiceId,
      owner: {
        displayName: identity.owner.displayName,
        email: identity.owner.email ?? null,
      },
      updatedAt: identity.updatedAt ?? null,
      source: identity.source ?? null,
    });
  });

  /** Optional release manifest baked into the image at /opt/joshu/RELEASE.json */
  router.get("/api/instance/release-manifest", async (_req: Request, res: Response) => {
    const manifestPath = path.join(process.cwd(), "RELEASE.json");
    try {
      const raw = await readFile(manifestPath, "utf8");
      res.json(JSON.parse(raw) as unknown);
    } catch {
      res.json({
        version: envTrim("JOSHU_RELEASE_VERSION", "0.0.0-dev"),
        imageRef: envTrim("JOSHU_IMAGE_REF", "local"),
        hermesRef: envTrim("HERMES_AGENT_REF", "unknown"),
      });
    }
  });
}
