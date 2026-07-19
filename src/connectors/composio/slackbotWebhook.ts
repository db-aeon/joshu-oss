/**
 * Composio Slackbot webhook endpoint (Slack → Composio ingress).
 * Required before CHANNEL_MESSAGE_RECEIVED triggers can be created.
 * @see https://docs.composio.dev/docs/setting-up-triggers/custom-oauth-webhooks
 */

import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../../nylas/paths.js";
import { COMPOSIO_SLACKBOT_TOOLKIT_SLUG } from "./slackbotConfig.js";

const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";

export type SlackbotTriggerCreds = {
  clientId: string;
  /** Slack Basic Information → Signing Secret (Events API). */
  signingSecret: string;
  /** Slack app-level token xapp-… with authorizations:read. */
  appToken: string;
  /** Optional legacy verification token (auth config / older docs). */
  verificationToken?: string;
  webhookEndpointId?: string;
  webhookUrl?: string;
  updatedAt: string;
};

function credsDir(projectRoot = process.cwd()): string {
  const joshu = joshuConfigDir(projectRoot);
  if (joshu) return joshu;
  return path.join(projectRoot, ".local");
}

export function slackbotTriggerCredsPath(projectRoot = process.cwd()): string {
  return path.join(credsDir(projectRoot), "slackbot-trigger.json");
}

export function readSlackbotTriggerCreds(projectRoot = process.cwd()): SlackbotTriggerCreds | null {
  const p = slackbotTriggerCredsPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as SlackbotTriggerCreds;
    if (!parsed?.clientId?.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSlackbotTriggerCreds(
  creds: Omit<SlackbotTriggerCreds, "updatedAt"> & { updatedAt?: string },
  projectRoot = process.cwd(),
): SlackbotTriggerCreds {
  const dir = credsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const row: SlackbotTriggerCreds = {
    clientId: creds.clientId.trim(),
    signingSecret: creds.signingSecret.trim(),
    appToken: creds.appToken.trim(),
    verificationToken: creds.verificationToken?.trim() || undefined,
    webhookEndpointId: creds.webhookEndpointId?.trim() || undefined,
    webhookUrl: creds.webhookUrl?.trim() || undefined,
    updatedAt: creds.updatedAt || new Date().toISOString(),
  };
  const filePath = slackbotTriggerCredsPath(projectRoot);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(row, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return row;
}

function composioApiKey(): string {
  const key = process.env.COMPOSIO_API_KEY?.trim() || "";
  if (!key) throw new Error("COMPOSIO_API_KEY is not set");
  return key;
}

async function composioFetch(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${COMPOSIO_API_BASE}${pathname}`, {
    ...init,
    headers: {
      "x-api-key": composioApiKey(),
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
}

export type SlackbotWebhookEndpoint = {
  id: string;
  toolkit_slug: string;
  client_id: string;
  webhook_url: string;
  data?: Record<string, unknown> | null;
};

/** Idempotent: create (or return existing) Composio ingress URL for Slackbot events. */
export async function createOrGetSlackbotWebhookEndpoint(
  clientId: string,
): Promise<SlackbotWebhookEndpoint> {
  const res = await composioFetch("/webhook_endpoints", {
    method: "POST",
    body: JSON.stringify({
      toolkit_slug: COMPOSIO_SLACKBOT_TOOLKIT_SLUG,
      client_id: clientId.trim(),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`webhook_endpoint_create_failed: ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text) as SlackbotWebhookEndpoint;
  if (!json.id || !json.webhook_url) throw new Error("webhook_endpoint_missing_fields");
  return json;
}

/** Store Signing Secret + App Token on the Composio webhook endpoint. */
export async function configureSlackbotWebhookEndpoint(
  endpointId: string,
  opts: { signingSecret: string; appToken: string },
): Promise<void> {
  const res = await composioFetch(`/webhook_endpoints/${encodeURIComponent(endpointId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        webhook_signing_secret: opts.signingSecret.trim(),
        app_token: opts.appToken.trim(),
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`webhook_endpoint_configure_failed: ${text.slice(0, 400)}`);
  }
}

/**
 * Ensure Composio can receive Slackbot events for this Slack app.
 * Returns the Event Subscriptions Request URL to paste into the Slack app.
 */
export async function ensureSlackbotWebhookEndpoint(
  projectRoot = process.cwd(),
): Promise<{ webhookUrl: string; endpointId: string; configured: boolean }> {
  const creds = readSlackbotTriggerCreds(projectRoot);
  if (!creds?.clientId) throw new Error("slackbot_client_id_required");
  if (!creds.signingSecret) throw new Error("slackbot_signing_secret_required");
  if (!creds.appToken) throw new Error("slackbot_app_token_required");
  if (!creds.appToken.startsWith("xapp-")) throw new Error("slackbot_app_token_must_start_with_xapp");

  const endpoint = await createOrGetSlackbotWebhookEndpoint(creds.clientId);
  await configureSlackbotWebhookEndpoint(endpoint.id, {
    signingSecret: creds.signingSecret,
    appToken: creds.appToken,
  });

  writeSlackbotTriggerCreds(
    {
      ...creds,
      webhookEndpointId: endpoint.id,
      webhookUrl: endpoint.webhook_url,
    },
    projectRoot,
  );

  return {
    webhookUrl: endpoint.webhook_url,
    endpointId: endpoint.id,
    configured: true,
  };
}

export function slackbotWebhookReady(projectRoot = process.cwd()): boolean {
  const creds = readSlackbotTriggerCreds(projectRoot);
  return Boolean(
    creds?.clientId &&
      creds.signingSecret &&
      creds.appToken &&
      creds.webhookEndpointId &&
      creds.webhookUrl,
  );
}
