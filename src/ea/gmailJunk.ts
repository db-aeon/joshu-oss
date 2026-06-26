/**
 * Gmail label gate for Phase 1 ingest (ea-for-joshu step 1).
 * Matching threads must not be mirrored, stubbed, or scheduling-classified.
 * Label-based only — the mail classifier is a separate step.
 */
const GMAIL_INGEST_SKIP_LABELS = new Set([
  // Owner/agent scratchpad and outbound — not actionable inbound
  "DRAFT",
  "SENT",
  "OUTBOX",
  // System folders
  "SPAM",
  "TRASH",
  // Bulk categories (newsletters, promos, etc.)
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
  "CATEGORY_UPDATES",
]);

export function isGmailJunk(labels: string[] | undefined): boolean {
  if (!labels?.length) return false;
  for (const id of labels) {
    if (GMAIL_INGEST_SKIP_LABELS.has(id)) return true;
  }
  return false;
}

/** First matching ingest-skip label (for logs). */
export function gmailIngestSkipLabel(labels: string[] | undefined): string | undefined {
  if (!labels?.length) return undefined;
  return labels.find((id) => GMAIL_INGEST_SKIP_LABELS.has(id));
}

/** True when the latest message in a hydrated thread carries ingest-skip labels. */
export function isGmailJunkThread(messages: Array<{ labelIds?: string[] }>): boolean {
  if (messages.length === 0) return false;
  return isGmailJunk(messages[messages.length - 1]?.labelIds);
}
