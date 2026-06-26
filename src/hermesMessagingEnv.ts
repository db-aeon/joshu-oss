import { loadActionGuardPolicy } from "./actionGuard/policy.js";
import { readLocalEnv, resolveEnvWithLocalFallback } from "./safetySettings/localEnv.js";

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function envOrLocal(key: string, projectRoot: string): string {
  return envTrim(key) || readLocalEnv(key, projectRoot) || "";
}

/** Dotenv entries for Hermes messaging platforms (Telegram + Slack). */
export function buildHermesMessagingDotenvEntries(projectRoot = process.cwd()): Record<string, string> {
  const out: Record<string, string> = {};

  for (const key of ["TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] as const) {
    const value = resolveEnvWithLocalFallback(key, projectRoot);
    if (value) out[key] = value;
  }

  for (const key of [
    "TELEGRAM_GROUP_ALLOWED_USERS",
    "TELEGRAM_GROUP_ALLOWED_CHATS",
    "TELEGRAM_HOME_CHANNEL",
    "TELEGRAM_HOME_CHANNEL_NAME",
    "TELEGRAM_WEBHOOK_URL",
    "TELEGRAM_WEBHOOK_SECRET",
    "SLACK_ALLOWED_USERS",
    "SLACK_HOME_CHANNEL",
    "SLACK_ALLOWED_CHANNELS",
  ] as const) {
    const value = envOrLocal(key, projectRoot);
    if (value) out[key] = value;
  }

  let telegramAllowed = envOrLocal("TELEGRAM_ALLOWED_USERS", projectRoot);
  if (!telegramAllowed) {
    const ids = loadActionGuardPolicy(projectRoot).telegramAllowedUserIds;
    if (ids.length) telegramAllowed = ids.join(",");
  }
  if (telegramAllowed) out.TELEGRAM_ALLOWED_USERS = telegramAllowed;

  return out;
}

export type HermesSlackMessagingConfig = {
  botTokenConfigured: boolean;
  appTokenConfigured: boolean;
  allowedUsers: string;
  homeChannel: string;
  allowedChannels: string;
};

export function readHermesSlackMessagingConfig(projectRoot = process.cwd()): HermesSlackMessagingConfig {
  const botToken =
    envTrim("SLACK_BOT_TOKEN") || readLocalEnv("SLACK_BOT_TOKEN", projectRoot) || "";
  const appToken =
    envTrim("SLACK_APP_TOKEN") || readLocalEnv("SLACK_APP_TOKEN", projectRoot) || "";
  return {
    botTokenConfigured: Boolean(botToken),
    appTokenConfigured: Boolean(appToken),
    allowedUsers: envOrLocal("SLACK_ALLOWED_USERS", projectRoot),
    homeChannel: envOrLocal("SLACK_HOME_CHANNEL", projectRoot),
    allowedChannels: envOrLocal("SLACK_ALLOWED_CHANNELS", projectRoot),
  };
}
