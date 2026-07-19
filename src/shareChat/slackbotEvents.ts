/**
 * Slack Events API ingress for Composio Slackbot share-chat channels.
 * Receives message.channels / message.groups directly from Slack (bypasses Composio
 * webhook ingress + Pusher, which often fail to deliver locally).
 */

import { verifySlackRequestSignature } from "./slackEvents.js";
import { getShareUuidForChannel } from "./slackChannels.js";
import { handleComposioShareChatTrigger } from "./composioTriggers.js";
import { readSlackbotTriggerCreds } from "../connectors/composio/slackbotWebhook.js";
import { resolveJoshuPublicApiBase } from "../ownerChannel/publicUrl.js";

export function slackbotEventsPath(): string {
  return `/api/share-chat/slackbot/events`;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return true;
  }
}

function originFromEnvUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    return new URL(v).origin;
  } catch {
    return null;
  }
}

/**
 * Public Events Request URL for the Slack app.
 * Prefers JOSHU_PUBLIC_URL / box domain; falls back to Twilio/ngrok tunnel host when local.
 */
export function slackbotEventsRequestUrl(): string {
  const apiBase = resolveJoshuPublicApiBase().replace(/\/+$/, "");
  if (!isLoopbackUrl(apiBase)) {
    return `${apiBase}${slackbotEventsPath()}`;
  }

  // Local tunnels often already set for Twilio voice — reuse that public origin.
  const tunnelOrigin =
    originFromEnvUrl(process.env.TWILIO_VOICE_WEBHOOK_URL) ||
    originFromEnvUrl(process.env.PHONE_VOICE_PUBLIC_HOST) ||
    originFromEnvUrl(process.env.JOSHU_PUBLIC_URL);
  if (tunnelOrigin && !isLoopbackUrl(tunnelOrigin)) {
    const basePath = (process.env.PUBLIC_BASE_PATH || "/joshu").replace(/\/+$/, "") || "/joshu";
    return `${tunnelOrigin}${basePath}${slackbotEventsPath()}`;
  }

  return `${apiBase}${slackbotEventsPath()}`;
}

export function slackbotEventsUrlIsPublic(): boolean {
  return !isLoopbackUrl(slackbotEventsRequestUrl());
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
    thread_ts?: string;
  };
};

/**
 * Verify + handle a raw Slack Events body for share-chat Slackbot channels.
 */
export async function handleSlackbotEventsRequest(opts: {
  rawBody: string;
  timestamp: string;
  signature: string;
  projectRoot?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const creds = readSlackbotTriggerCreds(projectRoot);
  if (!creds?.signingSecret) {
    return {
      status: 503,
      body: {
        error: "slackbot_signing_secret_missing",
        hint: "Connectors → Slackbot → Configure → paste Signing Secret and Save.",
      },
    };
  }

  if (
    !verifySlackRequestSignature({
      signingSecret: creds.signingSecret,
      timestamp: opts.timestamp,
      rawBody: opts.rawBody,
      signature: opts.signature,
    })
  ) {
    return { status: 401, body: { error: "invalid_signature" } };
  }

  let payload: SlackEventPayload;
  try {
    payload = JSON.parse(opts.rawBody) as SlackEventPayload;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }

  if (payload.type === "url_verification" && payload.challenge) {
    return { status: 200, body: { challenge: payload.challenge } };
  }

  if (payload.type !== "event_callback" || !payload.event) {
    return { status: 200, body: { ok: true, ignored: "not_event" } };
  }

  const ev = payload.event;
  if (ev.type !== "message" && ev.type !== "app_mention") {
    return { status: 200, body: { ok: true, ignored: "event_type" } };
  }
  if (ev.bot_id || ev.subtype === "bot_message" || ev.subtype === "message_changed") {
    return { status: 200, body: { ok: true, ignored: "bot_or_subtype" } };
  }
  if (!ev.channel) {
    return { status: 200, body: { ok: true, ignored: "no_channel" } };
  }

  // Only answer in channels mapped to a share (ignore other workspace noise).
  const shareUuid = getShareUuidForChannel(ev.channel, projectRoot);
  if (!shareUuid) {
    return { status: 200, body: { ok: true, ignored: "unmapped_channel" } };
  }

  // Ack path is sync; answer asynchronously so Slack's 3s limit is respected.
  void handleComposioShareChatTrigger(
    {
      triggerSlug: "SLACKBOT_CHANNEL_MESSAGE_RECEIVED",
      payload: {
        channel: ev.channel,
        channel_id: ev.channel,
        text: ev.text || "",
        user: ev.user,
        ts: ev.ts,
        thread_ts: ev.thread_ts,
        bot_id: ev.bot_id,
        subtype: ev.subtype,
        channel_type: ev.channel_type,
      },
    },
    projectRoot,
  ).catch((err) => {
    console.error(
      "[share-chat/slackbot-events]",
      err instanceof Error ? err.message : String(err),
    );
  });

  return { status: 200, body: { ok: true, accepted: true, shareUuid } };
}
