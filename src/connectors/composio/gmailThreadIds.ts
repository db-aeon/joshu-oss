/**
 * Normalize Gmail list payloads where Composio omits threadId (falls back to message id in rowToSummary).
 * Without this, each inbox message is synced/classified as its own "thread" on every cron tick.
 */
import { isGmailJunk } from "../../ea/gmailJunk.js";
import { fetchGmailMessageById, type GmailExecuteContext, type GmailMessageSummary } from "./gmail.js";

export function gmailSummaryNeedsThreadResolve(m: GmailMessageSummary): boolean {
  return !m.threadId || m.threadId === m.id;
}

/** Canonical thread id from hydrated thread messages (never use bare message id when avoidable). */
export function canonicalThreadIdFromMessages(
  messages: GmailMessageSummary[],
  fallback: string,
): string {
  for (const m of messages) {
    if (m.threadId && m.threadId !== m.id) return m.threadId;
  }
  const last = messages[messages.length - 1];
  if (last?.threadId && last.threadId !== last.id) return last.threadId;
  return fallback;
}

/**
 * Build unique Gmail thread ids for sync from inbox/all-mail summaries.
 * Resolves missing threadId via GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID (bounded).
 */
export async function resolveGmailThreadIdsFromSummaries(
  projectRoot: string,
  summaries: GmailMessageSummary[],
  ctx: GmailExecuteContext,
  opts: { maxResolves?: number } = {},
): Promise<string[]> {
  const byThread = new Map<string, GmailMessageSummary>();
  const toResolve: GmailMessageSummary[] = [];

  for (const m of summaries) {
    if (isGmailJunk(m.labelIds)) continue;
    if (gmailSummaryNeedsThreadResolve(m)) {
      toResolve.push(m);
      continue;
    }
    const prev = byThread.get(m.threadId);
    if (!prev || (m.messageTimestamp ?? 0) > (prev.messageTimestamp ?? 0)) {
      byThread.set(m.threadId, m);
    }
  }

  const maxResolves = opts.maxResolves ?? 50;
  let resolved = 0;
  for (const m of toResolve) {
    if (resolved >= maxResolves) break;
    if (isGmailJunk(m.labelIds)) continue;
    try {
      const full = await fetchGmailMessageById(projectRoot, m.id, ctx);
      if (!full || isGmailJunk(full.labelIds)) continue;
      if (full.threadId && full.threadId !== full.id) {
        const prev = byThread.get(full.threadId);
        if (!prev || (full.messageTimestamp ?? 0) > (prev.messageTimestamp ?? 0)) {
          byThread.set(full.threadId, full);
        }
        resolved += 1;
      }
    } catch {
      /* skip unresolvable row */
    }
  }

  return [...byThread.entries()]
    .filter(([, summary]) => !isGmailJunk(summary.labelIds))
    .map(([threadId]) => threadId);
}
