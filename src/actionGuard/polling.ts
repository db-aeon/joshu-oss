import { readLocalEnv } from "../safetySettings/localEnv.js";

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollOffset = 0;
let pollInFlight = false;

export function startActionGuardTelegramPolling(projectRoot = process.cwd()): void {
  const token =
    process.env.JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN?.trim() ||
    readLocalEnv("JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN", projectRoot) ||
    "";
  const useWebhook = process.env.JOSHU_ACTION_GUARD_TELEGRAM_WEBHOOK?.trim() === "true";
  if (!token || useWebhook) return;
  if (pollTimer) return;

  const tick = async () => {
    if (pollInFlight) {
      pollTimer = setTimeout(tick, 1000);
      return;
    }
    pollInFlight = true;
    try {
      const { getTelegramUpdates } = await import("./telegram.js");
      const { handleOwnerChannelTelegramUpdate } = await import("../ownerChannel/ingress/telegram.js");
      const { updates, nextOffset } = await getTelegramUpdates(pollOffset);
      pollOffset = nextOffset;
      for (const update of updates) {
        await handleOwnerChannelTelegramUpdate(update, projectRoot).catch((err) => {
          console.warn(`[action-guard] telegram update error: ${(err as Error).message}`);
        });
      }
    } catch (err) {
      console.warn(`[action-guard] telegram poll error: ${(err as Error).message}`);
    } finally {
      pollInFlight = false;
      pollTimer = setTimeout(tick, 500);
    }
  };

  pollTimer = setTimeout(tick, 2000);
  console.log("[action-guard] Telegram long-polling started");
}

export function stopActionGuardTelegramPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
