/**
 * Gmail + Nylas duplicate detection at ingest.
 * Same physical send often appears in owner Gmail and agent Nylas — process once.
 *
 * Primary key: RFC 5322 Message-ID (stable across mailboxes).
 * Fallback: subject + received minute + body preview hash.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { connectorStatePath } from "../connectors/paths.js";
import { normalizeRfcMessageId, rfcMessageDedupKey } from "../connectors/rfcMessageId.js";
import type { InboundMailClassification } from "./classifier.js";
import type { TriageProvider } from "./triageTypes.js";
import type { MailAgentAuthorization } from "./agentAuthorization.js";

export type MailDedupRecord = {
  /** Primary thread that was processed. */
  primary_key: string;
  provider: TriageProvider;
  thread_id: string;
  processed_at: string;
  subject?: string;
  rfc_message_id?: string;
  /** Latest Gmail/Nylas message id processed for this dedup key. */
  message_id?: string;
  /** `processing` while classify/route in flight; `done` when complete. */
  status: "processing" | "done";
  classification?: InboundMailClassification;
  authorization?: MailAgentAuthorization;
};

type MailDedupState = {
  /** dedup_key → record */
  keys: Record<string, MailDedupRecord>;
};

const PROCESSING_STALE_MS = 5 * 60 * 1000;

function dedupStatePath(filesRoot: string): string {
  return connectorStatePath(filesRoot, "mail-dedup.json");
}

async function readState(filesRoot: string): Promise<MailDedupState> {
  try {
    const raw = await readFile(dedupStatePath(filesRoot), "utf8");
    const parsed = JSON.parse(raw) as MailDedupState;
    return parsed?.keys ? parsed : { keys: {} };
  } catch {
    return { keys: {} };
  }
}

async function writeState(filesRoot: string, state: MailDedupState): Promise<void> {
  const filePath = dedupStatePath(filesRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeSubject(subject?: string): string {
  return (subject ?? "")
    .trim()
    .toLowerCase()
    .replace(/^(re|fwd|fw):\s*/gi, "")
    .replace(/\s+/g, " ");
}

/** Round ISO timestamp to nearest minute for cross-provider matching. */
function receivedMinuteKey(receivedAt?: string): string {
  const d = receivedAt ? new Date(receivedAt) : new Date();
  if (Number.isNaN(d.getTime())) return "unknown";
  d.setSeconds(0, 0);
  return d.toISOString();
}

function bodyPreviewHash(bodyPreview?: string): string {
  return createHash("sha256")
    .update((bodyPreview ?? "").slice(0, 500))
    .digest("hex")
    .slice(0, 16);
}

/** Dedup key — prefers RFC Message-ID when available. */
export function buildMailDedupKey(opts: {
  subject?: string;
  receivedAt?: string;
  bodyPreview?: string;
  rfcMessageId?: string | null;
}): string {
  const rfc = normalizeRfcMessageId(opts.rfcMessageId);
  if (rfc) return rfcMessageDedupKey(rfc);
  const subject = normalizeSubject(opts.subject);
  const minute = receivedMinuteKey(opts.receivedAt);
  return `body:${subject}|${minute}|${bodyPreviewHash(opts.bodyPreview)}`;
}

function threadKey(provider: TriageProvider, threadId: string): string {
  return `${provider}:${threadId}`;
}

function isStaleProcessing(record: MailDedupRecord): boolean {
  if (record.status !== "processing") return false;
  const ts = Date.parse(record.processed_at);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > PROCESSING_STALE_MS;
}

export type MailDedupCheckResult =
  | { action: "process"; dedupKey: string }
  | {
      action: "skip_duplicate";
      dedupKey: string;
      primary: MailDedupRecord;
      cachedClassification?: InboundMailClassification;
    };

/**
 * Claim ingest for this message or return skip with optional cached classification.
 * Call before classifyInboundMail.
 */
export async function prepareMailIngestDedup(opts: {
  filesRoot: string;
  provider: TriageProvider;
  threadId: string;
  subject?: string;
  receivedAt?: string;
  bodyPreview?: string;
  rfcMessageId?: string | null;
}): Promise<MailDedupCheckResult> {
  const dedupKey = buildMailDedupKey(opts);
  const tk = threadKey(opts.provider, opts.threadId);
  const state = await readState(opts.filesRoot);
  const existing = state.keys[dedupKey];

  if (existing) {
    if (existing.primary_key === tk) {
      return { action: "process", dedupKey };
    }
    if (existing.status === "done") {
      return {
        action: "skip_duplicate",
        dedupKey,
        primary: existing,
        cachedClassification: existing.classification,
      };
    }
    if (existing.status === "processing" && !isStaleProcessing(existing)) {
      return {
        action: "skip_duplicate",
        dedupKey,
        primary: existing,
      };
    }
  }

  const rfc = normalizeRfcMessageId(opts.rfcMessageId);
  state.keys[dedupKey] = {
    primary_key: tk,
    provider: opts.provider,
    thread_id: opts.threadId,
    processed_at: new Date().toISOString(),
    subject: opts.subject,
    ...(rfc ? { rfc_message_id: rfc } : {}),
    status: "processing",
  };
  await writeState(opts.filesRoot, state);
  return { action: "process", dedupKey };
}

/** @deprecated Use prepareMailIngestDedup. */
export async function checkMailDedup(opts: {
  filesRoot: string;
  provider: TriageProvider;
  threadId: string;
  subject?: string;
  receivedAt?: string;
  bodyPreview?: string;
  rfcMessageId?: string | null;
}): Promise<MailDedupCheckResult> {
  return prepareMailIngestDedup(opts);
}

export async function markMailDedupProcessed(opts: {
  filesRoot: string;
  dedupKey: string;
  provider: TriageProvider;
  threadId: string;
  subject?: string;
  rfcMessageId?: string | null;
  messageId?: string;
  classification?: InboundMailClassification;
  authorization?: MailAgentAuthorization;
}): Promise<void> {
  const state = await readState(opts.filesRoot);
  const rfc = normalizeRfcMessageId(opts.rfcMessageId);
  state.keys[opts.dedupKey] = {
    primary_key: threadKey(opts.provider, opts.threadId),
    provider: opts.provider,
    thread_id: opts.threadId,
    processed_at: new Date().toISOString(),
    subject: opts.subject,
    ...(rfc ? { rfc_message_id: rfc } : {}),
    ...(opts.messageId?.trim() ? { message_id: opts.messageId.trim() } : {}),
    status: "done",
    ...(opts.classification ? { classification: opts.classification } : {}),
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
  };
  pruneOldEntries(state);
  await writeState(opts.filesRoot, state);
}

/** Lookup stored authorization for a message id (outbound / scheduling API gates). */
export async function lookupMailIngestAuthorization(
  filesRoot: string,
  messageId: string,
): Promise<MailAgentAuthorization | null> {
  const id = messageId.trim();
  if (!id) return null;
  const state = await readState(filesRoot);
  for (const rec of Object.values(state.keys)) {
    if (rec.message_id === id && rec.authorization) return rec.authorization;
  }
  return null;
}

function pruneOldEntries(state: MailDedupState): void {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [key, rec] of Object.entries(state.keys)) {
    const t = new Date(rec.processed_at).getTime();
    if (Number.isNaN(t) || t < cutoff) delete state.keys[key];
  }
}

/** Canonical id for Kanban idempotency — RFC Message-ID when available. */
export function mailIngressCanonicalId(opts: {
  rfcMessageId?: string | null;
  messageId: string;
}): string {
  const rfc = normalizeRfcMessageId(opts.rfcMessageId);
  if (rfc) return rfcMessageDedupKey(rfc);
  return opts.messageId.trim();
}

function safeIdempotencySegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9._:@-]+/g, "_").slice(0, 120);
}

export function mailIngressTaskIdempotencyKey(canonicalId: string): string {
  return `ea-mail-ingress-${safeIdempotencySegment(canonicalId)}`;
}

export function mailTrackTaskIdempotencyKey(canonicalId: string): string {
  return `ea-mail-track-${safeIdempotencySegment(canonicalId)}`;
}

export function schedulingIngressTaskIdempotencyKey(canonicalId: string): string {
  return `ea-ingress-${safeIdempotencySegment(canonicalId)}`;
}

export function schedulingMeetingTaskIdempotencyKeyFromMessage(canonicalId: string): string {
  return `ea-meet-msg-${safeIdempotencySegment(canonicalId)}`;
}
