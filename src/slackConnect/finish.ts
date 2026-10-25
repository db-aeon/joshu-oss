/**
 * Finish a Slack chat connection: check the tokens, save them, find the Slack
 * user of the owner, and let the companion write first. Slack connect and a
 * manual save of new tokens both end here.
 */
import { resolveOwnerEmails } from "../ea/agentAuthorization.js";
import { checkSlackAppToken, checkSlackBotToken } from "../hermesSlackSetup.js";
import { resolveJoshuIdentity } from "../joshuIdentity.js";
import { resolveEnvWithLocalFallback, writeLocalEnvOverrides } from "../safetySettings/localEnv.js";
import {
  slackAppsManifestDelete,
  slackChatPostMessage,
  slackConversationsOpen,
  slackUsersLookupByEmail,
  type FetchLike,
} from "./slackApi.js";

/** Comma-separated Slack user IDs, with `userId` added once. */
export function addSlackUser(list: string, userId: string): string {
  const ids = list
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (userId && !ids.includes(userId)) ids.push(userId);
  return ids.join(",");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The first Slack DM from the companion. The text is fixed; no model call. */
export function slackWelcomeText(projectRoot: string): string {
  const identity = resolveJoshuIdentity(projectRoot);
  const companion = identity.name.trim() || "your companion";
  const ownerName = identity.owner.displayName?.trim() ?? "";
  const firstName = ownerName && ownerName.toLowerCase() !== "owner" ? ownerName.split(/\s+/)[0] : "";
  const greeting = firstName ? `Hi ${firstName}, it's ${companion}.` : `Hi, it's ${companion}.`;
  return `${greeting} You can message me here anytime, like a coworker. Ask me about your day, your email, or anything you want done.`;
}

/** Slack user ID of the first owner address that Slack knows, or null. */
export async function lookupOwnerSlackUser(
  projectRoot: string,
  botToken: string,
  fetchImpl?: FetchLike,
): Promise<string | null> {
  for (const email of resolveOwnerEmails(projectRoot)) {
    const userId = await slackUsersLookupByEmail(botToken, email, fetchImpl);
    if (userId) return userId;
  }
  return null;
}

/**
 * Open the DM channel between the companion and `userId`. When
 * `SLACK_HOME_CHANNEL` is empty, save the DM channel as the Slack home channel.
 * Opening a DM sends no message.
 */
export async function openSlackOwnerDm(
  projectRoot: string,
  botToken: string,
  userId: string,
  fetchImpl?: FetchLike,
): Promise<{ channelId: string; homeChannelSet: boolean }> {
  const channelId = await slackConversationsOpen(botToken, userId, fetchImpl);
  let homeChannelSet = false;
  if (channelId && !resolveEnvWithLocalFallback("SLACK_HOME_CHANNEL", projectRoot)) {
    writeLocalEnvOverrides({ SLACK_HOME_CHANNEL: channelId }, projectRoot);
    homeChannelSet = true;
  }
  return { channelId, homeChannelSet };
}

/** Send `text` as a DM from the companion to `userId` (see openSlackOwnerDm). */
export async function sendSlackOwnerDm(
  projectRoot: string,
  botToken: string,
  userId: string,
  text: string,
  fetchImpl?: FetchLike,
): Promise<{ channelId: string; homeChannelSet: boolean }> {
  const dm = await openSlackOwnerDm(projectRoot, botToken, userId, fetchImpl);
  await slackChatPostMessage(botToken, dm.channelId, text, fetchImpl);
  return dm;
}

/** Hint while the Hermes gateway restart waits for a busy gateway. */
export function slackWaitingText(projectRoot: string): string {
  const companion = resolveJoshuIdentity(projectRoot).name.trim() || "Your companion";
  return `${companion} is finishing a task and will message you in Slack in a few minutes.`;
}

export type PrepareSlackConnectionInput = {
  projectRoot: string;
  botToken: string;
  appToken: string;
  /** Slack connect: the user who clicked Allow. Manual path: unset. */
  ownerUserId?: string;
  /** Slack connect: the new box Slack app. */
  appId?: string;
  /** Slack connect: deletes the earlier box Slack app of the same workspace. */
  configurationToken?: string;
  /** The caller already checked the app token with Slack. */
  tokensChecked?: boolean;
  fetchImpl?: FetchLike;
};

export type PreparedSlackConnection = {
  team: string;
  ownerUserId: string;
  /** DM channel with the owner, or "" when the owner is not known. */
  dmChannelId: string;
  homeChannelSet: boolean;
  warnings: string[];
};

/**
 * Check the tokens, find the Slack user of the owner, save the Slack env, and
 * open the DM channel with the owner. Sends no message: the first DM waits
 * until the Hermes gateway has the new tokens (sendSlackWelcome).
 */
export async function prepareSlackConnection(input: PrepareSlackConnectionInput): Promise<PreparedSlackConnection> {
  const { projectRoot, fetchImpl } = input;
  const [bot, app] = await Promise.all([
    checkSlackBotToken(input.botToken, fetchImpl),
    input.tokensChecked ? Promise.resolve({ ok: true as const }) : checkSlackAppToken(input.appToken, fetchImpl),
  ]);
  if (!bot.ok) throw new Error(`Slack rejected the bot token: ${bot.error}`);
  if (!app.ok) throw new Error(`Slack rejected the app token: ${app.error}`);

  const warnings: string[] = [];
  const allowedUsers = resolveEnvWithLocalFallback("SLACK_ALLOWED_USERS", projectRoot);
  let ownerUserId = input.ownerUserId?.trim() ?? "";
  if (!ownerUserId && !allowedUsers) {
    ownerUserId = (await lookupOwnerSlackUser(projectRoot, input.botToken, fetchImpl).catch((err) => {
      warnings.push(`Owner lookup by email failed: ${errorText(err)}`);
      return null;
    })) ?? "";
  }

  const previousAppId = resolveEnvWithLocalFallback("SLACK_APP_ID", projectRoot);
  const updates: Record<string, string> = {
    SLACK_BOT_TOKEN: input.botToken.trim(),
    SLACK_APP_TOKEN: input.appToken.trim(),
  };
  if (ownerUserId) updates.SLACK_ALLOWED_USERS = addSlackUser(allowedUsers, ownerUserId);
  if (input.appId) updates.SLACK_APP_ID = input.appId;
  writeLocalEnvOverrides(updates, projectRoot);

  if (input.appId && input.configurationToken && previousAppId && previousAppId !== input.appId) {
    await slackAppsManifestDelete(input.configurationToken, previousAppId, fetchImpl).catch((err) => {
      warnings.push(`Could not delete the earlier Slack app ${previousAppId}: ${errorText(err)}`);
    });
  }

  // An owner who is already linked keeps the old Slack user; DM the first one.
  const dmUserId = ownerUserId || allowedUsers.split(",")[0]?.trim() || "";
  let dmChannelId = "";
  let homeChannelSet = false;
  if (dmUserId) {
    // Before the restart, so that the Hermes gateway starts with SLACK_HOME_CHANNEL.
    try {
      const dm = await openSlackOwnerDm(projectRoot, input.botToken, dmUserId, fetchImpl);
      dmChannelId = dm.channelId;
      homeChannelSet = dm.homeChannelSet;
    } catch (err) {
      warnings.push(`Could not open the Slack DM: ${errorText(err)}`);
    }
  }
  return { team: bot.team, ownerUserId: dmUserId, dmChannelId, homeChannelSet, warnings };
}

/** The first DM. Call it only after the Hermes gateway has the new tokens. */
export async function sendSlackWelcome(
  projectRoot: string,
  botToken: string,
  prepared: PreparedSlackConnection,
  fetchImpl?: FetchLike,
): Promise<boolean> {
  if (!prepared.dmChannelId) return false;
  try {
    await slackChatPostMessage(botToken, prepared.dmChannelId, slackWelcomeText(projectRoot), fetchImpl);
    return true;
  } catch (err) {
    prepared.warnings.push(`Could not send the first Slack DM: ${errorText(err)}`);
    return false;
  }
}

export type FinishSlackConnectionInput = PrepareSlackConnectionInput & {
  /**
   * Sync `~/.hermes/.env`, restart the Hermes gateway (with the busy wait), and
   * resolve when the new gateway answers. Calls `onWaiting` while a busy
   * gateway holds the restart.
   */
  applyToHermes: (onWaiting: () => void) => Promise<void>;
  /** Gets a hint for the owner while the restart waits. */
  onWaiting?: (hint: string) => void;
};

export type FinishSlackConnectionResult = PreparedSlackConnection & { welcomeSent: boolean };

/**
 * Prepare, wait for the Hermes gateway restart, then send the first DM. So
 * when the owner answers the first DM at once, the gateway already has the
 * Slack connection and answers.
 */
export async function finishSlackConnection(input: FinishSlackConnectionInput): Promise<FinishSlackConnectionResult> {
  const prepared = await prepareSlackConnection(input);
  await input.applyToHermes(() => input.onWaiting?.(slackWaitingText(input.projectRoot)));
  const welcomeSent = await sendSlackWelcome(input.projectRoot, input.botToken, prepared, input.fetchImpl);
  return { ...prepared, welcomeSent };
}
