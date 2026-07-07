/**
 * Deep health + version endpoints for the VPS instance agent and control plane.
 */

import type { Request, Response, Router } from "express";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
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

function isTruthyEnv(name: string): boolean {
  return /^(1|true|yes)$/i.test(instanceEnvTrim(name, "false"));
}

/** GET a loopback port; ok on any non-5xx response (ArozOS redirects to /login.html). */
function probeHttpLocal(port: number, pathname = "/", timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** TCP-connect to a loopback port; ok if something is listening (Caddy on :443). */
function probeTcpLocal(port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
    socket.on("timeout", () => finish(false));
  });
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
    // ArozOS desktop (:8787) and the public edge (Caddy :443). `expected` reflects
    // whether the box is configured to serve them (AROZOS_ENABLED / CUSTOMER_DOMAIN).
    arozos: { ok: boolean; expected: boolean };
    edge: { ok: boolean; expected: boolean };
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

    // Edge/desktop reachability — these caught the "health 200 but site down" gap
    // where ArozOS or Caddy was dead while the Joshu API stayed green.
    const arozosExpected = isTruthyEnv("AROZOS_ENABLED");
    const arozPort = Number(instanceEnvTrim("PUBLIC_AROZ_PORT", "8787")) || 8787;
    const edgeExpected = Boolean(instanceEnvTrim("CUSTOMER_DOMAIN", ""));
    const [arozosOk, edgeOk] = await Promise.all([
      arozosExpected ? probeHttpLocal(arozPort) : Promise.resolve(true),
      edgeExpected ? probeTcpLocal(443) : Promise.resolve(true),
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
      arozos: { ok: arozosOk, expected: arozosExpected },
      edge: { ok: edgeOk, expected: edgeExpected },
    };

    const connectorsMcpRequired = deps.connectorsMcpRequired !== false;
    // Core = the box's own service plane. Update readiness keys off this only, so a
    // broken edge/desktop (which a release update can itself repair) never deadlocks
    // the managed-update path.
    const coreHealthy =
      components.joshu.ok &&
      components.camofox.ok &&
      components.hermes.ok &&
      components.dist.ok &&
      (!connectorsMcpRequired || components.connectorsMcp.ok);
    // Overall health additionally reflects the desktop + edge when the box is
    // configured to serve them, so "site down" surfaces as 503 instead of 200.
    const healthy =
      coreHealthy &&
      (!arozosExpected || components.arozos.ok) &&
      (!edgeExpected || components.edge.ok);

    const report: InstanceHealthReport = {
      instanceId: envTrim("JOSHU_INSTANCE_ID"),
      releaseVersion,
      releaseChannel: instanceEnvTrim("JOSHU_RELEASE_CHANNEL", "stable"),
      imageRef,
      hermesRef: instanceEnvTrim("HERMES_AGENT_REF", "unknown"),
      healthy,
      readyForUpdate: coreHealthy && !updateInProgress,
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
