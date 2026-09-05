/**
 * Owner mail on the agent Nylas inbox must always enter EA ingress/reply —
 * never silently archived as info/owner_sent_update when the body has real content.
 */
import { isPureAckOrEmptyBody } from "../connectors/emailReplyQuotes.js";
import type { InboundMailClassification } from "./classifier.js";
import { normalizeForIngressRouting } from "./classifier.js";
import { parseEmailAddress } from "./mailTypes.js";
import type { TriageProvider } from "./triageTypes.js";

/** Status / completion markers common in owner thread replies. */
export const OWNER_STATUS_UPDATE_BODY =
  /\b(?:-\s*)?(?:DONE|done|completed|complete|finished|handled|KEEP|keep open|still open)\b|\bcarryover\b|\bmark(?:ed)?\s+(?:as\s+)?done\b/i;

export function normalizeOwnerEmailSet(ownerEmails: Iterable<string>): Set<string> {
  const owners = new Set<string>();
  for (const raw of ownerEmails) {
    const addr = parseEmailAddress(raw) ?? raw.trim().toLowerCase();
    if (addr?.includes("@")) owners.add(addr);
  }
  return owners;
}

/** True when latest message is from the owner on the agent Nylas grant inbox. */
export function isOwnerAgentInboxSender(input: {
  provider?: TriageProvider;
  from?: string;
  ownerEmails: Iterable<string>;
}): boolean {
  if ((input.provider ?? "").trim().toLowerCase() !== "nylas") return false;
  const fromAddr = parseEmailAddress(input.from);
  if (!fromAddr) return false;
  return normalizeOwnerEmailSet(input.ownerEmails).has(fromAddr);
}

/** Body has more than a one-line ack — lists, DONE markers, questions, etc. */
export function isOwnerSubstantiveBody(bodyPreview?: string): boolean {
  const preview = (bodyPreview ?? "").trim();
  if (!preview || isPureAckOrEmptyBody(preview)) return false;
  if (OWNER_STATUS_UPDATE_BODY.test(preview)) return true;
  if (/^[•\-\*]\s/m.test(preview)) return true;
  if (/\?/.test(preview)) return true;
  return preview.length >= 16;
}

/**
 * Deterministic gate: skip LLM misroutes (info / owner_sent_update) for owner agent inbox.
 * Pure acks (Thanks, OK) may still flow through the classifier as info.
 */
export function shouldForceTrackOwnerAgentInbox(input: {
  provider?: TriageProvider;
  from?: string;
  bodyPreview?: string;
  ownerEmails: Iterable<string>;
}): boolean {
  return (
    isOwnerAgentInboxSender(input) && isOwnerSubstantiveBody(input.bodyPreview)
  );
}

/** Fixed track classification for substantive owner→agent Nylas mail. */
export function ownerAgentInboxMailClassification(
  reason = "Substantive owner mail on agent Nylas inbox",
): InboundMailClassification {
  return normalizeForIngressRouting({
    disposition: "track",
    confidence: 0.97,
    category: "owner_note",
    project_slug: null,
    is_new_track: false,
    reason,
  });
}

/** Morning/shutdown pointer replies — owner-reply worker may load ea-morning-review / ea-shutdown. */
export function isCadenceReviewReplySubject(subject?: string): boolean {
  const s = subject?.trim() ?? "";
  if (!/^re:/i.test(s)) return false;
  return /\b(?:morning review|evening summary|shutdown|shutdown ready)\b/i.test(s);
}
