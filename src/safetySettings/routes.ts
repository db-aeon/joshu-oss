import type { Request, Response, Router } from "express";
import { loadActionGuardPolicy } from "../actionGuard/policy.js";
import { createPending, cleanupPending } from "../actionGuard/pending.js";
import type { HermesApiRunner } from "../hermesApi.js";
import { syncHermesMessagingEnv } from "../hermesApi.js";
import {
  generateHermesSlackManifest,
  hermesSlackSetupStatus,
  verifyHermesSlackSetup,
} from "../hermesSlackSetup.js";
import { notifyOwnerForApproval } from "../ownerChannel/notify.js";
import { attachSlackReplyPollingForPending } from "../ownerChannel/slackReplyPoll.js";
import { readSafetySettings, writeSafetySettings, type SafetySettingsUpdate } from "./store.js";

export function registerSafetySettingsRoutes(
  router: Router,
  opts: { projectRoot: string; hermesBinary?: string; runner?: HermesApiRunner },
): void {
  const { projectRoot, hermesBinary = "", runner } = opts;

  router.get("/api/safety-settings", (_req: Request, res: Response) => {
    res.json({ ok: true, settings: readSafetySettings(projectRoot) });
  });

  router.put("/api/safety-settings", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as SafetySettingsUpdate & { restartGateway?: boolean };
    try {
      const settings = writeSafetySettings(body, projectRoot);
      await syncHermesMessagingEnv(projectRoot).catch((err) => {
        console.warn(
          `[safety-settings] Hermes messaging env sync skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      let gateway = runner ? await runner.getGatewayStatus().catch(() => null) : null;
      if (body.restartGateway && runner) {
        gateway = await runner.restartGateway(projectRoot);
      }
      res.json({
        ok: true,
        settings,
        gateway,
        note: body.restartGateway
          ? "Saved and Hermes gateway restarted."
          : "Saved. Restart the Hermes gateway if Slack/Telegram tokens changed.",
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/safety-settings/restart-gateway", async (_req: Request, res: Response) => {
    if (!runner) {
      res.status(503).json({ error: "Hermes gateway runner is not available" });
      return;
    }
    try {
      const gateway = await runner.restartGateway(projectRoot);
      res.json({
        ok: true,
        gateway,
        message: gateway.running
          ? "Hermes gateway restarted."
          : "Gateway env synced; auto-start is off so the gateway was not started.",
      });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/safety-settings/slack-setup", (_req: Request, res: Response) => {
    res.json({ ok: true, setup: hermesSlackSetupStatus(projectRoot) });
  });

  router.post("/api/safety-settings/slack-manifest", async (_req: Request, res: Response) => {
    if (!hermesBinary.trim()) {
      res.status(503).json({ error: "HERMES_BIN is not configured on this host" });
      return;
    }
    try {
      const result = await generateHermesSlackManifest(hermesBinary, projectRoot);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/safety-settings/slack-verify", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { botToken?: string; appToken?: string };
    try {
      const result = await verifyHermesSlackSetup(projectRoot, body);
      const ok = result.bot.ok && result.app.ok;
      res.status(ok ? 200 : 400).json({ ok, ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/safety-settings/test-approval", async (_req: Request, res: Response) => {
    const policy = loadActionGuardPolicy(projectRoot);
    const pending = createPending(
      "safety_settings:test",
      { note: "Safety Settings test approval" },
      policy.approvalTimeoutMs,
      projectRoot,
    );
    try {
      await notifyOwnerForApproval(
        pending.id,
        "safety_settings:test",
        { note: "Safety Settings test approval" },
        projectRoot,
      );
      const slackPoll = attachSlackReplyPollingForPending(pending.id, projectRoot);
      if (slackPoll) {
        setTimeout(() => slackPoll.stop(), policy.approvalTimeoutMs);
      }
      res.json({
        ok: true,
        pendingId: pending.id,
        message:
          "Test sent — reply Y or N in your Slack approval channel (reply after the new message appears).",
      });
    } catch (err) {
      cleanupPending(pending.id, projectRoot);
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
