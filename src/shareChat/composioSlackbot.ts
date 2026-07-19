/**
 * Composio Slackbot helpers for share-chat KB channels.
 * Distinct from owner-channel user `slack` toolkit (`composioSend.ts`).
 */

import { getOrCreateComposioSession, isComposioEnabled, resolveComposioUserId } from "../composioApi.js";
import { composioClient } from "../connectors/composio/client.js";
import {
  COMPOSIO_SLACKBOT_TOOLKIT_SLUG,
  SLACKBOT_CHANNEL_MESSAGE_RECEIVED,
  SLACKBOT_CREATE_CHANNEL,
  SLACKBOT_FIND_USER_BY_EMAIL_ADDRESS,
  SLACKBOT_INVITE_USERS_TO_A_CHANNEL,
  SLACKBOT_SEND_MESSAGE,
  composioSlackbotToolkitVersion,
} from "../connectors/composio/slackbotConfig.js";
import { resolveJoshuIdentity } from "../joshuIdentity.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";

type ExecuteResult = { successful?: boolean; error?: string; data?: unknown };

type ComposioConnectedAccountRow = {
  id: string;
  status?: string;
  toolkit?: { slug?: string };
  appUniqueId?: string;
};

function executeVersionParams(): { version: string } | { dangerouslySkipVersionCheck: true } {
  const version = composioSlackbotToolkitVersion();
  return version ? { version } : { dangerouslySkipVersionCheck: true };
}

async function resolveSlackbotConnectedAccountId(
  explicit: string | undefined,
  projectRoot: string,
): Promise<string | undefined> {
  if (explicit?.trim()) return explicit.trim();
  if (!isComposioEnabled()) return undefined;

  await getOrCreateComposioSession(projectRoot);
  const userId = resolveComposioUserId(projectRoot);
  const composio = composioClient();
  const listFn = (
    composio.connectedAccounts as {
      list: (params: { userIds: string[]; toolkitSlugs?: string[] }) => Promise<{
        items?: ComposioConnectedAccountRow[];
      }>;
    }
  ).list;

  const result = await listFn({
    userIds: [userId],
    toolkitSlugs: [COMPOSIO_SLACKBOT_TOOLKIT_SLUG],
  });
  const needle = COMPOSIO_SLACKBOT_TOOLKIT_SLUG.toLowerCase();
  const row = (result.items ?? []).find((item) => {
    const slug = item.toolkit?.slug?.toLowerCase() ?? item.appUniqueId?.toLowerCase() ?? "";
    const active = (item.status ?? "ACTIVE").toUpperCase() === "ACTIVE";
    return active && (slug === needle || slug.includes(needle));
  });
  return row?.id;
}

export async function isComposioSlackbotConnected(projectRoot = process.cwd()): Promise<boolean> {
  if (!isComposioEnabled()) return false;
  try {
    const id = await resolveSlackbotConnectedAccountId(undefined, projectRoot);
    return Boolean(id);
  } catch {
    return false;
  }
}

async function composioSlackbotExecute(
  toolSlug: string,
  args: Record<string, unknown>,
  connectedAccountId: string | undefined,
  projectRoot: string,
): Promise<ExecuteResult> {
  await getOrCreateComposioSession(projectRoot);
  const userId = resolveComposioUserId(projectRoot);
  const accountId = await resolveSlackbotConnectedAccountId(connectedAccountId, projectRoot);
  if (!accountId) {
    return { successful: false, error: "composio_slackbot_required" };
  }
  const composio = composioClient();
  const tools = composio.tools as {
    execute: (slug: string, params: Record<string, unknown>) => Promise<ExecuteResult>;
  };
  return tools.execute(toolSlug, {
    userId,
    connectedAccountId: accountId,
    arguments: args,
    ...executeVersionParams(),
  });
}

/** Walk common Composio/Slack response shapes for a channel id. */
export function extractSlackChannelId(data: unknown): string | null {
  const seen = new Set<unknown>();
  const visit = (node: unknown): string | null => {
    if (node == null || seen.has(node)) return null;
    if (typeof node === "string") {
      const s = node.trim();
      // Slack channel IDs: C… public, G… private/group legacy, or C for both modern
      if (/^[CGD][A-Z0-9]{8,}$/i.test(s)) return s;
      return null;
    }
    if (typeof node !== "object") return null;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    for (const key of ["id", "channel_id", "channelId"]) {
      const v = obj[key];
      if (typeof v === "string" && /^[CGD][A-Z0-9]{8,}$/i.test(v.trim())) return v.trim();
    }
    if (obj.channel) {
      const nested = visit(obj.channel);
      if (nested) return nested;
    }
    for (const v of Object.values(obj)) {
      const nested = visit(v);
      if (nested) return nested;
    }
    return null;
  };
  return visit(data);
}

function looksLikeNameTaken(error: string): boolean {
  const e = error.toLowerCase();
  return e.includes("name_taken") || e.includes("name taken") || e.includes("already_exists");
}

export async function createSlackbotChannel(
  opts: {
    name: string;
    isPrivate?: boolean;
    connectedAccountId?: string;
  },
  projectRoot = process.cwd(),
): Promise<{ channelId: string; channelName: string; isPrivate: boolean }> {
  const name = opts.name.trim().toLowerCase();
  const isPrivate = opts.isPrivate !== false;
  const result = await composioSlackbotExecute(
    SLACKBOT_CREATE_CHANNEL,
    { name, is_private: isPrivate },
    opts.connectedAccountId,
    projectRoot,
  );
  if (result.successful === false || result.error) {
    const err = result.error || "SLACKBOT_CREATE_CHANNEL failed";
    if (looksLikeNameTaken(err)) {
      const taken = new Error("channel_name_taken");
      (taken as Error & { cause?: string }).cause = err;
      throw taken;
    }
    throw new Error(err);
  }
  const channelId = extractSlackChannelId(result.data);
  if (!channelId) {
    throw new Error("channel_create_no_id");
  }
  return { channelId, channelName: name, isPrivate };
}

/** Extract a Slack user id (U… / W…) from Composio/Slack payloads. */
export function extractSlackUserId(data: unknown): string | null {
  const seen = new Set<unknown>();
  const visit = (node: unknown): string | null => {
    if (node == null || seen.has(node)) return null;
    if (typeof node === "string") {
      const s = node.trim();
      if (/^[UW][A-Z0-9]{8,}$/i.test(s)) return s;
      return null;
    }
    if (typeof node !== "object") return null;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    for (const key of ["id", "user_id", "userId"]) {
      const v = obj[key];
      if (typeof v === "string" && /^[UW][A-Z0-9]{8,}$/i.test(v.trim())) return v.trim();
    }
    if (obj.user) {
      const nested = visit(obj.user);
      if (nested) return nested;
    }
    for (const v of Object.values(obj)) {
      const nested = visit(v);
      if (nested) return nested;
    }
    return null;
  };
  return visit(data);
}

export async function inviteUsersToSlackbotChannel(
  opts: {
    channelId: string;
    userIds: string[];
    connectedAccountId?: string;
  },
  projectRoot = process.cwd(),
): Promise<void> {
  const users = opts.userIds.map((u) => u.trim()).filter(Boolean);
  if (!users.length) return;
  const result = await composioSlackbotExecute(
    SLACKBOT_INVITE_USERS_TO_A_CHANNEL,
    { channel: opts.channelId, users: users.join(","), force: true },
    opts.connectedAccountId,
    projectRoot,
  );
  if (result.successful === false || result.error) {
    throw new Error(result.error || "SLACKBOT_INVITE_USERS_TO_A_CHANNEL failed");
  }
}

export async function findSlackbotUserIdByEmail(
  email: string,
  connectedAccountId: string | undefined,
  projectRoot = process.cwd(),
): Promise<string | null> {
  const addr = email.trim().toLowerCase();
  if (!addr || !addr.includes("@")) return null;
  const result = await composioSlackbotExecute(
    SLACKBOT_FIND_USER_BY_EMAIL_ADDRESS,
    { email: addr },
    connectedAccountId,
    projectRoot,
  );
  if (result.successful === false || result.error) {
    console.warn("[share-chat/slackbot] email lookup failed:", result.error || "unknown");
    return null;
  }
  return extractSlackUserId(result.data);
}

/** Best-effort owner emails for inviting into a newly created private channel. */
export function resolveOwnerInviteEmails(projectRoot = process.cwd()): string[] {
  const emails = new Set<string>();
  try {
    const identity = resolveJoshuIdentity(projectRoot);
    if (identity.owner.email?.trim()) emails.add(identity.owner.email.trim().toLowerCase());
  } catch {
    /* ignore */
  }
  const paths = resolveJoshuFilesPaths(projectRoot);
  const arozUser = paths?.arozUser?.trim();
  if (arozUser?.includes("@")) emails.add(arozUser.toLowerCase());
  const envEmail =
    process.env.JOSHU_OWNER_EMAIL?.trim() ||
    process.env.OWNER_EMAIL?.trim() ||
    process.env.HERMES_OWNER_EMAIL?.trim() ||
    "";
  if (envEmail.includes("@")) emails.add(envEmail.toLowerCase());
  return [...emails];
}

/**
 * Invite the Joshu owner into a bot-created private channel so it appears in their Slack sidebar.
 * Failures are soft — channel still exists for the bot.
 */
export async function inviteOwnerToSlackbotChannel(
  channelId: string,
  projectRoot = process.cwd(),
): Promise<{ invitedUserIds: string[]; emailsTried: string[]; error?: string }> {
  const emails = resolveOwnerInviteEmails(projectRoot);
  const userIds: string[] = [];
  for (const email of emails) {
    try {
      const id = await findSlackbotUserIdByEmail(email, undefined, projectRoot);
      if (id && !userIds.includes(id)) userIds.push(id);
    } catch (err) {
      console.warn(
        "[share-chat/slackbot] find user by email failed:",
        email,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (!userIds.length) {
    return {
      invitedUserIds: [],
      emailsTried: emails,
      error: "owner_slack_user_not_found",
    };
  }
  try {
    await inviteUsersToSlackbotChannel({ channelId, userIds }, projectRoot);
    return { invitedUserIds: userIds, emailsTried: emails };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[share-chat/slackbot] invite owner failed:", msg);
    return { invitedUserIds: [], emailsTried: emails, error: msg };
  }
}

export async function sendSlackbotMessage(
  opts: {
    channel: string;
    text: string;
    connectedAccountId?: string;
    threadTs?: string;
  },
  projectRoot = process.cwd(),
): Promise<void> {
  const args: Record<string, unknown> = {
    channel: opts.channel,
    markdown_text: opts.text,
  };
  if (opts.threadTs) args.thread_ts = opts.threadTs;
  const result = await composioSlackbotExecute(
    SLACKBOT_SEND_MESSAGE,
    args,
    opts.connectedAccountId,
    projectRoot,
  );
  if (result.successful === false || result.error) {
    throw new Error(result.error || "SLACKBOT_SEND_MESSAGE failed");
  }
}

/** Enable push trigger for human top-level messages in one channel. */
export async function createChannelMessageTrigger(
  opts: {
    channelId: string;
    connectedAccountId?: string;
  },
  projectRoot = process.cwd(),
): Promise<string> {
  if (!isComposioEnabled()) throw new Error("composio_disabled");

  // Composio refuses trigger create until a Slackbot webhook endpoint exists.
  const { ensureSlackbotWebhookEndpoint } = await import(
    "../connectors/composio/slackbotWebhook.js"
  );
  try {
    await ensureSlackbotWebhookEndpoint(projectRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `slackbot_webhook_required: ${msg}. In Connectors → Slackbot, add Signing Secret + App-Level Token (xapp-) and Save again.`,
    );
  }

  await getOrCreateComposioSession(projectRoot);
  const userId = resolveComposioUserId(projectRoot);
  const accountId = await resolveSlackbotConnectedAccountId(opts.connectedAccountId, projectRoot);
  if (!accountId) throw new Error("composio_slackbot_required");

  const composio = composioClient();
  const created = await composio.triggers.create(userId, SLACKBOT_CHANNEL_MESSAGE_RECEIVED, {
    connectedAccountId: accountId,
    triggerConfig: {
      channel_id: opts.channelId,
      is_bot_message: false,
      is_thread_reply: false,
    },
  });
  return created.triggerId;
}

export async function deleteTriggerInstance(
  triggerInstanceId: string,
  _projectRoot = process.cwd(),
): Promise<void> {
  if (!triggerInstanceId?.trim()) return;
  if (!isComposioEnabled()) return;
  const composio = composioClient();
  try {
    await composio.triggers.delete(triggerInstanceId.trim());
  } catch (err) {
    console.warn(
      "[share-chat/slackbot] trigger delete failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
