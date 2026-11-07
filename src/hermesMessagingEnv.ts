import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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

  const telegramAllowed = envOrLocal("TELEGRAM_ALLOWED_USERS", projectRoot);
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

/** The last non-empty value of `key` in ~/.hermes/.env, or "". */
function readHermesDotenvValue(key: string): string {
  const home = process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
  let text: string;
  try {
    text = readFileSync(path.join(home, ".env"), "utf8");
  } catch {
    return "";
  }
  let value = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${key}=`)) continue;
    let raw = line.slice(key.length + 1).trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (raw) value = raw;
  }
  return value;
}

/**
 * Bot token that the owner outbox sends with: Joshu env or local-env first,
 * else the copy in ~/.hermes/.env that the Hermes gateway runs with. A token
 * set up outside the safety settings is only in that file, and the outbox must
 * still answer where the owner wrote.
 */
export function resolveMessagingBotToken(
  key: "TELEGRAM_BOT_TOKEN" | "SLACK_BOT_TOKEN",
  projectRoot = process.cwd(),
): string {
  return resolveEnvWithLocalFallback(key, projectRoot) || readHermesDotenvValue(key);
}
