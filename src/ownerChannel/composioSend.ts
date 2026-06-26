import { getOrCreateComposioSession, isComposioEnabled, resolveComposioUserId } from "../composioApi.js";
import { composioClient } from "../connectors/composio/client.js";
import { composioSlackToolkitVersion } from "../connectors/composio/slackConfig.js";

type ExecuteResult = { successful?: boolean; error?: string; data?: unknown };

type ComposioConnectedAccountRow = {
  id: string;
  status?: string;
  toolkit?: { slug?: string };
  appUniqueId?: string;
};

function executeVersionParams(): { version: string } | { dangerouslySkipVersionCheck: true } {
  const version = composioSlackToolkitVersion();
  return version ? { version } : { dangerouslySkipVersionCheck: true };
}

async function resolveToolkitConnectedAccountId(
  toolkitSlug: string,
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

  const result = await listFn({ userIds: [userId], toolkitSlugs: [toolkitSlug] });
  const needle = toolkitSlug.toLowerCase();
  const row = (result.items ?? []).find((item) => {
    const slug = item.toolkit?.slug?.toLowerCase() ?? item.appUniqueId?.toLowerCase() ?? "";
    const active = (item.status ?? "ACTIVE").toUpperCase() === "ACTIVE";
    return active && (slug === needle || slug.includes(needle));
  });
  return row?.id;
}

/** Internal Composio delivery for owner-channel notifications — never action-guarded. */
async function composioExecuteInternal(
  toolSlug: string,
  toolkitSlug: string,
  args: Record<string, unknown>,
  connectedAccountId: string | undefined,
  projectRoot: string,
): Promise<ExecuteResult> {
  await getOrCreateComposioSession(projectRoot);
  const userId = resolveComposioUserId(projectRoot);
  const accountId = await resolveToolkitConnectedAccountId(toolkitSlug, connectedAccountId, projectRoot);
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

export async function sendTelegramViaComposio(
  opts: {
    chatId: string;
    text: string;
    connectedAccountId?: string;
    replyMarkup?: Record<string, unknown>;
  },
  projectRoot: string,
): Promise<void> {
  const args: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (opts.replyMarkup) args.reply_markup = opts.replyMarkup;
  const result = await composioExecuteInternal(
    "TELEGRAM_SEND_MESSAGE",
    "telegram",
    args,
    opts.connectedAccountId,
    projectRoot,
  );
  if (result.successful === false || result.error) {
    throw new Error(result.error || "TELEGRAM_SEND_MESSAGE failed");
  }
}

export async function sendSlackViaComposio(
  opts: {
    channel: string;
    text: string;
    connectedAccountId?: string;
    blocks?: unknown[];
  },
  projectRoot: string,
): Promise<void> {
  const args: Record<string, unknown> = { channel: opts.channel };
  if (opts.blocks?.length) {
    args.blocks = opts.blocks;
    args.fallback_text = opts.text;
  } else {
    args.markdown_text = opts.text;
  }
  const result = await composioExecuteInternal(
    "SLACK_SEND_MESSAGE",
    "slack",
    args,
    opts.connectedAccountId,
    projectRoot,
  );
  if (result.successful === false || result.error) {
    throw new Error(result.error || "SLACK_SEND_MESSAGE failed");
  }
}

export type SlackHistoryMessage = {
  ts: string;
  text: string;
  user?: string;
  subtype?: string;
  bot_id?: string;
};

function unwrapSlackMessages(data: unknown): SlackHistoryMessage[] {
  const root = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const nested = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  const raw = nested.messages;
  if (!Array.isArray(raw)) return [];
  const out: SlackHistoryMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const ts = typeof row.ts === "string" ? row.ts : "";
    const text = typeof row.text === "string" ? row.text : "";
    if (!ts || !text.trim()) continue;
    out.push({
      ts,
      text,
      user: typeof row.user === "string" ? row.user : undefined,
      subtype: typeof row.subtype === "string" ? row.subtype : undefined,
      bot_id: typeof row.bot_id === "string" ? row.bot_id : undefined,
    });
  }
  return out;
}

/** Read recent messages from a Slack channel (internal — not action-guarded). */
export async function fetchSlackConversationHistory(
  channelId: string,
  opts: { oldestSec?: number; connectedAccountId?: string },
  projectRoot: string,
): Promise<SlackHistoryMessage[]> {
  const args: Record<string, unknown> = {
    channel: channelId,
    limit: 10,
  };
  if (typeof opts.oldestSec === "number" && Number.isFinite(opts.oldestSec)) {
    args.oldest = String(opts.oldestSec);
    args.inclusive = true;
  }
  const result = await composioExecuteInternal(
    "SLACK_FETCH_CONVERSATION_HISTORY",
    "slack",
    args,
    opts.connectedAccountId,
    projectRoot,
  );
  if (result.successful === false || result.error) {
    throw new Error(result.error || "SLACK_FETCH_CONVERSATION_HISTORY failed");
  }
  return unwrapSlackMessages(result.data ?? result);
}
