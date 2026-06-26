import fs from "node:fs";
import { readTelegramLink } from "../actionGuard/telegram.js";
import type { OwnerChannelConfig, OwnerChannelProvider, OwnerChannelStatus } from "./types.js";
import { ensureOwnerChannelDir, ownerChannelConfigPath } from "./paths.js";

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function readProvider(raw: unknown): OwnerChannelProvider | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "telegram" || value === "slack") return value;
  return null;
}

export function defaultOwnerChannelProvider(): OwnerChannelProvider {
  const env = envTrim("JOSHU_OWNER_CHANNEL_PROVIDER").toLowerCase();
  if (env === "slack") return "slack";
  return "telegram";
}

export function readOwnerChannelConfig(projectRoot = process.cwd()): OwnerChannelConfig | null {
  const file = ownerChannelConfigPath(projectRoot);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OwnerChannelConfig>;
    const provider = readProvider(parsed.provider);
    if (!provider) return null;
    return {
      provider,
      connectedAccountId:
        typeof parsed.connectedAccountId === "string" ? parsed.connectedAccountId.trim() : undefined,
      notify: {
        telegramChatId:
          typeof parsed.notify?.telegramChatId === "string"
            ? parsed.notify.telegramChatId.trim()
            : undefined,
        slackDmChannelId:
          typeof parsed.notify?.slackDmChannelId === "string"
            ? parsed.notify.slackDmChannelId.trim()
            : undefined,
      },
      gateMode:
        parsed.gateMode === "allowlist" || parsed.gateMode === "external_writes"
          ? parsed.gateMode
          : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeOwnerChannelConfig(config: OwnerChannelConfig, projectRoot = process.cwd()): void {
  ensureOwnerChannelDir(projectRoot);
  const file = ownerChannelConfigPath(projectRoot);
  if (!file) throw new Error("Could not resolve owner-channel config path");
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function hydrateOwnerChannelFromLegacy(projectRoot = process.cwd()): OwnerChannelConfig | null {
  const existing = readOwnerChannelConfig(projectRoot);
  if (existing) return existing;
  const legacy = readTelegramLink(projectRoot);
  if (!legacy) return null;
  const config: OwnerChannelConfig = {
    provider: "telegram",
    notify: { telegramChatId: String(legacy.chatId) },
    updatedAt: new Date().toISOString(),
  };
  writeOwnerChannelConfig(config, projectRoot);
  return config;
}

export function isOwnerChannelLinked(projectRoot = process.cwd()): boolean {
  const config = readOwnerChannelConfig(projectRoot) ?? hydrateOwnerChannelFromLegacy(projectRoot);
  if (!config) return false;
  if (config.provider === "telegram") return Boolean(config.notify.telegramChatId?.trim());
  return Boolean(config.notify.slackDmChannelId?.trim());
}

export function ownerChannelStatus(projectRoot = process.cwd()): OwnerChannelStatus {
  const config = readOwnerChannelConfig(projectRoot) ?? hydrateOwnerChannelFromLegacy(projectRoot);
  const legacyTelegramFallback = Boolean(envTrim("JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN"));
  if (!config) return { linked: false, legacyTelegramFallback };
  const linked =
    config.provider === "telegram"
      ? Boolean(config.notify.telegramChatId)
      : Boolean(config.notify.slackDmChannelId);
  return {
    linked,
    provider: config.provider,
    connectedAccountId: config.connectedAccountId,
    telegramChatId: config.notify.telegramChatId,
    slackDmChannelId: config.notify.slackDmChannelId,
    gateMode: config.gateMode,
    legacyTelegramFallback,
  };
}
