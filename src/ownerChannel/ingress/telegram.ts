import {
  handleTelegramUpdate as handleLegacyTelegramUpdate,
  tryLinkTelegramFromMessage,
  sendTelegramMessage,
  type TelegramUpdate,
} from "../../actionGuard/telegram.js";
import { isTelegramUserAllowed } from "../../actionGuard/policy.js";
import { writeOwnerChannelConfig, defaultOwnerChannelProvider, readOwnerChannelConfig } from "../config.js";
import { handleApprovalCallback } from "../notify.js";

function telegramSenderUserId(update: TelegramUpdate): number | null {
  const fromId = update.callback_query?.from?.id ?? update.message?.from?.id;
  if (typeof fromId === "number" && fromId > 0) return fromId;
  const chatId = update.message?.chat?.id;
  if (typeof chatId === "number" && chatId > 0) return chatId;
  return null;
}

/** Link owner Telegram DM into owner-channel.json on /start. */
function tryLinkOwnerChannelFromMessage(update: TelegramUpdate, projectRoot: string): boolean {
  const chat = update.message?.chat;
  const text = update.message?.text?.trim() ?? "";
  if (!chat?.id || !text.startsWith("/start")) return false;

  const senderId = telegramSenderUserId(update);
  if (senderId !== null && !isTelegramUserAllowed(senderId, projectRoot)) return false;

  const existing = readOwnerChannelConfig(projectRoot);
  writeOwnerChannelConfig(
    {
      provider: "telegram",
      connectedAccountId: existing?.connectedAccountId,
      notify: { telegramChatId: String(chat.id), slackDmChannelId: existing?.notify.slackDmChannelId },
      gateMode: existing?.gateMode,
      updatedAt: new Date().toISOString(),
    },
    projectRoot,
  );
  tryLinkTelegramFromMessage(update, projectRoot);
  return true;
}

export async function handleOwnerChannelTelegramUpdate(update: TelegramUpdate, projectRoot: string): Promise<void> {
  const cb = update.callback_query;
  if (cb?.data && cb.id) {
    const callbackUserId = cb.from?.id ?? cb.message?.chat?.id ?? null;
    if (callbackUserId !== null && !isTelegramUserAllowed(callbackUserId, projectRoot)) {
      return;
    }
    const handled = await handleApprovalCallback(cb.data, {
      answerTelegramQueryId: cb.id,
      notifyChatId: cb.message?.chat?.id,
    }, projectRoot);
    if (handled) return;
  }

  const chatId = update.message?.chat?.id;
  const messageText = update.message?.text?.trim() ?? "";
  if (chatId && messageText.startsWith("/start")) {
    const senderId = telegramSenderUserId(update);
    if (senderId !== null && !isTelegramUserAllowed(senderId, projectRoot)) {
      await sendTelegramMessage(chatId, "Unauthorized. This bot is restricted to the box owner.");
      return;
    }
    if (tryLinkOwnerChannelFromMessage(update, projectRoot)) {
      await sendTelegramMessage(
        chatId,
        "Owner channel linked. You will receive Joshu write-action approvals here.",
      );
      return;
    }
  }

  // Plain text → Hermes owner chat when not a command (future: route to Hermes ingress)
  if (chatId && messageText && !messageText.startsWith("/")) {
    return;
  }

  await handleLegacyTelegramUpdate(update, projectRoot);
}
