/**
 * Handle Composio Slackbot CHANNEL_MESSAGE_RECEIVED → scoped share-chat answer.
 */

import { resolveShareScope } from "./shareScope.js";
import { isShareChatEnabled } from "./chatFlags.js";
import { queryScopedBrain } from "./scopedBrain.js";
import { answerShareChatQuestion } from "./answer.js";
import { checkShareChatRateLimit } from "./rateLimit.js";
import { getShareUuidForChannel } from "./slackChannels.js";
import { sendSlackbotMessage } from "./composioSlackbot.js";
import { SLACKBOT_CHANNEL_MESSAGE_RECEIVED } from "../connectors/composio/slackbotConfig.js";

/** Minimal shape from Composio IncomingTriggerPayload (avoid hard SDK type import). */
export type ComposioTriggerLike = {
  triggerSlug?: string;
  payload?: Record<string, unknown>;
  originalPayload?: Record<string, unknown>;
};

function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * Process a verified Composio trigger payload.
 * Returns a short status for logging / HTTP body.
 */
export async function handleComposioShareChatTrigger(
  trigger: ComposioTriggerLike,
  projectRoot = process.cwd(),
): Promise<{ ok: boolean; ignored?: string; error?: string }> {
  const slug = String(trigger.triggerSlug || "").toUpperCase();
  if (slug !== SLACKBOT_CHANNEL_MESSAGE_RECEIVED && !slug.includes("CHANNEL_MESSAGE")) {
    return { ok: true, ignored: "trigger_slug" };
  }

  const payload = asRecord(trigger.payload) || asRecord(trigger.originalPayload) || {};
  if (payload.bot_id || payload.subtype === "bot_message") {
    return { ok: true, ignored: "bot_message" };
  }

  const channelId = String(payload.channel || payload.channel_id || "").trim();
  if (!channelId) return { ok: true, ignored: "no_channel" };

  const shareUuid = getShareUuidForChannel(channelId, projectRoot);
  if (!shareUuid) return { ok: true, ignored: "unmapped_channel" };

  const text = stripMentions(String(payload.text || ""));
  if (!text) return { ok: true, ignored: "empty" };

  const rate = checkShareChatRateLimit(`slackbot:${shareUuid}:${channelId}`, {
    limit: 20,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return { ok: true, ignored: "rate_limited" };
  }

  if (!isShareChatEnabled(shareUuid, projectRoot)) {
    return { ok: true, ignored: "chat_disabled" };
  }
  const scope = resolveShareScope(shareUuid, projectRoot);
  if (!scope || !scope.valid) {
    return { ok: true, ignored: "share_invalid" };
  }

  try {
    const brain = await queryScopedBrain(text, scope);
    const answered = await answerShareChatQuestion(text, scope, brain.evidence, "slack");
    const cite =
      answered.citations.length > 0
        ? `\n\n_Sources: ${answered.citations.map((c) => c.title).join(", ")}_`
        : "";
    const reply = `${answered.answer}${cite}`.trim() || "I couldn't find that in the shared files.";

    await sendSlackbotMessage({ channel: channelId, text: reply.slice(0, 3500) }, projectRoot);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[share-chat/slackbot]", msg);
    try {
      await sendSlackbotMessage(
        {
          channel: channelId,
          text: "Sorry — I hit an error answering from the shared files. Try again in a moment.",
        },
        projectRoot,
      );
    } catch {
      /* ignore secondary failure */
    }
    return { ok: false, error: msg };
  }
}
