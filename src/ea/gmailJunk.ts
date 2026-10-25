/**
 * Gmail label gate for Phase 1 ingest (ea-for-joshu step 1).
 * Label-based only — the mail classifier is a separate step.
 * Spec: gmail-sync (change gmail-owner-reply-handoff).
 */

/** Labels that tell the direction of one message, not the kind of the thread. */
const GMAIL_OUTGOING_LABELS = new Set(["SENT", "DRAFT", "OUTBOX"]);

/** Labels that tell the kind of the thread: system folders and bulk categories. */
const GMAIL_BULK_LABELS = new Set([
  "SPAM",
  "TRASH",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
  "CATEGORY_UPDATES",
]);

/** Labels that are never triaged: outgoing mail must not create triage work. */
const GMAIL_INGEST_SKIP_LABELS = new Set([...GMAIL_OUTGOING_LABELS, ...GMAIL_BULK_LABELS]);

function firstLabelIn(labels: string[] | undefined, set: Set<string>): string | undefined {
  return labels?.find((id) => set.has(id));
}

export function isGmailJunk(labels: string[] | undefined): boolean {
  return firstLabelIn(labels, GMAIL_INGEST_SKIP_LABELS) !== undefined;
}

/** First matching ingest-skip label (for logs). */
export function gmailIngestSkipLabel(labels: string[] | undefined): string | undefined {
  return firstLabelIn(labels, GMAIL_INGEST_SKIP_LABELS);
}

/**
 * Pre-filter for one message before the sync reads its thread. A `SENT` message
 * keeps its thread, because the thread can hold an inbound message.
 */
export function isGmailSkippedMessage(labels: string[] | undefined): boolean {
  return firstLabelIn(labels, GMAIL_BULK_LABELS) !== undefined || Boolean(labels?.includes("DRAFT"));
}

export type GmailThreadIngestKind =
  | { kind: "skip"; label?: string }
  /** Owner Gmail reply (openspec/glossary.md): mirror, do not triage. */
  | { kind: "owner_reply" }
  | { kind: "inbound" };

/** Decide skip, mirror, or triage from all messages of a thread (spec gmail-sync). */
export function gmailThreadIngestKind(
  messages: Array<{ labelIds?: string[] }>,
): GmailThreadIngestKind {
  const latest = messages[messages.length - 1]?.labelIds;
  const bulk = firstLabelIn(latest, GMAIL_BULK_LABELS);
  if (bulk) return { kind: "skip", label: bulk };
  const pending = latest?.find((id) => id === "DRAFT" || id === "OUTBOX");
  if (pending) return { kind: "skip", label: pending };
  if (!latest?.includes("SENT")) return { kind: "inbound" };

  const lastInbound = [...messages]
    .reverse()
    .find((m) => firstLabelIn(m.labelIds, GMAIL_OUTGOING_LABELS) === undefined);
  if (lastInbound && !firstLabelIn(lastInbound.labelIds, GMAIL_BULK_LABELS)) {
    return { kind: "owner_reply" };
  }
  return { kind: "skip", label: "SENT" };
}
