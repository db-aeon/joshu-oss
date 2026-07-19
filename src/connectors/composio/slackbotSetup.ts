/**
 * In-Joshu Slackbot setup: Slack app manifest + Composio custom auth + webhook ingress.
 * Distinct from Hermes Socket Mode Slack ([hermesSlackSetup.ts](../hermesSlackSetup.ts)).
 *
 * Message triggers need a Composio webhook endpoint configured with Slack Signing Secret
 * + App-Level Token (xapp-), then Slack Event Subscriptions pointed at that URL.
 */

import { composioClient } from "./client.js";
import { isComposioEnabled } from "../../composioApi.js";
import {
  composioToolkitAuthConfigId,
  setPersistedComposioAuthConfigId,
} from "../../composioAuthConfigs.js";
import { resolveJoshuIdentity } from "../../joshuIdentity.js";
import { COMPOSIO_SLACKBOT_TOOLKIT_SLUG } from "./slackbotConfig.js";
import {
  ensureSlackbotWebhookEndpoint,
  readSlackbotTriggerCreds,
  slackbotWebhookReady,
  writeSlackbotTriggerCreds,
} from "./slackbotWebhook.js";

const COMPOSIO_OAUTH_REDIRECT =
  "https://backend.composio.dev/api/v3.1/toolkits/auth/callback";

/** Bot + event scopes needed for share-chat KB channels (create / post / message triggers). */
const BOT_SCOPES = [
  "channels:manage",
  "channels:read",
  "channels:history",
  "groups:write",
  "groups:read",
  "groups:history",
  "chat:write",
  "chat:write.public",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "users:read",
  "users:read.email",
  "team:read",
];

export function buildSlackbotAppManifest(opts?: {
  botName?: string;
  description?: string;
  /** Composio Event Subscriptions Request URL once webhook endpoint exists. */
  eventsRequestUrl?: string;
}): Record<string, unknown> {
  const name = (opts?.botName || "Joshu Files").slice(0, 35);
  const description = (
    opts?.description ||
    "Answers questions about shared files in private Slack channels (Joshu share-chat)."
  ).slice(0, 140);
  const requestUrl =
    opts?.eventsRequestUrl?.trim() ||
    "https://backend.composio.dev/api/v3.1/webhook_ingress/slackbot/placeholder/trigger_event";

  return {
    display_information: {
      name,
      description,
      background_color: "#0d0d0d",
    },
    features: {
      bot_user: {
        display_name: name.slice(0, 35),
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: BOT_SCOPES,
      },
      redirect_urls: [COMPOSIO_OAUTH_REDIRECT],
    },
    settings: {
      org_deploy_enabled: false,
      // Socket Mode on so Slack UI allows creating an App-Level Token (xapp-)
      // with authorizations:read — required by Composio webhook endpoints.
      socket_mode_enabled: true,
      token_rotation_enabled: false,
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: ["message.channels", "message.groups", "message.im", "message.mpim"],
      },
    },
  };
}

export function slackbotManifestForProject(projectRoot = process.cwd()): Record<string, unknown> {
  const identity = resolveJoshuIdentity(projectRoot);
  const companion = identity.name.trim() || "Joshu";
  const creds = readSlackbotTriggerCreds(projectRoot);
  return buildSlackbotAppManifest({
    botName: `${companion} Files`.slice(0, 35),
    description: `${companion} answers questions about shared files in Slack (scoped Q&A only).`,
    eventsRequestUrl: creds?.webhookUrl,
  });
}

export type SlackbotSetupStatus = {
  composioEnabled: boolean;
  authConfigConfigured: boolean;
  authConfigIdPreview?: string;
  /** Composio Slack→Composio ingress ready (signing secret + app token). */
  webhookConfigured: boolean;
  webhookUrl?: string;
  setupRequired: boolean;
  steps: string[];
};

function previewAuthConfigId(id: string): string {
  if (id.length <= 10) return id.slice(0, 4) + "…";
  return id.slice(0, 6) + "…" + id.slice(-4);
}

export function getSlackbotSetupStatus(projectRoot = process.cwd()): SlackbotSetupStatus {
  const composioEnabled = isComposioEnabled();
  const authConfigId = composioToolkitAuthConfigId(COMPOSIO_SLACKBOT_TOOLKIT_SLUG, projectRoot);
  const authConfigConfigured = Boolean(authConfigId);
  const creds = readSlackbotTriggerCreds(projectRoot);
  const webhookConfigured = slackbotWebhookReady(projectRoot);
  return {
    composioEnabled,
    authConfigConfigured,
    authConfigIdPreview: authConfigId ? previewAuthConfigId(authConfigId) : undefined,
    webhookConfigured,
    webhookUrl: creds?.webhookUrl,
    setupRequired: composioEnabled && (!authConfigConfigured || !webhookConfigured),
    steps: [
      "Generate the Slack app manifest and create an app at api.slack.com → From an app manifest.",
      "Basic Information: copy Client ID, Client Secret, Signing Secret.",
      "Basic Information → App-Level Tokens: create a token with scope authorizations:read (xapp-…). Socket Mode can stay enabled for this.",
      "Paste Client ID, Client Secret, Signing Secret, and App-Level Token here → Save & Connect.",
      "After Save, copy the Event Subscriptions URL Joshu shows and paste it into Slack → Event Subscriptions → Request URL (verify should succeed).",
      "Reinstall the app to the workspace if Slack asks, then use Chat sharing → Create Slack channel.",
    ],
  };
}

/**
 * Create (or reuse) Composio Slackbot auth config + webhook ingress credentials.
 */
export async function saveSlackbotAuthConfigFromCredentials(
  opts: {
    clientId: string;
    clientSecret: string;
    /** Slack Signing Secret (Basic Information) — required for Events. */
    signingSecret: string;
    /** Slack App-Level Token xapp-… with authorizations:read. */
    appToken: string;
    /** Optional Verification Token; also used as auth-config fallback. */
    verificationToken?: string;
  },
  projectRoot = process.cwd(),
): Promise<{
  authConfigId: string;
  reused: boolean;
  webhookUrl: string;
  webhookEndpointId: string;
}> {
  if (!isComposioEnabled()) throw new Error("composio_disabled");

  const clientId = opts.clientId.trim();
  const clientSecret = opts.clientSecret.trim();
  const signingSecret = opts.signingSecret.trim();
  const appToken = opts.appToken.trim();
  const verificationToken = (opts.verificationToken || signingSecret).trim();
  if (!clientId) throw new Error("client_id_required");
  if (!clientSecret) throw new Error("client_secret_required");
  if (!signingSecret) throw new Error("signing_secret_required");
  if (!appToken) throw new Error("app_token_required");
  if (!appToken.startsWith("xapp-")) throw new Error("app_token_must_start_with_xapp");

  writeSlackbotTriggerCreds(
    {
      clientId,
      signingSecret,
      appToken,
      verificationToken,
    },
    projectRoot,
  );

  let authConfigId = composioToolkitAuthConfigId(COMPOSIO_SLACKBOT_TOOLKIT_SLUG, projectRoot) || "";
  let reused = false;

  const authCredentials: Record<string, string | number | boolean> = {
    client_id: clientId,
    client_secret: clientSecret,
    oauth_redirect_uri: COMPOSIO_OAUTH_REDIRECT,
    verification_token: verificationToken,
  };

  const composio = composioClient();
  if (authConfigId) {
    try {
      await composio.authConfigs.update(authConfigId, {
        type: "custom",
        credentials: authCredentials,
      });
      setPersistedComposioAuthConfigId(COMPOSIO_SLACKBOT_TOOLKIT_SLUG, authConfigId, projectRoot);
      reused = true;
    } catch (err) {
      console.warn(
        "[slackbot-setup] auth config update failed, creating new:",
        err instanceof Error ? err.message : String(err),
      );
      authConfigId = "";
    }
  }

  if (!authConfigId) {
    const created = await composio.authConfigs.create(COMPOSIO_SLACKBOT_TOOLKIT_SLUG, {
      type: "use_custom_auth",
      authScheme: "OAUTH2",
      name: "Joshu Slackbot (share-chat)",
      credentials: authCredentials,
    });
    authConfigId = String((created as { id?: string }).id || "").trim();
    if (!authConfigId) throw new Error("auth_config_create_no_id");
    setPersistedComposioAuthConfigId(COMPOSIO_SLACKBOT_TOOLKIT_SLUG, authConfigId, projectRoot);
  }

  const webhook = await ensureSlackbotWebhookEndpoint(projectRoot);
  return {
    authConfigId,
    reused,
    webhookUrl: webhook.webhookUrl,
    webhookEndpointId: webhook.endpointId,
  };
}
