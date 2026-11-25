/**
 * Outsider send record: the box remembers each email that the companion sent to somebody
 * other than the owner, and each owner-OK question it sent. Mail authorization reads it to
 * know whether the companion already wrote to an outsider on a thread, because the text and
 * the metadata of a mail mirror do not tell who received an earlier message of the companion.
 *
 * File: `<files>/connectors/_state/outsider-sends.jsonl`, one JSON object per line. The first
 * line has `kind: "start"`; a message of the companion older than that line counts as proven
 * (migration rule for threads from before the record existed).
 */
import fs from "node:fs";
import path from "node:path";
import { connectorStatePath } from "../connectors/paths.js";
import type { MailThreadMessageMeta } from "../connectors/mirror.js";
import { normalizeMailSubjectForThreadCompare } from "../nylas/replySubject.js";
import { parseEmailAddress } from "./schedulingTypes.js";

export const OUTSIDER_SEND_RECORD_FILE = "outsider-sends.jsonl";

type StartLine = { kind: "start"; started_at: string };
type OutsiderSendLine = {
  kind: "outsider_send";
  at: string;
  message_id?: string;
  thread_id?: string;
  reply_to_message_id?: string;
  subject_key?: string;
  recipients: string[];
};
type OwnerOkQuestionLine = { kind: "owner_ok_question"; at: string; thread_id: string };
type RecordLine = StartLine | OutsiderSendLine | OwnerOkQuestionLine;

export type OutsiderSendRecord = {
  /** Epoch milliseconds of the start line; null when the box has sent nothing since the release. */
  startedAt: number | null;
  sends: OutsiderSendLine[];
  ownerOkThreads: Set<string>;
};

export type MailThreadFacts = {
  threadId?: string;
  subject?: string;
  messages?: MailThreadMessageMeta[];
};

export function outsiderSendRecordPath(filesRoot: string): string {
  return connectorStatePath(filesRoot, OUTSIDER_SEND_RECORD_FILE);
}

export function readOutsiderSendRecord(filesRoot: string | null | undefined): OutsiderSendRecord {
  const record: OutsiderSendRecord = { startedAt: null, sends: [], ownerOkThreads: new Set() };
  if (!filesRoot) return record;
  let raw: string;
  try {
    raw = fs.readFileSync(outsiderSendRecordPath(filesRoot), "utf8");
  } catch {
    return record;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: RecordLine;
    try {
      parsed = JSON.parse(line) as RecordLine;
    } catch {
      continue;
    }
    if (parsed.kind === "start" && record.startedAt === null) {
      const t = Date.parse(parsed.started_at);
      if (Number.isFinite(t)) record.startedAt = t;
    } else if (parsed.kind === "outsider_send") {
      record.sends.push(parsed);
    } else if (parsed.kind === "owner_ok_question" && parsed.thread_id) {
      record.ownerOkThreads.add(parsed.thread_id);
    }
  }
  return record;
}

function appendLine(filesRoot: string, line: RecordLine): void {
  const file = outsiderSendRecordPath(filesRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** Write the start line once. The send route calls this before each send. */
export function ensureOutsiderSendRecordStarted(filesRoot: string, now = new Date()): void {
  if (fs.existsSync(outsiderSendRecordPath(filesRoot))) return;
  appendLine(filesRoot, { kind: "start", started_at: now.toISOString() });
}

export function subjectKey(subject: string | undefined): string | undefined {
  const key = normalizeMailSubjectForThreadCompare(subject ?? "").toLowerCase();
  return key || undefined;
}

export function appendOutsiderSend(
  filesRoot: string,
  input: {
    messageId?: string;
    threadId?: string;
    replyToMessageId?: string;
    subject?: string;
    recipients: string[];
  },
  now = new Date(),
): void {
  ensureOutsiderSendRecordStarted(filesRoot, now);
  appendLine(filesRoot, {
    kind: "outsider_send",
    at: now.toISOString(),
    ...(input.messageId ? { message_id: input.messageId } : {}),
    ...(input.threadId ? { thread_id: input.threadId } : {}),
    ...(input.replyToMessageId ? { reply_to_message_id: input.replyToMessageId } : {}),
    ...(subjectKey(input.subject) ? { subject_key: subjectKey(input.subject) } : {}),
    recipients: input.recipients.map((r) => r.toLowerCase()),
  });
}

export function appendOwnerOkQuestion(filesRoot: string, threadId: string, now = new Date()): void {
  ensureOutsiderSendRecordStarted(filesRoot, now);
  appendLine(filesRoot, { kind: "owner_ok_question", at: now.toISOString(), thread_id: threadId });
}

export function ownerOkQuestionSent(record: OutsiderSendRecord, threadId: string | undefined): boolean {
  return Boolean(threadId && record.ownerOkThreads.has(threadId));
}

/**
 * True when the record proves that the companion already sent an email on this thread to
 * somebody other than the owner. Proof: a recorded send whose message id is in the thread,
 * whose source thread id is this thread, or whose subject matches and whose recipients
 * include the sender of the triggering email (the owner Gmail copy of a thread has other
 * message ids than the companion mailbox). A message of the companion older than the start
 * line also counts.
 */
export function companionWroteToOutsider(input: {
  record: OutsiderSendRecord;
  thread: MailThreadFacts;
  triggerFrom?: string;
  isCompanion: (from: string | undefined) => boolean;
}): boolean {
  const { record, thread } = input;
  const messages = thread.messages ?? [];
  const messageIds = new Set(messages.map((m) => m.id).filter(Boolean));
  const triggerAddr = parseEmailAddress(input.triggerFrom);
  const threadSubject = subjectKey(thread.subject);
  for (const send of record.sends) {
    if (send.message_id && messageIds.has(send.message_id)) return true;
    if (send.reply_to_message_id && messageIds.has(send.reply_to_message_id)) return true;
    if (send.thread_id && thread.threadId && send.thread_id === thread.threadId) return true;
    if (
      triggerAddr &&
      threadSubject &&
      send.subject_key === threadSubject &&
      send.recipients.includes(triggerAddr)
    ) {
      return true;
    }
  }
  for (const m of messages) {
    if (!input.isCompanion(m.from)) continue;
    if (record.startedAt === null) return true;
    const t = m.date ? Date.parse(m.date) : Number.NaN;
    if (Number.isFinite(t) && t < record.startedAt) return true;
  }
  return false;
}
