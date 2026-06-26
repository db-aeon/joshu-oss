import fs from "node:fs";
import { loadActionGuardPolicy, type ActionGuardPolicy } from "../actionGuard/policy.js";
import { ensureActionGuardDir, actionGuardPolicyPath } from "../actionGuard/paths.js";
import { ownerChannelStatus, readOwnerChannelConfig, writeOwnerChannelConfig } from "../ownerChannel/config.js";
import { isMcpToolPolicyEnabled, loadMcpToolPolicy } from "../mcpToolPolicy.js";
import { readHermesSlackMessagingConfig } from "../hermesMessagingEnv.js";
import { readLocalEnvOverrides, writeLocalEnvOverrides } from "./localEnv.js";

export type SettingSource = "env" | "local-env" | "policy-file" | "default";

export type SafetySettingsPayload = {
  actionGuard: {
    enabled: boolean;
    enabledSource: SettingSource;
    gateMode: ActionGuardPolicy["gateMode"];
    gateModeSource: SettingSource;
    browserGateWrites: boolean;
    browserGateSource: SettingSource;
    llmClassifier: boolean;
    llmClassifierSource: SettingSource;
    llmClassifierThreshold: number;
    bypassOwnerOnlyRecipients: boolean;
    approvalTimeoutMs: number;
    telegramAllowedUserIds: number[];
    guardedActions: string[];
    mcpToolPolicyEnabled: boolean;
    mcpToolPolicySource: SettingSource;
    terminalMailGuardEnabled: boolean;
    terminalMailGuardSource: SettingSource;
  };
  ownerChannel: ReturnType<typeof ownerChannelStatus> & {
    gateActive: boolean;
  };
  secrets: {
    actionGuardTelegramBotTokenConfigured: boolean;
    actionGuardTelegramBotTokenSource: SettingSource | "unset";
    hermesTelegramBotTokenConfigured: boolean;
    hermesTelegramBotTokenSource: SettingSource | "unset";
    slackBotTokenConfigured: boolean;
    slackBotTokenSource: SettingSource | "unset";
    slackAppTokenConfigured: boolean;
    slackAppTokenSource: SettingSource | "unset";
  };
  hermesMessaging: {
    slack: {
      configured: boolean;
      allowedUsers: string;
      homeChannel: string;
      allowedChannels: string;
    };
  };
  status: {
    ownerChannelLinked: boolean;
    telegramLinkedLegacy: boolean;
    gateEnabled: boolean;
  };
};

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function envSource(name: string, projectRoot: string): SettingSource {
  if (envTrim(name)) return "env";
  if (readLocalEnvOverrides(projectRoot)[name]) return "local-env";
  return "default";
}

function readPolicyFileRaw(projectRoot: string): Partial<ActionGuardPolicy> & { mcpToolPolicyEnabled?: boolean } {
  const file = actionGuardPolicyPath(projectRoot);
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ActionGuardPolicy> & {
      mcpToolPolicyEnabled?: boolean;
    };
  } catch {
    return {};
  }
}

function gateModeSource(projectRoot: string): SettingSource {
  if (envTrim("JOSHU_ACTION_GUARD_GATE_MODE")) return "env";
  const file = readPolicyFileRaw(projectRoot);
  if (file.gateMode) return "policy-file";
  return "default";
}

function enabledSource(projectRoot: string): SettingSource {
  if (envTrim("JOSHU_ACTION_GUARD_ENABLED")) return "env";
  const file = readPolicyFileRaw(projectRoot);
  if (typeof file.enabled === "boolean") return "policy-file";
  return "default";
}

function secretSource(name: string, projectRoot: string): SettingSource | "unset" {
  if (envTrim(name)) return "env";
  if (readLocalEnvOverrides(projectRoot)[name]) return "local-env";
  return "unset";
}

export function readSafetySettings(projectRoot = process.cwd()): SafetySettingsPayload {
  const policy = loadActionGuardPolicy(projectRoot);
  const owner = ownerChannelStatus(projectRoot);
  const local = readLocalEnvOverrides(projectRoot);
  const fileRaw = readPolicyFileRaw(projectRoot);

  const mcpFromEnv = envTrim("JOSHU_MCP_TOOL_POLICY_ENABLED");
  const mcpToolPolicyEnabled = mcpFromEnv
    ? !/^(0|false|no|off)$/i.test(mcpFromEnv)
    : typeof fileRaw.mcpToolPolicyEnabled === "boolean"
      ? fileRaw.mcpToolPolicyEnabled
      : isMcpToolPolicyEnabled();

  const terminalFromEnv = envTrim("JOSHU_TERMINAL_MAIL_GUARD");
  const terminalFromLocal = local.JOSHU_TERMINAL_MAIL_GUARD ?? "";
  const terminalMailGuardEnabled = terminalFromEnv
    ? !/^(0|false|no|off)$/i.test(terminalFromEnv)
    : terminalFromLocal
      ? !/^(0|false|no|off)$/i.test(terminalFromLocal)
      : true;

  const agToken =
    envTrim("JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN") || local.JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN || "";
  const hermesToken = envTrim("TELEGRAM_BOT_TOKEN") || local.TELEGRAM_BOT_TOKEN || "";
  const slackBot = envTrim("SLACK_BOT_TOKEN") || local.SLACK_BOT_TOKEN || "";
  const slackApp = envTrim("SLACK_APP_TOKEN") || local.SLACK_APP_TOKEN || "";
  const slackMessaging = readHermesSlackMessagingConfig(projectRoot);

  return {
    actionGuard: {
      enabled: policy.enabled,
      enabledSource: enabledSource(projectRoot),
      gateMode: policy.gateMode,
      gateModeSource: gateModeSource(projectRoot),
      browserGateWrites: policy.browserGateWrites,
      browserGateSource: envTrim("JOSHU_ACTION_GUARD_BROWSER_GATE")
        ? "env"
        : typeof fileRaw.browserGateWrites === "boolean"
          ? "policy-file"
          : "default",
      llmClassifier: policy.llmClassifier,
      llmClassifierSource: envTrim("JOSHU_ACTION_GUARD_LLM")
        ? "env"
        : typeof fileRaw.llmClassifier === "boolean"
          ? "policy-file"
          : "default",
      llmClassifierThreshold: policy.llmClassifierThreshold,
      bypassOwnerOnlyRecipients: policy.bypassOwnerOnlyRecipients,
      approvalTimeoutMs: policy.approvalTimeoutMs,
      telegramAllowedUserIds: policy.telegramAllowedUserIds,
      guardedActions: policy.guardedActions,
      mcpToolPolicyEnabled,
      mcpToolPolicySource: mcpFromEnv ? "env" : typeof fileRaw.mcpToolPolicyEnabled === "boolean" ? "policy-file" : "default",
      terminalMailGuardEnabled,
      terminalMailGuardSource: terminalFromEnv ? "env" : terminalFromLocal ? "local-env" : "default",
    },
    ownerChannel: {
      ...owner,
      gateActive: policy.enabled && owner.linked,
    },
    secrets: {
      actionGuardTelegramBotTokenConfigured: Boolean(agToken),
      actionGuardTelegramBotTokenSource: secretSource("JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN", projectRoot),
      hermesTelegramBotTokenConfigured: Boolean(hermesToken),
      hermesTelegramBotTokenSource: secretSource("TELEGRAM_BOT_TOKEN", projectRoot),
      slackBotTokenConfigured: Boolean(slackBot),
      slackBotTokenSource: secretSource("SLACK_BOT_TOKEN", projectRoot),
      slackAppTokenConfigured: Boolean(slackApp),
      slackAppTokenSource: secretSource("SLACK_APP_TOKEN", projectRoot),
    },
    hermesMessaging: {
      slack: {
        configured:
          Boolean(slackBot) && Boolean(slackApp) && Boolean(slackMessaging.allowedUsers.trim()),
        allowedUsers: slackMessaging.allowedUsers,
        homeChannel: slackMessaging.homeChannel,
        allowedChannels: slackMessaging.allowedChannels,
      },
    },
    status: {
      ownerChannelLinked: owner.linked,
      telegramLinkedLegacy: Boolean(readOwnerChannelConfig(projectRoot)?.notify.telegramChatId),
      gateEnabled: policy.enabled && (owner.linked || Boolean(agToken)),
    },
  };
}

export type SafetySettingsUpdate = {
  actionGuard?: {
    enabled?: boolean;
    gateMode?: ActionGuardPolicy["gateMode"];
    browserGateWrites?: boolean;
    llmClassifier?: boolean;
    llmClassifierThreshold?: number;
    bypassOwnerOnlyRecipients?: boolean;
    approvalTimeoutMs?: number;
    telegramAllowedUserIds?: number[];
    mcpToolPolicyEnabled?: boolean;
    terminalMailGuardEnabled?: boolean;
  };
  ownerChannel?: {
    provider?: "telegram" | "slack";
    telegramChatId?: string;
    slackDmChannelId?: string;
    connectedAccountId?: string;
    gateMode?: ActionGuardPolicy["gateMode"];
  };
  hermesMessaging?: {
    slackAllowedUsers?: string;
    slackHomeChannel?: string;
    slackAllowedChannels?: string;
  };
  secrets?: {
    actionGuardTelegramBotToken?: string;
    hermesTelegramBotToken?: string;
    slackBotToken?: string;
    slackAppToken?: string;
    clearActionGuardTelegramBotToken?: boolean;
    clearHermesTelegramBotToken?: boolean;
    clearSlackBotToken?: boolean;
    clearSlackAppToken?: boolean;
  };
};

export function writeSafetySettings(update: SafetySettingsUpdate, projectRoot = process.cwd()): SafetySettingsPayload {
  ensureActionGuardDir(projectRoot);
  const file = actionGuardPolicyPath(projectRoot);
  if (!file) throw new Error("Could not resolve action-guard policy path");

  const current = readPolicyFileRaw(projectRoot);
  const ag = update.actionGuard;
  if (ag) {
    const next = {
      ...current,
      ...(typeof ag.enabled === "boolean" ? { enabled: ag.enabled } : {}),
      ...(ag.gateMode ? { gateMode: ag.gateMode } : {}),
      ...(typeof ag.browserGateWrites === "boolean" ? { browserGateWrites: ag.browserGateWrites } : {}),
      ...(typeof ag.llmClassifier === "boolean" ? { llmClassifier: ag.llmClassifier } : {}),
      ...(typeof ag.llmClassifierThreshold === "number" ? { llmClassifierThreshold: ag.llmClassifierThreshold } : {}),
      ...(typeof ag.bypassOwnerOnlyRecipients === "boolean"
        ? { bypassOwnerOnlyRecipients: ag.bypassOwnerOnlyRecipients }
        : {}),
      ...(typeof ag.approvalTimeoutMs === "number" ? { approvalTimeoutMs: ag.approvalTimeoutMs } : {}),
      ...(Array.isArray(ag.telegramAllowedUserIds) ? { telegramAllowedUserIds: ag.telegramAllowedUserIds } : {}),
      ...(typeof ag.mcpToolPolicyEnabled === "boolean" ? { mcpToolPolicyEnabled: ag.mcpToolPolicyEnabled } : {}),
    };
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }

  const oc = update.ownerChannel;
  if (oc) {
    const existing = readOwnerChannelConfig(projectRoot);
    writeOwnerChannelConfig(
      {
        provider: oc.provider ?? existing?.provider ?? "telegram",
        connectedAccountId: oc.connectedAccountId ?? existing?.connectedAccountId,
        notify: {
          telegramChatId: oc.telegramChatId ?? existing?.notify.telegramChatId,
          slackDmChannelId: oc.slackDmChannelId ?? existing?.notify.slackDmChannelId,
        },
        gateMode: oc.gateMode ?? existing?.gateMode ?? ag?.gateMode,
        updatedAt: new Date().toISOString(),
      },
      projectRoot,
    );
  }

  const secrets = update.secrets;
  if (secrets) {
    const localUpdates: Record<string, string> = {};
    if (secrets.actionGuardTelegramBotToken?.trim()) {
      localUpdates.JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN = secrets.actionGuardTelegramBotToken.trim();
    }
    if (secrets.hermesTelegramBotToken?.trim()) {
      localUpdates.TELEGRAM_BOT_TOKEN = secrets.hermesTelegramBotToken.trim();
    }
    if (secrets.slackBotToken?.trim()) {
      localUpdates.SLACK_BOT_TOKEN = secrets.slackBotToken.trim();
    }
    if (secrets.slackAppToken?.trim()) {
      localUpdates.SLACK_APP_TOKEN = secrets.slackAppToken.trim();
    }
    if (Object.keys(localUpdates).length > 0) {
      writeLocalEnvOverrides(localUpdates, projectRoot);
    }
    if (secrets.clearActionGuardTelegramBotToken) {
      writeLocalEnvOverrides({ JOSHU_ACTION_GUARD_TELEGRAM_BOT_TOKEN: "" }, projectRoot);
    }
    if (secrets.clearHermesTelegramBotToken) {
      writeLocalEnvOverrides({ TELEGRAM_BOT_TOKEN: "" }, projectRoot);
    }
    if (secrets.clearSlackBotToken) {
      writeLocalEnvOverrides({ SLACK_BOT_TOKEN: "" }, projectRoot);
    }
    if (secrets.clearSlackAppToken) {
      writeLocalEnvOverrides({ SLACK_APP_TOKEN: "" }, projectRoot);
    }
  }

  const messaging = update.hermesMessaging;
  if (messaging) {
    const localUpdates: Record<string, string> = {};
    if (messaging.slackAllowedUsers !== undefined) {
      localUpdates.SLACK_ALLOWED_USERS = messaging.slackAllowedUsers.trim();
    }
    if (messaging.slackHomeChannel !== undefined) {
      localUpdates.SLACK_HOME_CHANNEL = messaging.slackHomeChannel.trim();
    }
    if (messaging.slackAllowedChannels !== undefined) {
      localUpdates.SLACK_ALLOWED_CHANNELS = messaging.slackAllowedChannels.trim();
    }
    if (Object.keys(localUpdates).length > 0) {
      writeLocalEnvOverrides(localUpdates, projectRoot);
    }
  }

  if (typeof ag?.terminalMailGuardEnabled === "boolean") {
    writeLocalEnvOverrides(
      { JOSHU_TERMINAL_MAIL_GUARD: ag.terminalMailGuardEnabled ? "1" : "0" },
      projectRoot,
    );
  }

  // Touch mcp policy cache consumers by returning fresh read
  void loadMcpToolPolicy();
  return readSafetySettings(projectRoot);
}
