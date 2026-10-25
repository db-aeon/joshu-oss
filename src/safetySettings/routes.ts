import type { NextFunction, Request, Response, Router } from "express";
import { loadActionGuardPolicy } from "../actionGuard/policy.js";
import { createPending, cleanupPending } from "../actionGuard/pending.js";
import type { HermesApiRunner } from "../hermesApi.js";
import { syncHermesMessagingEnv } from "../hermesApi.js";
import { buildHermesMessagingDotenvEntries } from "../hermesMessagingEnv.js";
import {
  buildBoxSlackManifest,
  hermesSlackSetupStatus,
  verifyHermesSlackSetup,
} from "../hermesSlackSetup.js";
import { verifyArozosDesktopSession } from "../httpLocalhost.js";
import { resolveJoshuIdentity } from "../joshuIdentity.js";
import { notifyOwnerForApproval } from "../ownerChannel/notify.js";
import {
  addSlackUser,
  prepareSlackConnection,
  sendSlackOwnerDm,
  sendSlackWelcome,
} from "../slackConnect/finish.js";
import {
  approvePairingCode,
  PAIRING_PLATFORMS,
  type ExecFileLike,
  type PairingPlatform,
} from "../slackConnect/pairing.js";
import { registerSlackConnectRoutes } from "../slackConnect/routes.js";
import type { SlackConnectController } from "../slackConnect/run.js";
import type { FetchLike } from "../slackConnect/slackApi.js";
import { resolveEnvWithLocalFallback, writeLocalEnvOverrides } from "./localEnv.js";
import { readSafetySettings, writeSafetySettings, type SafetySettingsUpdate } from "./store.js";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const MESSAGING_RELOAD_REASON = "Slack or Telegram settings changed";

/**
 * Sync the Hermes messaging env to `~/.hermes/.env`, write the Hermes config,
 * restart the Hermes gateway, and resolve when the new gateway answers. The
 * restart waits while the Hermes gateway is busy (cron runs, api_server turns,
 * live calls); `onWaiting` runs once when it waits.
 */
export async function applyMessagingToHermesAndWait(
  projectRoot: string,
  runner: HermesApiRunner | undefined,
  onWaiting: () => void,
): Promise<void> {
  await syncHermesMessagingEnv(projectRoot);
  await runner?.applyConfigAndAwaitGatewayRestart(MESSAGING_RELOAD_REASON, { onWaiting: () => onWaiting() });
}

export function registerSafetySettingsRoutes(
  router: Router,
  opts: {
    projectRoot: string;
    hermesBinary?: string;
    runner?: HermesApiRunner;
    slackConnect?: SlackConnectController;
    /** Tests: fake Slack Web API and fake `hermes` binary. */
    fetchImpl?: FetchLike;
    execFileImpl?: ExecFileLike;
  },
): void {
  const { projectRoot, hermesBinary = "", runner, fetchImpl } = opts;

  // Caddy sends every /joshu/* request here without a login check. Only the
  // ArozOS desktop of the owner (or a direct localhost client) may use these routes.
  router.use("/api/safety-settings", async (req: Request, res: Response, next: NextFunction) => {
    if (await verifyArozosDesktopSession(req)) {
      next();
      return;
    }
    res.status(401).json({ error: "desktop_session_required" });
  });

  router.get("/api/safety-settings", (_req: Request, res: Response) => {
    res.json({ ok: true, settings: readSafetySettings(projectRoot) });
  });

  router.put("/api/safety-settings", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as SafetySettingsUpdate;
    try {
      const messagingBefore = JSON.stringify(buildHermesMessagingDotenvEntries(projectRoot));
      const newBotToken = body.secrets?.slackBotToken?.trim() ?? "";
      const newAppToken = body.secrets?.slackAppToken?.trim() ?? "";
      const newSlackTokens = Boolean(newBotToken || newAppToken);
      let appTokenChecked = false;
      if (newSlackTokens) {
        const checks = await verifyHermesSlackSetup(
          projectRoot,
          { botToken: newBotToken || undefined, appToken: newAppToken || undefined },
          fetchImpl,
        );
        if (newBotToken && !checks.bot.ok) {
          res.status(400).json({ error: `Slack rejected the bot token: ${checks.bot.error}` });
          return;
        }
        if (newAppToken && !checks.app.ok) {
          res.status(400).json({ error: `Slack rejected the app token: ${checks.app.error}` });
          return;
        }
        appTokenChecked = checks.app.ok;
      }

      writeSafetySettings(body, projectRoot);

      const notes: string[] = [];
      const botToken = resolveEnvWithLocalFallback("SLACK_BOT_TOKEN", projectRoot);
      const appToken = resolveEnvWithLocalFallback("SLACK_APP_TOKEN", projectRoot);
      let prepared: Awaited<ReturnType<typeof prepareSlackConnection>> | null = null;
      if (newSlackTokens && botToken && appToken) {
        const companion = resolveJoshuIdentity(projectRoot).name.trim() || "Your companion";
        try {
          prepared = await prepareSlackConnection({
            projectRoot,
            botToken,
            appToken,
            tokensChecked: appTokenChecked,
            fetchImpl,
          });
          notes.push(
            prepared.dmChannelId
              ? `${companion} sends you a DM in Slack when the Hermes gateway has restarted (a few minutes when ${companion} is busy).`
              : `Send ${companion} a DM in Slack. ${companion} answers with a pairing code. Enter the code under Pairing code.`,
          );
          notes.push(...prepared.warnings);
        } catch (err) {
          notes.push(errorText(err));
        }
      }

      const messagingChanged = JSON.stringify(buildHermesMessagingDotenvEntries(projectRoot)) !== messagingBefore;
      await syncHermesMessagingEnv(projectRoot).catch((err) => {
        console.warn(`[safety-settings] Hermes messaging env sync skipped: ${errorText(err)}`);
      });
      if (messagingChanged && runner) {
        const welcome = prepared;
        // The first DM goes out only after the Hermes gateway has the new tokens,
        // so a reply to it gets an answer. The save answers now; this runs on.
        void runner
          .applyConfigAndAwaitGatewayRestart(MESSAGING_RELOAD_REASON)
          .then(async () => {
            if (welcome) await sendSlackWelcome(projectRoot, botToken, welcome, fetchImpl);
          })
          .catch((err) => {
            console.warn(`[safety-settings] Hermes gateway reload or first Slack DM failed: ${errorText(err)}`);
          });
      } else if (prepared) {
        // Same tokens as before: the running Hermes gateway already has them.
        await sendSlackWelcome(projectRoot, botToken, prepared, fetchImpl);
      }
      const gateway = runner ? await runner.getGatewayStatus().catch(() => null) : null;
      const browserChanged = Boolean(body.browser?.backend);
      if (messagingChanged) {
        notes.unshift("Saved. The Hermes gateway restarts in the background to apply the messaging settings.");
      } else if (browserChanged) {
        notes.unshift("Saved. Restart joshu-stack for the browser backend change (local Chromium vs Browser Use Cloud).");
      } else {
        notes.unshift("Saved.");
      }
      res.json({ ok: true, settings: readSafetySettings(projectRoot), gateway, note: notes.join(" ") });
    } catch (err) {
      res.status(400).json({ error: errorText(err) });
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
      res.status(503).json({ error: errorText(err) });
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
      const result = await buildBoxSlackManifest(hermesBinary, projectRoot);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: errorText(err) });
    }
  });

  router.post("/api/safety-settings/slack-verify", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { botToken?: string; appToken?: string };
    try {
      const result = await verifyHermesSlackSetup(projectRoot, body, fetchImpl);
      const ok = result.bot.ok && result.app.ok;
      res.status(ok ? 200 : 400).json({ ok, ...result });
    } catch (err) {
      res.status(500).json({ error: errorText(err) });
    }
  });

  router.post("/api/safety-settings/pairing/approve", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { platform?: string; code?: string };
    const platform = String(body.platform ?? "").toLowerCase() as PairingPlatform;
    if (!PAIRING_PLATFORMS.includes(platform)) {
      res.status(400).json({ error: "platform must be slack or telegram" });
      return;
    }
    try {
      const approval = await approvePairingCode({
        hermesBinary,
        platform,
        code: String(body.code ?? ""),
        execFileImpl: opts.execFileImpl,
      });
      if (!approval.ok) {
        res.status(400).json({ error: approval.error });
        return;
      }
      let dmSent = false;
      if (platform === "slack") {
        // Hermes reads approved users for each message, so this needs no restart.
        // With the owner in SLACK_ALLOWED_USERS, the next restart ignores DMs of other unknown users.
        const allowed = resolveEnvWithLocalFallback("SLACK_ALLOWED_USERS", projectRoot);
        writeLocalEnvOverrides({ SLACK_ALLOWED_USERS: addSlackUser(allowed, approval.userId) }, projectRoot);
        await syncHermesMessagingEnv(projectRoot).catch(() => undefined);
        const botToken = resolveEnvWithLocalFallback("SLACK_BOT_TOKEN", projectRoot);
        if (botToken) {
          const companion = resolveJoshuIdentity(projectRoot).name.trim() || "your companion";
          await sendSlackOwnerDm(
            projectRoot,
            botToken,
            approval.userId,
            `You're linked. It's ${companion}: message me here anytime, like a coworker.`,
            fetchImpl,
          )
            .then(() => {
              dmSent = true;
            })
            .catch(() => undefined);
        }
      }
      res.json({
        ok: true,
        userId: approval.userId,
        userName: approval.userName,
        dmSent,
        settings: readSafetySettings(projectRoot),
      });
    } catch (err) {
      res.status(500).json({ error: errorText(err) });
    }
  });

  if (opts.slackConnect) registerSlackConnectRoutes(router, opts.slackConnect);

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
      res.json({
        ok: true,
        pendingId: pending.id,
        message: "Test sent — reply Y or N by SMS to approve or deny.",
      });
    } catch (err) {
      cleanupPending(pending.id, projectRoot);
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
