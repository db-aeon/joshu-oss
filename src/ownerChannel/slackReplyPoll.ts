import { readPending, resolvePending } from "../actionGuard/pending.js";
import { ownerChannelStatus } from "./config.js";
import { fetchSlackConversationHistory, sendSlackViaComposio } from "./composioSend.js";
import { buildSlackApprovalConfirmationMessage } from "./slackApprovalBlocks.js";
import { isJoshuApprovalBotMessage, parseSlackApprovalReply } from "./slackReplyParse.js";

/** Slack/Composio history reads — keep conservative to avoid ratelimited. */
const DEFAULT_INTERVAL_MS = 8_000;
const RATE_LIMIT_BACKOFF_MS = 30_000;

function slackTsToMs(ts: string): number {
  const sec = Number.parseFloat(ts);
  return Number.isFinite(sec) ? Math.floor(sec * 1000) : 0;
}

function pendingReplyCutoffMs(pending: { createdAt: string; slackNotifiedAt?: string }): number {
  if (pending.slackNotifiedAt) {
    return Date.parse(pending.slackNotifiedAt) - 2000;
  }
  return Date.parse(pending.createdAt) - 2000;
}

function isSlackRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ratelimited/i.test(msg);
}

export type SlackReplyPollHandle = { stop: () => void };

export async function confirmSlackApprovalDecision(
  channelId: string,
  actionId: string,
  decision: "approved" | "denied",
  connectedAccountId: string | undefined,
  projectRoot: string,
): Promise<void> {
  try {
    const { fallbackText, blocks } = buildSlackApprovalConfirmationMessage(actionId, decision, projectRoot);
    await sendSlackViaComposio(
      {
        channel: channelId,
        text: fallbackText,
        blocks,
        connectedAccountId,
      },
      projectRoot,
    );
  } catch (err) {
    console.warn(
      `[owner-channel] Slack confirmation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Poll the owner Slack channel for Y/N replies while a pending approval is open.
 * Resolves the pending via resolvePending() when a matching message is found.
 */
export function startSlackOwnerReplyPolling(opts: {
  pendingId: string;
  channelId: string;
  connectedAccountId?: string;
  projectRoot: string;
  intervalMs?: number;
}): SlackReplyPollHandle {
  const { pendingId, channelId, connectedAccountId, projectRoot, intervalMs = DEFAULT_INTERVAL_MS } = opts;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoffUntilMs = 0;
  let lastRateLimitLogMs = 0;
  const seenTs = new Set<string>();

  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
  };

  const tick = async () => {
    if (stopped) return;

    const now = Date.now();
    if (now < backoffUntilMs) {
      schedule(backoffUntilMs - now);
      return;
    }

    const pending = readPending(pendingId, projectRoot);
    if (!pending || pending.status !== "pending") {
      stop();
      return;
    }

    const cutoffMs = pendingReplyCutoffMs(pending);
    let nextDelayMs = intervalMs;

    try {
      const oldestSec = Math.floor(cutoffMs / 1000) - 30;
      const messages = await fetchSlackConversationHistory(
        channelId,
        { oldestSec, connectedAccountId },
        projectRoot,
      );

      const replies = messages
        .filter((msg) => {
          if (seenTs.has(msg.ts)) return false;
          seenTs.add(msg.ts);
          if (slackTsToMs(msg.ts) < cutoffMs) return false;
          if (msg.subtype === "bot_message" || msg.bot_id) return false;
          if (isJoshuApprovalBotMessage(msg.text)) return false;
          return parseSlackApprovalReply(msg.text) !== null;
        })
        .sort((a, b) => slackTsToMs(b.ts) - slackTsToMs(a.ts));

      for (const msg of replies) {
        const decision = parseSlackApprovalReply(msg.text);
        if (!decision) continue;

        if (resolvePending(pendingId, decision, projectRoot)) {
          console.log(`[owner-channel] Slack reply ${decision} for pending ${pendingId}`);
          stop();
          await confirmSlackApprovalDecision(
            channelId,
            pending.actionId,
            decision,
            connectedAccountId,
            projectRoot,
          );
          return;
        }
      }
    } catch (err) {
      if (isSlackRateLimited(err)) {
        backoffUntilMs = Date.now() + RATE_LIMIT_BACKOFF_MS;
        nextDelayMs = RATE_LIMIT_BACKOFF_MS;
        if (Date.now() - lastRateLimitLogMs > RATE_LIMIT_BACKOFF_MS) {
          lastRateLimitLogMs = Date.now();
          console.warn(
            `[owner-channel] Slack poll rate limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s`,
          );
        }
      } else {
        console.warn(
          `[owner-channel] Slack reply poll error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!stopped) schedule(nextDelayMs);
  };

  void tick();

  return { stop };
}

/** Start polling when owner channel is Slack and pending is open. No-op otherwise. */
export function attachSlackReplyPollingForPending(
  pendingId: string,
  projectRoot: string,
): SlackReplyPollHandle | undefined {
  const pending = readPending(pendingId, projectRoot);
  if (!pending || pending.status !== "pending") return undefined;

  const owner = ownerChannelStatus(projectRoot);
  if (owner.provider !== "slack" || !owner.linked || !owner.slackDmChannelId) return undefined;

  return startSlackOwnerReplyPolling({
    pendingId,
    channelId: owner.slackDmChannelId,
    connectedAccountId: owner.connectedAccountId,
    projectRoot,
  });
}
