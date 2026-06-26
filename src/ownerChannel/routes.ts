import type { Request, Response, Router } from "express";
import { awaitOwnerApproval } from "../actionGuard/gate.js";
import { isActionGuardEnabled, loadActionGuardPolicy } from "../actionGuard/policy.js";
import {
  defaultOwnerChannelProvider,
  ownerChannelStatus,
  readOwnerChannelConfig,
  writeOwnerChannelConfig,
} from "./config.js";
import { handleOwnerChannelTelegramUpdate } from "./ingress/telegram.js";
import { handleOwnerChannelSlackInteractivity } from "./ingress/slack.js";
import { handleSlackApprovalDecideQuery } from "./ingress/slackDecide.js";
import { attachSlackReplyPollingForPending } from "./slackReplyPoll.js";
import { notifyOwnerForApproval } from "./notify.js";
import { createPending, cleanupPending } from "../actionGuard/pending.js";
import type { OwnerChannelProvider } from "./types.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function handleAwaitRoute(req: Request, res: Response, projectRoot: string): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const actionId = readString(body.actionId);
  if (!actionId) {
    res.status(400).json({ error: "actionId is required" });
    return;
  }
  const summary =
    body.summary && typeof body.summary === "object" && !Array.isArray(body.summary)
      ? (body.summary as Record<string, unknown>)
      : {};
  const bypassGuard = body.bypassGuard === true;

  try {
    const result = await awaitOwnerApproval({ actionId, summary, bypassGuard }, projectRoot);
    if (result.decision === "unavailable") {
      res.status(503).json({
        ok: false,
        error: result.unavailableCode ?? "owner_channel_unavailable",
        message: result.unavailableReason,
        decision: result.decision,
      });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export function registerOwnerChannelRoutes(router: Router, opts: { projectRoot: string }): void {
  const { projectRoot } = opts;

  router.get("/api/connectors/owner-channel/status", (_req: Request, res: Response) => {
    const status = ownerChannelStatus(projectRoot);
    const policy = loadActionGuardPolicy(projectRoot);
    res.json({
      ok: true,
      ...status,
      gateEnabled: isActionGuardEnabled(projectRoot),
      gateMode: status.gateMode ?? policy.gateMode,
    });
  });

  router.put("/api/connectors/owner-channel", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const providerRaw = readString(body.provider).toLowerCase();
    const provider: OwnerChannelProvider =
      providerRaw === "slack" ? "slack" : providerRaw === "telegram" ? "telegram" : defaultOwnerChannelProvider();
    const existing = readOwnerChannelConfig(projectRoot);
    const gateModeRaw = readString(body.gateMode);
    const gateMode =
      gateModeRaw === "allowlist" || gateModeRaw === "external_writes"
        ? gateModeRaw
        : existing?.gateMode;

    writeOwnerChannelConfig(
      {
        provider,
        connectedAccountId: readString(body.connectedAccountId) || existing?.connectedAccountId,
        notify: {
          telegramChatId: readString(body.telegramChatId) || existing?.notify.telegramChatId,
          slackDmChannelId: readString(body.slackDmChannelId) || existing?.notify.slackDmChannelId,
        },
        gateMode,
        updatedAt: new Date().toISOString(),
      },
      projectRoot,
    );
    res.json({ ok: true, ...ownerChannelStatus(projectRoot) });
  });

  router.post("/api/owner-channel/await", async (req, res) => handleAwaitRoute(req, res, projectRoot));

  // Legacy alias for MCP proxy during migration
  router.post("/api/action-guard/await", async (req, res) => handleAwaitRoute(req, res, projectRoot));

  router.post("/api/owner-channel/test", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const policy = loadActionGuardPolicy(projectRoot);
    const pending = createPending(
      "owner_channel:test",
      { note: readString(body.note) || "Test approval from Connectors" },
      policy.approvalTimeoutMs,
      projectRoot,
    );
    try {
      await notifyOwnerForApproval(
        pending.id,
        "owner_channel:test",
        { note: readString(body.note) || "Test approval from Connectors" },
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
          "Test sent — reply Y or N in your Slack approval channel (polling active until policy timeout).",
      });
    } catch (err) {
      cleanupPending(pending.id, projectRoot);
      res.status(503).json({
        ok: false,
        error: err instanceof Error && "code" in err ? (err as { code: string }).code : "owner_channel_test_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post("/api/owner-channel/telegram/webhook", async (req: Request, res: Response) => {
    const secret = process.env.JOSHU_OWNER_CHANNEL_TELEGRAM_WEBHOOK_SECRET?.trim()
      || process.env.JOSHU_ACTION_GUARD_TELEGRAM_WEBHOOK_SECRET?.trim();
    if (secret) {
      const header = readString(req.headers["x-telegram-bot-api-secret-token"]);
      if (header !== secret) {
        res.status(401).json({ error: "invalid webhook secret" });
        return;
      }
    }
    try {
      await handleOwnerChannelTelegramUpdate(req.body ?? {}, projectRoot);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/owner-channel/slack/decide", async (req: Request, res: Response) => {
    try {
      const result = await handleSlackApprovalDecideQuery(
        {
          pending: readString(req.query.pending),
          decision: readString(req.query.decision),
          exp: readString(req.query.exp),
          sig: readString(req.query.sig),
        },
        projectRoot,
      );
      res.status(result.status).type("html").send(result.html);
    } catch (err) {
      res.status(500).type("html").send(`<html><body><p>${err instanceof Error ? err.message : String(err)}</p></body></html>`);
    }
  });

  router.post("/api/owner-channel/slack/interactivity", async (req: Request, res: Response) => {
    const rawBody = typeof req.body === "string" ? req.body : "";
    let payload: Record<string, unknown> = {};
    if (typeof req.body === "object" && req.body && "payload" in (req.body as object)) {
      const encoded = readString((req.body as { payload?: unknown }).payload);
      payload = encoded ? JSON.parse(encoded) : {};
    } else if (rawBody.startsWith("payload=")) {
      payload = JSON.parse(decodeURIComponent(rawBody.slice("payload=".length)));
    } else if (req.body && typeof req.body === "object") {
      payload = req.body as Record<string, unknown>;
    }
    try {
      const result = await handleOwnerChannelSlackInteractivity(payload, projectRoot);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
