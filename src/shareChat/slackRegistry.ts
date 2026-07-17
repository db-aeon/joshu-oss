/**
 * Per-share Slack bot registry for share-chat Q&A.
 * Separate from the main Hermes Slack bot.
 */

import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

export interface ShareSlackBotConfig {
  shareUuid: string;
  botToken: string;
  signingSecret: string;
  /** Socket Mode app-level token (optional). */
  appToken?: string;
  botDisplayName?: string;
  /** Empty = allow any user (still scoped to this share's answers). */
  allowedUserIds: string[];
  /** Empty = allow any channel/DM that can message the bot. */
  allowedChannelIds: string[];
  updatedAt: string;
}

type RegistryFile = {
  version: 1;
  bots: Record<string, ShareSlackBotConfig>;
};

function registryDir(projectRoot = process.cwd()): string {
  const joshu = joshuConfigDir(projectRoot);
  if (joshu) return path.join(joshu, "share-chat");
  return path.join(projectRoot, ".local", "share-chat");
}

function registryPath(projectRoot = process.cwd()): string {
  return path.join(registryDir(projectRoot), "slack-bots.json");
}

function readRegistry(projectRoot = process.cwd()): RegistryFile {
  const p = registryPath(projectRoot);
  if (!fs.existsSync(p)) return { version: 1, bots: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as RegistryFile;
    if (!parsed || parsed.version !== 1 || typeof parsed.bots !== "object") {
      return { version: 1, bots: {} };
    }
    return parsed;
  } catch {
    return { version: 1, bots: {} };
  }
}

function writeRegistry(reg: RegistryFile, projectRoot = process.cwd()): void {
  const dir = registryDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = registryPath(projectRoot) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, registryPath(projectRoot));
}

function normalizeIdList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function getShareSlackBot(
  shareUuid: string,
  projectRoot = process.cwd(),
): ShareSlackBotConfig | null {
  const key = shareUuid.trim().toLowerCase();
  const reg = readRegistry(projectRoot);
  return reg.bots[key] || null;
}

export function listShareSlackBots(projectRoot = process.cwd()): ShareSlackBotConfig[] {
  return Object.values(readRegistry(projectRoot).bots);
}

export function upsertShareSlackBot(
  input: {
    shareUuid: string;
    botToken: string;
    signingSecret: string;
    appToken?: string;
    botDisplayName?: string;
    allowedUserIds?: string[] | string;
    allowedChannelIds?: string[] | string;
  },
  projectRoot = process.cwd(),
): ShareSlackBotConfig {
  const shareUuid = input.shareUuid.trim();
  if (!shareUuid) throw new Error("shareUuid required");
  if (!input.botToken?.trim()) throw new Error("botToken required");
  if (!input.signingSecret?.trim()) throw new Error("signingSecret required");

  const cfg: ShareSlackBotConfig = {
    shareUuid,
    botToken: input.botToken.trim(),
    signingSecret: input.signingSecret.trim(),
    appToken: input.appToken?.trim() || undefined,
    botDisplayName: input.botDisplayName?.trim() || undefined,
    allowedUserIds: normalizeIdList(input.allowedUserIds),
    allowedChannelIds: normalizeIdList(input.allowedChannelIds),
    updatedAt: new Date().toISOString(),
  };

  const reg = readRegistry(projectRoot);
  reg.bots[shareUuid.toLowerCase()] = cfg;
  writeRegistry(reg, projectRoot);
  return cfg;
}

export function deleteShareSlackBot(shareUuid: string, projectRoot = process.cwd()): boolean {
  const key = shareUuid.trim().toLowerCase();
  const reg = readRegistry(projectRoot);
  if (!reg.bots[key]) return false;
  delete reg.bots[key];
  writeRegistry(reg, projectRoot);
  return true;
}

/** Public-safe view (no secrets). */
export function publicSlackStatus(shareUuid: string, projectRoot = process.cwd()): {
  configured: boolean;
  botDisplayName?: string;
  allowedUserCount: number;
  allowedChannelCount: number;
} {
  const bot = getShareSlackBot(shareUuid, projectRoot);
  if (!bot) {
    return { configured: false, allowedUserCount: 0, allowedChannelCount: 0 };
  }
  return {
    configured: true,
    botDisplayName: bot.botDisplayName,
    allowedUserCount: bot.allowedUserIds.length,
    allowedChannelCount: bot.allowedChannelIds.length,
  };
}

export function isSlackSenderAllowed(
  bot: ShareSlackBotConfig,
  userId: string | undefined,
  channelId: string | undefined,
): boolean {
  if (bot.allowedUserIds.length > 0) {
    if (!userId || !bot.allowedUserIds.includes(userId)) return false;
  }
  if (bot.allowedChannelIds.length > 0) {
    if (!channelId || !bot.allowedChannelIds.includes(channelId)) return false;
  }
  return true;
}

/** Generate a Slack app manifest template for this share. */
export function buildSlackAppManifest(shareUuid: string, displayName: string, eventsUrl: string): Record<string, unknown> {
  const name = `Joshu Share Chat — ${displayName}`.slice(0, 80);
  return {
    display_information: {
      name,
      description: `Q&A bot scoped to shared files (${shareUuid}). Answers only from that share.`,
      background_color: "#0057ff",
    },
    features: {
      bot_user: {
        display_name: displayName.slice(0, 40) || "Share Chat",
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: ["chat:write", "im:history", "im:read", "im:write", "app_mentions:read"],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: eventsUrl,
        bot_events: ["message.im", "app_mention"],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
