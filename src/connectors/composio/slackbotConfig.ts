/** Composio Slackbot toolkit (bot identity + message triggers). Distinct from user `slack`. */
export const COMPOSIO_SLACKBOT_TOOLKIT_SLUG = "slackbot";

export const SLACKBOT_CREATE_CHANNEL = "SLACKBOT_CREATE_CHANNEL";
export const SLACKBOT_SEND_MESSAGE = "SLACKBOT_SEND_MESSAGE";
export const SLACKBOT_INVITE_USERS_TO_A_CHANNEL = "SLACKBOT_INVITE_USERS_TO_A_CHANNEL";
export const SLACKBOT_FIND_USER_BY_EMAIL_ADDRESS = "SLACKBOT_FIND_USER_BY_EMAIL_ADDRESS";
/** Push trigger when a human posts in a watched channel. */
export const SLACKBOT_CHANNEL_MESSAGE_RECEIVED = "SLACKBOT_CHANNEL_MESSAGE_RECEIVED";

export function composioSlackbotToolkitVersion(): string | undefined {
  return process.env.JOSHU_COMPOSIO_SLACKBOT_TOOLKIT_VERSION?.trim() || undefined;
}
