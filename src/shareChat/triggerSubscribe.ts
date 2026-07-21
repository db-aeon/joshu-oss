/**
 * Subscribe to Composio Slackbot triggers via Pusher (works locally without a public Joshu URL).
 * Complements the HTTP webhook route when COMPOSIO_WEBHOOK_SECRET + public URL are set.
 */

import { composioClient } from "../connectors/composio/client.js";
import { isComposioEnabled } from "../composioApi.js";
import { SLACKBOT_CHANNEL_MESSAGE_RECEIVED } from "../connectors/composio/slackbotConfig.js";
import { createChannelMessageTrigger } from "./composioSlackbot.js";
import { handleComposioShareChatTrigger } from "./composioTriggers.js";
import {
  listEnabledShareSlackChannels,
  upsertShareSlackChannel,
} from "./slackChannels.js";

let subscribeStarted = false;
let subscribeError: string | null = null;
let lastEventAt: string | null = null;
let lastEventSummary: string | null = null;

export function getShareChatSlackbotSubscribeStatus(): {
  started: boolean;
  error: string | null;
  lastEventAt: string | null;
  lastEventSummary: string | null;
} {
  return {
    started: subscribeStarted,
    error: subscribeError,
    lastEventAt,
    lastEventSummary,
  };
}

export async function startShareChatSlackbotTriggerSubscribe(
  projectRoot = process.cwd(),
): Promise<void> {
  if (subscribeStarted) return;
  if (!isComposioEnabled()) {
    subscribeError = "composio_disabled";
    console.warn("[share-chat] Composio trigger subscribe skipped: COMPOSIO_API_KEY not set");
    return;
  }

  try {
    const composio = composioClient();
    // Subscribe broadly, then filter in-callback so we can log drops.
    // (Composio SDK filters before the callback, which hides delivery issues.)
    await composio.triggers.subscribe((data) => {
      const slug = String(data.triggerSlug || "").toUpperCase();
      const toolkit = String((data as { toolkitSlug?: string }).toolkitSlug || "");
      lastEventAt = new Date().toISOString();
      lastEventSummary = `slug=${slug || "(empty)"} toolkit=${toolkit}`;
      console.log("[share-chat/slackbot-subscribe] event", lastEventSummary);

      if (slug && slug !== SLACKBOT_CHANNEL_MESSAGE_RECEIVED && !slug.includes("CHANNEL_MESSAGE")) {
        console.log("[share-chat/slackbot-subscribe] ignored slug", slug);
        return;
      }
      // Empty slug can happen on odd payload versions — still try to handle.
      void handleComposioShareChatTrigger(
        {
          triggerSlug: data.triggerSlug || SLACKBOT_CHANNEL_MESSAGE_RECEIVED,
          payload: data.payload as Record<string, unknown> | undefined,
          originalPayload: data.originalPayload as Record<string, unknown> | undefined,
        },
        projectRoot,
      )
        .then((result) => {
          console.log(
            "[share-chat/slackbot-subscribe] handled",
            result.ignored ? `ignored=${result.ignored}` : result.ok ? "ok" : `error=${result.error}`,
          );
        })
        .catch((err) => {
          console.error(
            "[share-chat/slackbot-subscribe]",
            err instanceof Error ? err.message : String(err),
          );
        });
    });
    subscribeStarted = true;
    subscribeError = null;
    console.log("[share-chat] subscribed to Composio Slackbot CHANNEL_MESSAGE_RECEIVED triggers");
  } catch (err) {
    subscribeError = err instanceof Error ? err.message : String(err);
    console.warn("[share-chat] Composio trigger subscribe failed:", subscribeError);
  }
}

/** Create/refresh message triggers for every mapped share-chat Slack channel. */
export async function rebindShareChatSlackbotTriggers(
  projectRoot = process.cwd(),
): Promise<{ ok: number; failed: Array<{ shareUuid: string; error: string }> }> {
  const rows = listEnabledShareSlackChannels(projectRoot);
  let ok = 0;
  const failed: Array<{ shareUuid: string; error: string }> = [];
  for (const row of rows) {
    try {
      const triggerInstanceId = await createChannelMessageTrigger(
        { channelId: row.channelId },
        projectRoot,
      );
      upsertShareSlackChannel(
        {
          ...row,
          triggerInstanceId,
          updatedAt: new Date().toISOString(),
        },
        projectRoot,
      );
      ok += 1;
    } catch (err) {
      failed.push({
        shareUuid: row.shareUuid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok, failed };
}
