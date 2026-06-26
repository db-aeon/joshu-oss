import type { ActionGuardGateMode } from "../actionGuard/policy.js";

export type OwnerChannelProvider = "telegram" | "slack";

export type OwnerChannelConfig = {
  provider: OwnerChannelProvider;
  connectedAccountId?: string;
  notify: {
    telegramChatId?: string;
    slackDmChannelId?: string;
  };
  gateMode?: ActionGuardGateMode;
  updatedAt: string;
};

export type OwnerChannelStatus = {
  linked: boolean;
  provider?: OwnerChannelProvider;
  connectedAccountId?: string;
  telegramChatId?: string;
  slackDmChannelId?: string;
  gateMode?: ActionGuardGateMode;
  legacyTelegramFallback: boolean;
};
