/**
 * Gmail incremental sync via Composio GMAIL_LIST_HISTORY + GMAIL_GET_PROFILE.
 * @see https://docs.composio.dev/toolkits/gmail — LIST_HISTORY, GET_PROFILE
 */
import { fetchGmailProfile, listGmailHistoryRecords, type GmailExecuteContext } from "./gmail.js";

export type GmailHistorySyncResult = {
  threadIds: string[];
  latestHistoryId?: string;
  historyTooOld: boolean;
};

function collectThreadId(out: Set<string>, row: Record<string, unknown>): void {
  const msg =
    row.message && typeof row.message === "object"
      ? (row.message as Record<string, unknown>)
      : row;
  const threadId = typeof msg.threadId === "string" ? msg.threadId : undefined;
  const id = typeof msg.id === "string" ? msg.id : undefined;
  if (threadId && threadId !== id) out.add(threadId);
  else if (threadId) out.add(threadId);
  else if (id) out.add(id);
}

function parseHistoryRecords(data: unknown): { threadIds: Set<string>; latestHistoryId?: string } {
  const threadIds = new Set<string>();
  let latestHistoryId: string | undefined;

  const roots: unknown[] = [];
  if (Array.isArray(data)) roots.push(...data);
  else if (data && typeof data === "object") {
    const root = data as Record<string, unknown>;
    if (root.data && typeof root.data === "object") roots.push(root.data);
    else roots.push(root);
  }

  for (const chunk of roots) {
    if (!chunk || typeof chunk !== "object") continue;
    const obj = chunk as Record<string, unknown>;
    if (typeof obj.historyId === "string") latestHistoryId = obj.historyId;

    const history = obj.history;
    if (!Array.isArray(history)) continue;

    for (const entry of history) {
      if (!entry || typeof entry !== "object") continue;
      const h = entry as Record<string, unknown>;
      if (typeof h.id === "string") latestHistoryId = h.id;

      for (const key of ["messagesAdded", "labelsAdded", "labelsRemoved", "messagesDeleted"] as const) {
        const list = h[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (item && typeof item === "object") collectThreadId(threadIds, item as Record<string, unknown>);
        }
      }
    }
  }

  return { threadIds, latestHistoryId };
}

function isHistoryTooOldError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("historyidtooold") ||
    m.includes("history id") && m.includes("too old") ||
    m.includes("404") && m.includes("history")
  );
}

/** Threads touched since startHistoryId; empty list means no mailbox changes. */
export async function fetchGmailThreadsFromHistory(
  projectRoot: string,
  ctx: GmailExecuteContext,
  startHistoryId: string,
): Promise<GmailHistorySyncResult> {
  const threadIds = new Set<string>();
  let latestHistoryId: string | undefined;
  let pageToken: string | undefined;

  try {
    do {
      const page = await listGmailHistoryRecords(projectRoot, ctx, {
        startHistoryId,
        pageToken,
        maxResults: 500,
      });
      const parsed = parseHistoryRecords(page.data);
      for (const tid of parsed.threadIds) threadIds.add(tid);
      if (parsed.latestHistoryId) latestHistoryId = parsed.latestHistoryId;
      pageToken = page.nextPageToken;
      if (page.latestHistoryId) latestHistoryId = page.latestHistoryId;
    } while (pageToken);

    return { threadIds: [...threadIds], latestHistoryId, historyTooOld: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isHistoryTooOldError(message)) {
      return { threadIds: [], historyTooOld: true };
    }
    throw err;
  }
}

/** Profile historyId seeds or refreshes the incremental cursor after each sync. */
export async function fetchGmailHistoryCursor(
  projectRoot: string,
  ctx: GmailExecuteContext,
): Promise<string | undefined> {
  const profile = await fetchGmailProfile(projectRoot, ctx);
  return profile.historyId;
}
