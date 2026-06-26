import type { Request, Response, Router } from "express";
import { handleBrowserGateRoute } from "./browserGate.js";
import { awaitOwnerApproval } from "./gate.js";
import { isActionGuardEnabled, isTelegramAllowlistConfigured, loadActionGuardPolicy } from "./policy.js";
import { readTelegramLink } from "./telegram.js";
import { handleOwnerChannelTelegramUpdate } from "../ownerChannel/ingress/telegram.js";
import { startActionGuardTelegramPolling } from "./polling.js";
import { loadMcpToolPolicy } from "../mcpToolPolicy.js";
import { ownerChannelStatus } from "../ownerChannel/config.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function registerActionGuardRoutes(router: Router, opts: { projectRoot: string }): void {
  const { projectRoot } = opts;

  router.get("/api/mcp-tool-policy", (_req: Request, res: Response) => {
    res.json({ ok: true, policy: loadMcpToolPolicy() });
  });

  router.get("/api/action-guard/status", (_req: Request, res: Response) => {
    const policy = loadActionGuardPolicy(projectRoot);
    const link = readTelegramLink(projectRoot);
    res.json({
      ok: true,
      enabled: isActionGuardEnabled(projectRoot),
      policy,
      telegramLinked: Boolean(link),
      telegramChatId: link?.chatId,
      telegramUsername: link?.username,
      telegramAllowlistConfigured: isTelegramAllowlistConfigured(projectRoot),
      telegramAllowlistCount: policy.telegramAllowedUserIds.length,
      ownerChannel: ownerChannelStatus(projectRoot),
      ownerChannelLinked: ownerChannelStatus(projectRoot).linked,
    });
  });


  router.post("/api/action-guard/browser", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await handleBrowserGateRoute(body, projectRoot);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/action-guard/telegram/webhook", async (req: Request, res: Response) => {
    const secret = process.env.JOSHU_ACTION_GUARD_TELEGRAM_WEBHOOK_SECRET?.trim();
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
      console.warn(`[action-guard] webhook error: ${(err as Error).message}`);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  if (isActionGuardEnabled(projectRoot)) {
    startActionGuardTelegramPolling(projectRoot);
  }
}
