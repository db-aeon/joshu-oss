/** Shared triage/scheduling types — keep out of triageStub.ts to avoid circular imports. */

import type { InboundMailClassification as MailClassification } from "./classifier.js";

export type TriageProvider = "gmail" | "nylas";

export type InboundMailClassification = MailClassification;

export type AfterMirrorThreadInput = {
  filesRoot: string;
  provider: TriageProvider;
  threadId: string;
  accountKey?: string;
  sourcePath: string;
  subject?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  /** Mailbox owner email (Gmail sync). */
  accountEmail?: string;
  receivedAt?: string;
  labels?: string[];
  /** When false, write stub only (no OpenRouter scheduling classifier). */
  classify?: boolean;
  /** When true, skip triage stub creation (Day 0 historical sync). */
  skipTriageStubs?: boolean;
  /** Joshu app root for `.joshu/nylas/agent.json` (defaults to process.cwd()). */
  projectRoot?: string;
  /** Latest message id in thread — used for scheduling ingress dedupe. */
  messageId?: string;
  /** RFC 5322 Message-ID for latest message — cross-mailbox dedup + Kanban idempotency. */
  rfcMessageId?: string;
  /** When set and equals messageId, skip scheduling classifier (unchanged latest / backfill). */
  priorLatestMessageId?: string;
};
