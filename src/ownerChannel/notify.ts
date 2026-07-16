import { ActionGuardUnavailableError } from "../actionGuard/errors.js";
import {
  answerCallbackQuery,
  formatApprovalMessage,
  isTelegramConfigured,
  readTelegramLink,
  sendTelegramMessage,
} from "../actionGuard/telegram.js";
import { isTelegramUserAllowed } from "../actionGuard/policy.js";
import { readPending, resolvePending, markPendingSlackNotified } from "../actionGuard/pending.js";
import { readOwnerChannelConfig, hydrateOwnerChannelFromLegacy } from "./config.js";
import { sendSlackViaComposio, sendTelegramViaComposio } from "./composioSend.js";
import { buildSlackApprovalRequestMessage } from "./slackApprovalBlocks.js";
import type { OwnerChannelProvider } from "./types.js";

export const APPROVAL_CALLBACK_PREFIX = "ag";

export function approvalCallbackData(pendingId: string, decision: "approve" | "deny"): string {
  return `${APPROVAL_CALLBACK_PREFIX}:${decision}:${pendingId}`;
}

export function parseApprovalCallback(data: string): { decision: "approved" | "denied"; pendingId: string } | null {
  const match = /^(?:ag|oc):(approve|deny):([0-9a-f-]+)$/i.exec(data.trim());
  if (!match?.[1] || !match[2]) return null;
  return {
    decision: match[1].toLowerCase() === "approve" ? "approved" : "denied",
    pendingId: match[2],
  };
}

function telegramInlineKeyboard(pendingId: string): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: approvalCallbackData(pendingId, "approve") },
        { text: "Deny", callback_data: approvalCallbackData(pendingId, "deny") },
      ],
    ],
  };
}

async function notifyViaTelegramBotApi(
  chatId: number,
  pendingId: string,
  actionId: string,
  summary: Record<string, unknown>,
  projectRoot: string,
): Promise<void> {
  if (!isTelegramUserAllowed(chatId, projectRoot)) {
    throw new ActionGuardUnavailableError(
      "owner_channel_telegram_not_allowed",
      "Telegram chat is not on the owner allowlist",
    );
  }
  await sendTelegramMessage(chatId, formatApprovalMessage(actionId, summary), telegramInlineKeyboard(pendingId));
}

async function notifyViaSlack(
  channelId: string,
  _pendingId: string,
  actionId: string,
  summary: Record<string, unknown>,
  connectedAccountId: string | undefined,
  projectRoot: string,
): Promise<void> {
  const preview = formatApprovalMessage(actionId, summary).replace(/<[^>]+>/g, "");
  const { fallbackText, blocks } = buildSlackApprovalRequestMessage(actionId, preview, projectRoot);
  // Slack allows ≤50 blocks per message — split oversized approval payloads.
  const SLACK_BLOCKS_MAX = 45;
  if (blocks.length <= SLACK_BLOCKS_MAX) {
    await sendSlackViaComposio(
      { channel: channelId, text: fallbackText, blocks, connectedAccountId },
      projectRoot,
    );
  } else {
    for (let i = 0; i < blocks.length; i += SLACK_BLOCKS_MAX) {
      const slice = blocks.slice(i, i + SLACK_BLOCKS_MAX);
      await sendSlackViaComposio(
        {
          channel: channelId,
          text: i === 0 ? fallbackText : `${fallbackText} (continued)`,
          blocks: slice,
          connectedAccountId,
        },
        projectRoot,
      );
    }
  }
  markPendingSlackNotified(_pendingId, projectRoot);
}

export async function notifyOwnerForApproval(
  pendingId: string,
  actionId: string,
  summary: Record<string, unknown>,
  projectRoot = process.cwd(),
): Promise<OwnerChannelProvider | "legacy"> {
  const config = readOwnerChannelConfig(projectRoot) ?? hydrateOwnerChannelFromLegacy(projectRoot);

  if (config?.provider === "slack" && config.notify.slackDmChannelId) {
    try {
      await notifyViaSlack(
        config.notify.slackDmChannelId,
        pendingId,
        actionId,
        summary,
        config.connectedAccountId,
        projectRoot,
      );
      return "slack";
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ActionGuardUnavailableError(
        "owner_channel_slack_delivery_failed",
        `Slack approval notification failed: ${detail}`,
      );
    }
  }

  const legacyLink = readTelegramLink(projectRoot);
  const telegramChatId = config?.notify.telegramChatId ?? (legacyLink ? String(legacyLink.chatId) : "");
  if (!telegramChatId) {
    throw new ActionGuardUnavailableError(
      "owner_channel_not_linked",
      "Owner channel not linked — configure Telegram or Slack in Connectors",
    );
  }

  const chatIdNum = Number.parseInt(telegramChatId, 10);
  if (!Number.isFinite(chatIdNum)) {
    throw new ActionGuardUnavailableError(
      "owner_channel_invalid_telegram_chat",
      "Invalid Telegram chat ID in owner-channel config",
    );
  }

  try {
    if (isTelegramConfigured()) {
      await notifyViaTelegramBotApi(chatIdNum, pendingId, actionId, summary, projectRoot);
      return config?.provider ?? "legacy";
    }
    await sendTelegramViaComposio(
      {
        chatId: telegramChatId,
        text: formatApprovalMessage(actionId, summary),
        connectedAccountId: config?.connectedAccountId,
        replyMarkup: telegramInlineKeyboard(pendingId),
      },
      projectRoot,
    );
    return config?.provider ?? "telegram";
  } catch (err) {
    if (err instanceof ActionGuardUnavailableError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new ActionGuardUnavailableError(
      "owner_channel_telegram_delivery_failed",
      `Telegram approval notification failed: ${detail}`,
    );
  }
}

export async function handleApprovalCallback(
  callbackData: string,
  opts: { answerTelegramQueryId?: string; notifyChatId?: number },
  projectRoot = process.cwd(),
): Promise<boolean> {
  const parsed = parseApprovalCallback(callbackData);
  if (!parsed) return false;

  const pending = readPending(parsed.pendingId, projectRoot);
  if (!pending) {
    if (opts.answerTelegramQueryId) {
      await answerCallbackQuery(opts.answerTelegramQueryId, "Request expired or not found");
    }
    return false;
  }
  if (pending.status !== "pending") {
    if (opts.answerTelegramQueryId) {
      await answerCallbackQuery(opts.answerTelegramQueryId, `Already ${pending.status}`);
    }
    return false;
  }

  resolvePending(parsed.pendingId, parsed.decision, projectRoot);
  const label = parsed.decision === "approved" ? "Approved" : "Denied";
  if (opts.answerTelegramQueryId) {
    await answerCallbackQuery(opts.answerTelegramQueryId, label);
  }
  if (opts.notifyChatId) {
    await sendTelegramMessage(opts.notifyChatId, `Action ${parsed.decision}: ${pending.actionId}`);
  }
  return true;
}
