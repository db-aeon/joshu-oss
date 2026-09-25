import { createHash } from "node:crypto";

import { buildHermesMessagingDotenvEntries } from "../hermesMessagingEnv.js";
import { sendSms } from "../twilioSmsSend.js";
import type {
  RealtimeGoalDeliveryHandler,
  RealtimeGoalRecord,
} from "./types.js";
import { startRealtimeGoalCallback } from "./voiceCallback.js";

async function deliverSlack(
  projectRoot: string,
  goal: RealtimeGoalRecord,
  text: string,
  kind: string,
): Promise<{ delivered: boolean; providerId?: string; error?: string }> {
  const token = buildHermesMessagingDotenvEntries(projectRoot).SLACK_BOT_TOKEN?.trim();
  const channel = goal.origin.replyAddress?.trim();
  if (!token || !channel) return { delivered: false, error: "Slack delivery is not configured" };
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text,
      client_msg_id: (() => {
        const hex = createHash("sha256")
          .update(`${goal.id}:${kind}:${text}`)
          .digest("hex")
          .slice(0, 32);
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      })(),
      ...(goal.origin.threadId ? { thread_ts: goal.origin.threadId } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    ts?: string;
    error?: string;
  };
  return body.ok
    ? { delivered: true, providerId: body.ts }
    : { delivered: false, error: body.error || `Slack HTTP ${response.status}` };
}

async function deliverTelegram(
  projectRoot: string,
  goal: RealtimeGoalRecord,
  text: string,
): Promise<{ delivered: boolean; providerId?: string; error?: string }> {
  const token = buildHermesMessagingDotenvEntries(projectRoot).TELEGRAM_BOT_TOKEN?.trim();
  const chatId = goal.origin.replyAddress?.trim();
  if (!token || !chatId) return { delivered: false, error: "Telegram delivery is not configured" };
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.length > 4_000 ? `${text.slice(0, 3_997)}...` : text,
      ...(goal.origin.threadId && /^\d+$/.test(goal.origin.threadId)
        ? { message_thread_id: Number(goal.origin.threadId) }
        : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number };
  };
  return body.ok
    ? { delivered: true, providerId: String(body.result?.message_id ?? "") || undefined }
    : { delivered: false, error: body.description || `Telegram HTTP ${response.status}` };
}

export function createRealtimeGoalDeliveryHandler(
  projectRoot: string,
): RealtimeGoalDeliveryHandler {
  return async (goal, text, kind) => {
    if (goal.origin.channel === "sms") {
      const to = goal.origin.replyAddress?.trim();
      if (!to) return { delivered: false, error: "SMS reply address missing" };
      await sendSms(to, text);
      return { delivered: true };
    }
    if (goal.origin.channel === "slack") {
      return deliverSlack(projectRoot, goal, text, kind);
    }
    if (goal.origin.channel === "telegram") return deliverTelegram(projectRoot, goal, text);
    if (goal.origin.channel === "pstn_voice") {
      // Blocked questions and results share the passphrase-gated callback path.
      return startRealtimeGoalCallback(projectRoot, goal, text);
    }
    if (
      goal.origin.channel === "jchat" ||
      goal.origin.channel === "agui" ||
      goal.origin.channel === "browser_voice"
    ) {
      // Browser surfaces consume the durable per-session event queue.
      return { delivered: true };
    }
    return { delivered: false, error: `Unsupported realtime channel: ${goal.origin.channel}` };
  };
}
