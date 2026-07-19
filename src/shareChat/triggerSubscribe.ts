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

export async function startShareChatSlackbotTriggerSubscribe(
  projectRoot = process.cwd(),
): Promise<void> {
  if (subscribeStarted) return;
  if (!isComposioEnabled()) return;

  try {
    const composio = composioClient();
    await composio.triggers.subscribe(
      (data) => {
        const slug = String(data.triggerSlug || "").toUpperCase();
        if (slug !== SLACKBOT_CHANNEL_MESSAGE_RECEIVED && !slug.includes("CHANNEL_MESSAGE")) {
          return;
        }
        void handleComposioShareChatTrigger(
          {
            triggerSlug: data.triggerSlug,
            payload: data.payload as Record<string, unknown> | undefined,
            originalPayload: data.originalPayload as Record<string, unknown> | undefined,
          },
          projectRoot,
        ).catch((err) => {
          console.error(
            "[share-chat/slackbot-subscribe]",
            err instanceof Error ? err.message : String(err),
          );
        });
      },
      {
        triggerSlug: SLACKBOT_CHANNEL_MESSAGE_RECEIVED,
      },
    );
    subscribeStarted = true;
    console.log("[share-chat] subscribed to Composio Slackbot CHANNEL_MESSAGE_RECEIVED triggers");
  } catch (err) {
    console.warn(
      "[share-chat] Composio trigger subscribe failed:",
      err instanceof Error ? err.message : String(err),
    );
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
