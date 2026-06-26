/**
 * Composio Gmail toolkit (pinned version) — sync, read, send.
 * @see https://docs.composio.dev/toolkits/gmail
 */
import { getOrCreateComposioSession, resolveComposioUserId } from "../../composioApi.js";
import { composioToolsExecute } from "../../composio/executeWithModifiers.js";
import { COMPOSIO_GMAIL_TOOLKIT_VERSION } from "./gmailConfig.js";
import {
  extractMessageBody,
  parseInternalDate,
  parseRfcMessageId,
  parseRecipientAddresses,
  parseSender,
  parseSubject,
} from "./gmailBodies.js";
import { normalizeRfcMessageId } from "../rfcMessageId.js";

export type GmailExecuteContext = {
  connectedAccountId: string;
};

export type GmailMessageSummary = {
  id: string;
  threadId: string;
  subject?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  snippet?: string;
  body?: string;
  /** RFC 5322 Message-ID header (normalized), when present. */
  rfcMessageId?: string;
  /** Milliseconds since epoch (Gmail internalDate). */
  messageTimestamp?: number;
  labelIds?: string[];
  unread?: boolean;
};

export type GmailProfile = {
  emailAddress?: string;
  messagesTotal?: number;
  threadsTotal?: number;
  /** Seeds GMAIL_LIST_HISTORY incremental sync (Composio GMAIL_GET_PROFILE). */
  historyId?: string;
};

async function executeGmail(
  projectRoot: string,
  toolSlug: string,
  args: Record<string, unknown>,
  ctx: GmailExecuteContext,
): Promise<{ successful: boolean; data?: unknown; error?: string }> {
  const userId = resolveComposioUserId(projectRoot);
  try {
    const result = await composioToolsExecute(
      toolSlug,
      {
        userId,
        connectedAccountId: ctx.connectedAccountId,
        arguments: args,
        version: COMPOSIO_GMAIL_TOOLKIT_VERSION,
      },
      projectRoot,
    );
    const row = result as { data?: unknown; error?: string; successful?: boolean };
    if (row.successful === false || row.error) {
      return { successful: false, error: row.error || `${toolSlug} failed` };
    }
    return { successful: true, data: row.data ?? result };
  } catch (err) {
    return { successful: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function unwrapData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const root = data as Record<string, unknown>;
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

function rowToSummary(row: Record<string, unknown>): GmailMessageSummary | null {
  const id =
    typeof row.messageId === "string"
      ? row.messageId
      : typeof row.id === "string"
        ? row.id
        : "";
  const threadId = typeof row.threadId === "string" ? row.threadId : id;
  if (!id) return null;
  const labelIds = Array.isArray(row.labelIds)
    ? row.labelIds.filter((l): l is string => typeof l === "string")
    : undefined;
  const body = extractMessageBody(row);
  const rfcRaw = parseRfcMessageId(row);
  const rfcMessageId = normalizeRfcMessageId(rfcRaw) ?? undefined;
  return {
    id,
    threadId,
    subject: parseSubject(row),
    from: parseSender(row),
    to: parseRecipientAddresses(row, "To"),
    cc: parseRecipientAddresses(row, "Cc"),
    bcc: parseRecipientAddresses(row, "Bcc"),
    snippet: typeof row.snippet === "string" ? row.snippet : body.slice(0, 240),
    body,
    rfcMessageId,
    messageTimestamp: parseInternalDate(row),
    labelIds,
    unread: labelIds?.includes("UNREAD"),
  };
}

function extractMessageList(data: unknown): GmailMessageSummary[] {
  const root = unwrapData(data);
  const thread =
    root.thread && typeof root.thread === "object" ? (root.thread as Record<string, unknown>) : undefined;
  const messages =
    root.messages ??
    thread?.messages ??
    (Array.isArray(data) ? data : undefined) ??
    [];
  if (!Array.isArray(messages)) return [];
  const out: GmailMessageSummary[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const summary = rowToSummary(m as Record<string, unknown>);
    if (summary) out.push(summary);
  }
  return out;
}

/** Paginated fetch for the last N days from one label set. */
async function fetchGmailMessagesForLabels(
  projectRoot: string,
  ctx: GmailExecuteContext,
  opts: {
    maxResults: number;
    days: number;
    labelIds: string[];
    queryExtra?: string;
    /** Lightweight list — hydrate per thread via GMAIL_FETCH_MESSAGE_BY_THREAD_ID. */
    idsOnly?: boolean;
    includePayload?: boolean;
    verbose?: boolean;
  },
): Promise<GmailMessageSummary[]> {
  const query = [`newer_than:${opts.days}d`, opts.queryExtra].filter(Boolean).join(" ");
  const all: GmailMessageSummary[] = [];
  let pageToken: string | undefined;
  const idsOnly = opts.idsOnly === true;
  const includePayload = opts.includePayload ?? !idsOnly;
  const verbose = opts.verbose ?? !idsOnly;

  while (all.length < opts.maxResults) {
    const pageSize = Math.min(50, opts.maxResults - all.length);
    const result = await executeGmail(
      projectRoot,
      "GMAIL_FETCH_EMAILS",
      {
        user_id: "me",
        max_results: pageSize,
        label_ids: opts.labelIds,
        query,
        include_payload: includePayload,
        verbose,
        ids_only: idsOnly,
        page_token: pageToken,
      },
      ctx,
    );
    if (!result.successful) {
      throw new Error(result.error || "GMAIL_FETCH_EMAILS failed");
    }
    const batch = extractMessageList(result.data);
    if (batch.length === 0) break;
    all.push(...batch);
    const root = unwrapData(result.data);
    const next =
      typeof root.nextPageToken === "string"
        ? root.nextPageToken
        : typeof root.next_page_token === "string"
          ? root.next_page_token
          : undefined;
    if (!next) break;
    pageToken = next;
  }

  return all;
}

/** Paginated inbox fetch for the last N days. */
export async function fetchGmailInboxMessages(
  projectRoot: string,
  ctx: GmailExecuteContext,
  opts: { maxResults?: number; days?: number; idsOnly?: boolean } = {},
): Promise<GmailMessageSummary[]> {
  const maxResults = opts.maxResults ?? 100;
  const days = opts.days ?? 7;
  const all = await fetchGmailMessagesForLabels(projectRoot, ctx, {
    maxResults,
    days,
    labelIds: ["INBOX"],
    idsOnly: opts.idsOnly,
  });

  all.sort((a, b) => (b.messageTimestamp ?? 0) - (a.messageTimestamp ?? 0));
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  return all
    .filter((m) => (m.messageTimestamp ?? 0) >= cutoff || !m.messageTimestamp)
    .slice(0, maxResults);
}

/** Day 0 / broad sync: INBOX + SENT + IMPORTANT, deduped by message id. */
export async function fetchGmailAllMailMessages(
  projectRoot: string,
  ctx: GmailExecuteContext,
  opts: { maxResults?: number; days?: number } = {},
): Promise<GmailMessageSummary[]> {
  const maxResults = opts.maxResults ?? 500;
  const days = opts.days ?? 30;
  const perLabelBudget = Math.ceil(maxResults / 3);
  const labelSets: string[][] = [["INBOX"], ["SENT"], ["IMPORTANT"]];
  const byId = new Map<string, GmailMessageSummary>();

  for (const labelIds of labelSets) {
    const batch = await fetchGmailMessagesForLabels(projectRoot, ctx, {
      maxResults: perLabelBudget,
      days,
      labelIds,
    });
    for (const m of batch) {
      if (!byId.has(m.id)) byId.set(m.id, m);
    }
    if (byId.size >= maxResults) break;
  }

  const all = [...byId.values()];
  all.sort((a, b) => (b.messageTimestamp ?? 0) - (a.messageTimestamp ?? 0));
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  return all
    .filter((m) => (m.messageTimestamp ?? 0) >= cutoff || !m.messageTimestamp)
    .slice(0, maxResults);
}

/** Full thread messages with bodies (for mirror sync). Paginates and dedupes by message id. */
export async function fetchGmailThreadMessages(
  projectRoot: string,
  threadId: string,
  ctx: GmailExecuteContext,
): Promise<GmailMessageSummary[]> {
  const byId = new Map<string, GmailMessageSummary>();
  let pageToken: string | undefined;

  do {
    const result = await executeGmail(
      projectRoot,
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      {
        user_id: "me",
        thread_id: threadId,
        page_token: pageToken,
      },
      ctx,
    );
    if (!result.successful) {
      throw new Error(result.error || "GMAIL_FETCH_MESSAGE_BY_THREAD_ID failed");
    }
    for (const m of extractMessageList(result.data)) {
      byId.set(m.id, m);
    }
    const root = unwrapData(result.data);
    const next =
      typeof root.nextPageToken === "string"
        ? root.nextPageToken
        : typeof root.next_page_token === "string"
          ? root.next_page_token
          : undefined;
    pageToken = next;
  } while (pageToken);

  const messages = [...byId.values()];
  messages.sort((a, b) => (a.messageTimestamp ?? 0) - (b.messageTimestamp ?? 0));
  return messages;
}

export async function fetchGmailMessageById(
  projectRoot: string,
  messageId: string,
  ctx: GmailExecuteContext,
): Promise<GmailMessageSummary | null> {
  const result = await executeGmail(
    projectRoot,
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    {
      user_id: "me",
      message_id: messageId,
      format: "full",
      include_payload: true,
    },
    ctx,
  );
  if (!result.successful) {
    throw new Error(result.error || "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID failed");
  }
  const root = unwrapData(result.data);
  const row = (root.message && typeof root.message === "object" ? root.message : root) as Record<
    string,
    unknown
  >;
  return rowToSummary(row);
}

export async function fetchGmailProfile(
  projectRoot: string,
  ctx: GmailExecuteContext,
): Promise<GmailProfile> {
  const result = await executeGmail(projectRoot, "GMAIL_GET_PROFILE", { user_id: "me" }, ctx);
  if (!result.successful) throw new Error(result.error || "GMAIL_GET_PROFILE failed");
  const root = unwrapData(result.data);
  const historyId =
    typeof root.historyId === "string"
      ? root.historyId
      : typeof root.history_id === "string"
        ? root.history_id
        : undefined;
  return {
    emailAddress: typeof root.emailAddress === "string" ? root.emailAddress : undefined,
    messagesTotal: typeof root.messagesTotal === "number" ? root.messagesTotal : undefined,
    threadsTotal: typeof root.threadsTotal === "number" ? root.threadsTotal : undefined,
    historyId,
  };
}

export type GmailHistoryPage = {
  data: unknown;
  nextPageToken?: string;
  latestHistoryId?: string;
};

/** Paginated GMAIL_LIST_HISTORY — use fetchGmailThreadsFromHistory for thread id extraction. */
export async function listGmailHistoryRecords(
  projectRoot: string,
  ctx: GmailExecuteContext,
  opts: {
    startHistoryId: string;
    pageToken?: string;
    maxResults?: number;
    historyTypes?: Array<"messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved">;
  },
): Promise<GmailHistoryPage> {
  const result = await executeGmail(
    projectRoot,
    "GMAIL_LIST_HISTORY",
    {
      user_id: "me",
      start_history_id: opts.startHistoryId,
      page_token: opts.pageToken,
      max_results: opts.maxResults ?? 100,
      ...(opts.historyTypes?.length ? { history_types: opts.historyTypes } : {}),
    },
    ctx,
  );
  if (!result.successful) {
    throw new Error(result.error || "GMAIL_LIST_HISTORY failed");
  }
  const root = unwrapData(result.data);
  const next =
    typeof root.nextPageToken === "string"
      ? root.nextPageToken
      : typeof root.next_page_token === "string"
        ? root.next_page_token
        : undefined;
  const latestHistoryId =
    typeof root.historyId === "string"
      ? root.historyId
      : typeof root.history_id === "string"
        ? root.history_id
        : undefined;
  return { data: result.data, nextPageToken: next, latestHistoryId };
}

export async function sendGmailEmail(
  projectRoot: string,
  ctx: GmailExecuteContext,
  opts: {
    to: string;
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    isHtml?: boolean;
  },
): Promise<{ messageId?: string }> {
  const result = await executeGmail(
    projectRoot,
    "GMAIL_SEND_EMAIL",
    {
      recipient_email: opts.to,
      subject: opts.subject,
      body: opts.body,
      is_html: opts.isHtml === true,
      ...(opts.cc?.length ? { cc: opts.cc } : {}),
      ...(opts.bcc?.length ? { bcc: opts.bcc } : {}),
    },
    ctx,
  );
  if (!result.successful) throw new Error(result.error || "GMAIL_SEND_EMAIL failed");
  const root = unwrapData(result.data);
  const messageId =
    typeof root.id === "string"
      ? root.id
      : typeof root.messageId === "string"
        ? root.messageId
        : undefined;
  return { messageId };
}

export async function replyGmailThread(
  projectRoot: string,
  ctx: GmailExecuteContext,
  opts: {
    threadId: string;
    body: string;
    recipientEmail: string;
    cc?: string[];
    bcc?: string[];
    isHtml?: boolean;
  },
): Promise<void> {
  const result = await executeGmail(
    projectRoot,
    "GMAIL_REPLY_TO_THREAD",
    {
      user_id: "me",
      thread_id: opts.threadId,
      message_body: opts.body,
      recipient_email: opts.recipientEmail,
      is_html: opts.isHtml === true,
      ...(opts.cc?.length ? { cc: opts.cc } : {}),
      ...(opts.bcc?.length ? { bcc: opts.bcc } : {}),
    },
    ctx,
  );
  if (!result.successful) throw new Error(result.error || "GMAIL_REPLY_TO_THREAD failed");
}

export async function modifyGmailLabels(
  projectRoot: string,
  messageId: string,
  ctx: GmailExecuteContext,
  patch: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<void> {
  const result = await executeGmail(
    projectRoot,
    "GMAIL_ADD_LABEL_TO_EMAIL",
    {
      user_id: "me",
      message_id: messageId,
      add_label_ids: patch.addLabelIds,
      remove_label_ids: patch.removeLabelIds,
    },
    ctx,
  );
  if (!result.successful) throw new Error(result.error || "GMAIL_ADD_LABEL_TO_EMAIL failed");
}
