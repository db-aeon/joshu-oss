import { execFile as execFileCb } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveJoshuAvatarUrl, resolveJoshuIdentity } from "./joshuIdentity.js";
import { readHermesSlackMessagingConfig } from "./hermesMessagingEnv.js";
import { resolveJoshuPublicApiBase } from "./ownerChannel/publicUrl.js";
import { resolveEnvWithLocalFallback } from "./safetySettings/localEnv.js";
import {
  slackAppsConnectionsOpen,
  slackAuthTest,
  type FetchLike,
  type SlackBotIdentity,
} from "./slackConnect/slackApi.js";

const execFile = promisify(execFileCb);

function getHermesHome(): string {
  return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
}

/** Slash commands of the box Slack app. The other Hermes commands are for operators. */
export const BOX_SLACK_SLASH_COMMANDS: readonly string[] = ["/new", "/stop"];

/** Scope for `users.lookupByEmail` (find the Slack user of the owner on the manual path). */
const OWNER_LOOKUP_SCOPE = "users:read.email";

/** Path of the Slack connect OAuth redirect route on the Joshu API router. */
export const SLACK_OAUTH_CALLBACK_PATH = "/api/slack/oauth/callback";

/** Public URL of the OAuth redirect route of this box. */
export function slackOAuthRedirectUrl(): string {
  return `${resolveJoshuPublicApiBase()}${SLACK_OAUTH_CALLBACK_PATH}`;
}

export type BoxSlackNames = {
  companion: string;
  owner: string;
  description: string;
  longDescription: string;
  agentDescription: string;
};

export function boxSlackNames(projectRoot = process.cwd()): BoxSlackNames {
  const identity = resolveJoshuIdentity(projectRoot);
  const companion = identity.name.trim() || "Companion";
  const owner = identity.owner.displayName?.trim() || "the owner";
  return {
    companion,
    owner,
    description: `${companion}, ${owner}'s Joshu companion`.slice(0, 140),
    // Slack wants 175 to 4000 characters.
    longDescription:
      `${companion} is ${owner}'s companion on Joshu. Message ${companion} here like you message a coworker: ` +
      `ask about your calendar or your email, hand over a task, or ask for a reminder. ` +
      `${companion} works from ${owner}'s Joshu box and is the same companion as in web chat, SMS, and email.`,
    agentDescription: `Message ${companion} like a coworker. ${companion} is ${owner}'s Joshu companion.`.slice(0, 300),
  };
}

type ManifestRecord = Record<string, unknown>;

function record(value: unknown): ManifestRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ManifestRecord) : {};
}

/**
 * Change the Hermes manifest (`hermes slack manifest --agent-view`) into the
 * box manifest: names of the companion, two slash commands, the scope for the
 * owner lookup, and the OAuth redirect URL of the box.
 */
export function shapeBoxSlackManifest(
  hermesManifest: unknown,
  names: BoxSlackNames,
  redirectUrl: string,
): ManifestRecord {
  const root = structuredClone(record(hermesManifest));

  const display = record(root.display_information);
  display.name = names.companion.slice(0, 35);
  display.description = names.description;
  display.long_description = names.longDescription;
  root.display_information = display;

  const features = record(root.features);
  const botUser = record(features.bot_user);
  botUser.display_name = names.companion.slice(0, 80);
  features.bot_user = botUser;
  delete features.assistant_view;
  const agentView = record(features.agent_view);
  agentView.agent_description = names.agentDescription;
  features.agent_view = agentView;
  if (Array.isArray(features.slash_commands)) {
    features.slash_commands = features.slash_commands.filter((cmd) =>
      BOX_SLACK_SLASH_COMMANDS.includes(String(record(cmd).command ?? "")),
    );
  }
  root.features = features;

  const oauth = record(root.oauth_config);
  const scopes = record(oauth.scopes);
  const bot = Array.isArray(scopes.bot) ? scopes.bot.map(String) : [];
  if (!bot.includes(OWNER_LOOKUP_SCOPE)) bot.push(OWNER_LOOKUP_SCOPE);
  scopes.bot = bot;
  oauth.scopes = scopes;
  oauth.redirect_urls = [redirectUrl];
  root.oauth_config = oauth;

  return root;
}

/** Slack "create app" link with the manifest filled in. */
export function slackCreateAppUrl(manifest: unknown): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export function slackAppSettingsUrl(appId: string): string {
  return `https://api.slack.com/apps/${encodeURIComponent(appId)}/general`;
}

/** Build the box manifest with the pinned Hermes (`--agent-view`). */
export async function buildBoxSlackManifest(
  hermesBinary: string,
  projectRoot = process.cwd(),
): Promise<{ manifest: ManifestRecord; createAppUrl: string }> {
  const binary = hermesBinary.trim();
  if (!binary) throw new Error("HERMES_BIN is not configured");
  const names = boxSlackNames(projectRoot);
  await execFile(
    binary,
    [
      "slack",
      "manifest",
      "--write",
      "--agent-view",
      "--name",
      names.companion,
      "--description",
      names.description,
      "--long-description",
      names.longDescription,
    ],
    { timeout: 60_000 },
  );
  const raw = await readFile(path.join(getHermesHome(), "slack-manifest.json"), "utf8");
  const manifest = shapeBoxSlackManifest(JSON.parse(raw) as unknown, names, slackOAuthRedirectUrl());
  return { manifest, createAppUrl: slackCreateAppUrl(manifest) };
}

export type HermesSlackSetupStatus = {
  configured: boolean;
  botTokenConfigured: boolean;
  appTokenConfigured: boolean;
  /** True when `SLACK_ALLOWED_USERS` has the Slack user of the owner. */
  ownerLinked: boolean;
  allowedUsers: string;
  homeChannel: string;
  allowedChannels: string;
  companionName: string;
  appId: string;
  appSettingsUrl: string;
  /** Portrait of the companion, for the app icon (a manifest cannot set the icon). */
  portraitUrl: string;
  steps: string[];
};

export function hermesSlackSetupStatus(projectRoot = process.cwd()): HermesSlackSetupStatus {
  const cfg = readHermesSlackMessagingConfig(projectRoot);
  const appId = resolveEnvWithLocalFallback("SLACK_APP_ID", projectRoot);
  const identity = resolveJoshuIdentity(projectRoot);
  const companion = identity.name.trim() || "your companion";
  return {
    ...cfg,
    configured: cfg.botTokenConfigured && cfg.appTokenConfigured,
    ownerLinked: Boolean(cfg.allowedUsers.trim()),
    companionName: companion,
    appId,
    appSettingsUrl: appId ? slackAppSettingsUrl(appId) : "",
    portraitUrl: resolveJoshuAvatarUrl(identity) ?? "",
    steps: [
      "Click Create Slack app. Slack opens with the manifest filled in. Pick your workspace and click Create.",
      "On the Basic Information page of the app, under App-Level Tokens, click Generate Token and Scopes. Add the scope connections:write and click Generate. Copy the xapp- token.",
      "Open Install App, click Install to Workspace, and click Allow. Copy the Bot User OAuth Token (xoxb-).",
      `Paste both tokens below and click Save. ${companion} then sends you a DM in Slack.`,
    ],
  };
}

export type SlackTokenCheck = { ok: true } | { ok: false; error: string };
export type SlackBotTokenCheck = ({ ok: true } & SlackBotIdentity) | { ok: false; error: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function checkSlackBotToken(botToken: string, fetchImpl?: FetchLike): Promise<SlackBotTokenCheck> {
  const token = botToken.trim();
  if (!token) return { ok: false, error: "bot_token_required" };
  if (!token.startsWith("xoxb-")) return { ok: false, error: "bot_token_must_start_with_xoxb" };
  try {
    return { ok: true, ...(await slackAuthTest(token, fetchImpl)) };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export async function checkSlackAppToken(appToken: string, fetchImpl?: FetchLike): Promise<SlackTokenCheck> {
  const token = appToken.trim();
  if (!token) return { ok: false, error: "app_token_required" };
  if (!token.startsWith("xapp-")) return { ok: false, error: "app_token_must_start_with_xapp" };
  try {
    await slackAppsConnectionsOpen(token, fetchImpl);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/** Check the given tokens, or the saved tokens when none are given. */
export async function verifyHermesSlackSetup(
  projectRoot: string,
  overrides?: { botToken?: string; appToken?: string },
  fetchImpl?: FetchLike,
): Promise<{ bot: SlackBotTokenCheck; app: SlackTokenCheck }> {
  const botToken = overrides?.botToken?.trim() || resolveEnvWithLocalFallback("SLACK_BOT_TOKEN", projectRoot);
  const appToken = overrides?.appToken?.trim() || resolveEnvWithLocalFallback("SLACK_APP_TOKEN", projectRoot);
  const [bot, app] = await Promise.all([
    checkSlackBotToken(botToken, fetchImpl),
    checkSlackAppToken(appToken, fetchImpl),
  ]);
  return { bot, app };
}

/** Suggested prompts that Slack shows when the owner opens the DM with the companion. */
export const JOSHU_SLACK_SUGGESTED_PROMPTS: ReadonlyArray<{ title: string; message: string }> = [
  { title: "Plan my day", message: "What is on my calendar today, and what should I focus on?" },
  { title: "Catch me up on email", message: "What important email came in since yesterday?" },
  { title: "What are you working on?", message: "What are you working on for me right now?" },
  { title: "Remind me", message: "Remind me about something later. Ask me what and when." },
];

/**
 * Slack chat settings in `platforms.slack.extra` of the Hermes config:
 * - `suggested_prompts`: the prompts above.
 * - `reply_in_thread: false` and `dm_top_level_threads_as_sessions: false`:
 *   the DM with the companion is one flat conversation, like a DM with a
 *   coworker. Hermes defaults to a thread (and a session) for each DM message
 *   (seen on a test box 2026-10-11). Joshu's 30-minute idle reset still starts a
 *   fresh session after a quiet gap. Channel @mentions also get flat replies.
 * - `gateway_restart_notification: false`: no "Gateway shutting down" notice in
 *   the DM. Joshu restarts the gateway at boot and after config changes; the
 *   notice reached the owner four times in one test (a test box, 2026-10-11).
 * `platforms` is product-managed, so a different value is replaced. Returns
 * true when the config changed.
 */
export function syncJoshuSlackSuggestedPrompts(config: Record<string, unknown>): boolean {
  const platforms = record(config.platforms);
  const slack = record(platforms.slack);
  const extra = record(slack.extra);
  const desired: Record<string, unknown> = {
    suggested_prompts: JOSHU_SLACK_SUGGESTED_PROMPTS.map((p) => ({ ...p })),
    reply_in_thread: false,
    dm_top_level_threads_as_sessions: false,
    gateway_restart_notification: false,
  };
  let changed = false;
  for (const [key, value] of Object.entries(desired)) {
    if (JSON.stringify(extra[key]) === JSON.stringify(value)) continue;
    extra[key] = value;
    changed = true;
  }
  if (!changed) return false;
  slack.extra = extra;
  platforms.slack = slack;
  config.platforms = platforms;
  return true;
}
