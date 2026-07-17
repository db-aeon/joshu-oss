/**
 * Per-share Slack Events API handler for share-chat.
 * Validates Slack signatures and answers only from the share scope.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ShareSlackBotConfig } from "./slackRegistry.js";
import { isSlackSenderAllowed } from "./slackRegistry.js";
import { resolveShareScope } from "./shareScope.js";
import { isShareChatEnabled } from "./chatFlags.js";
import { queryScopedBrain } from "./scopedBrain.js";
import { answerShareChatQuestion } from "./answer.js";
import { checkShareChatRateLimit } from "./rateLimit.js";

export function verifySlackRequestSignature(opts: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  /** Max age of request timestamp (seconds). */
  maxAgeSec?: number;
}): boolean {
  const { signingSecret, timestamp, rawBody, signature } = opts;
  const maxAgeSec = opts.maxAgeSec ?? 60 * 5;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > maxAgeSec) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const digest = createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = `v0=${digest}`;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

type SlackEventPayload = {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    user?: string;
    channel?: string;
    text?: string;
    bot_id?: string;
    subtype?: string;
    channel_type?: string;
    ts?: string;
  };
};

async function postSlackMessage(botToken: string, channel: string, text: string): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!json.ok) {
    throw new Error(json.error || `Slack chat.postMessage failed (${res.status})`);
  }
}

function stripBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
}

/**
 * Handle a verified Slack Events payload for one share.
 * Returns JSON body to send back to Slack (e.g. url_verification challenge).
 */
export async function handleShareSlackEvent(opts: {
  shareUuid: string;
  bot: ShareSlackBotConfig;
  payload: SlackEventPayload;
  projectRoot?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { shareUuid, bot, payload } = opts;
  const projectRoot = opts.projectRoot ?? process.cwd();

  if (payload.type === "url_verification" && payload.challenge) {
    return { status: 200, body: { challenge: payload.challenge } };
  }

  if (payload.type !== "event_callback" || !payload.event) {
    return { status: 200, body: { ok: true, ignored: true } };
  }

  const ev = payload.event;
  // Ignore bot messages / message_changed noise
  if (ev.bot_id || ev.subtype === "bot_message" || ev.subtype === "message_changed") {
    return { status: 200, body: { ok: true, ignored: "bot_or_subtype" } };
  }

  const text = stripBotMention(ev.text || "");
  if (!text) {
    return { status: 200, body: { ok: true, ignored: "empty" } };
  }

  const isDm = ev.channel_type === "im" || ev.type === "message";
  const isMention = ev.type === "app_mention";
  if (!isDm && !isMention) {
    return { status: 200, body: { ok: true, ignored: "event_type" } };
  }

  if (!isSlackSenderAllowed(bot, ev.user, ev.channel)) {
    return { status: 200, body: { ok: true, ignored: "not_allowed" } };
  }

  const rate = checkShareChatRateLimit(`slack:${shareUuid}:${ev.channel || "x"}`, {
    limit: 20,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    if (ev.channel) {
      await postSlackMessage(
        bot.botToken,
        ev.channel,
        "You're sending questions too quickly. Please wait a moment and try again.",
      ).catch(() => undefined);
    }
    return { status: 200, body: { ok: true, rate_limited: true } };
  }

  const scope = resolveShareScope(shareUuid, projectRoot);
  if (!scope || !scope.valid || !isShareChatEnabled(shareUuid, projectRoot)) {
    if (ev.channel) {
      await postSlackMessage(
        bot.botToken,
        ev.channel,
        "This shared-file chat is no longer available (share removed or disabled).",
      ).catch(() => undefined);
    }
    return { status: 200, body: { ok: true, share_invalid: true } };
  }

  const brain = await queryScopedBrain(text, scope);
  const answered = await answerShareChatQuestion(text, scope, brain.evidence, "slack");
  const cite =
    answered.citations.length > 0
      ? `\n\n_Sources: ${answered.citations.map((c) => c.title).join(", ")}_`
      : "";
  const reply = `${answered.answer}${cite}`;

  if (ev.channel) {
    await postSlackMessage(bot.botToken, ev.channel, reply.slice(0, 3500));
  }

  return {
    status: 200,
    body: {
      ok: true,
      shareUuid,
      refused: answered.refused,
      evidence_count: brain.evidence.length,
    },
  };
}
