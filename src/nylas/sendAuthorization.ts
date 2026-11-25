/**
 * Mail authorization of the send route of the companion mailbox (spec mail-agent-authorization).
 *
 * - Mail to the owner only (for example an owner-OK question) is always allowed and never
 *   counts as a send to an outsider.
 * - A reply to an outsider (a send that names a thread with `replyToMessageId` or
 *   `sourcePath`) needs an authorized thread.
 * - After the send, the outsider send record remembers each send to an outsider, and each
 *   owner-OK question on a thread that is not authorized.
 */
import {
  readMailMirrorFrontmatter,
  resolveOutboundMailAuthorization,
  resolveOwnerEmails,
} from "../ea/agentAuthorization.js";
import {
  appendOutsiderSend,
  appendOwnerOkQuestion,
  ensureOutsiderSendRecordStarted,
} from "../ea/outsiderSendRecord.js";

export type CompanionSendAuthorization =
  | { allowed: false; reason: string }
  | {
      allowed: true;
      /** Recipients that are not addresses of the owner. Empty for mail to the owner only. */
      outsiderRecipients: string[];
      /** Thread id of an owner-OK question: owner-only mail on a thread that is not authorized. */
      ownerOkQuestionThreadId?: string;
    };

export async function authorizeCompanionSend(input: {
  projectRoot: string;
  filesRoot: string | null;
  recipients: string[];
  replyToMessageId?: string;
  sourcePath?: string;
  /** The owner wrote the email in jMail; the owner needs no authorization. */
  ownerSentFromJmail: boolean;
}): Promise<CompanionSendAuthorization> {
  const ownerEmails = resolveOwnerEmails(input.projectRoot);
  const outsiderRecipients = input.recipients
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email && !ownerEmails.has(email));
  if (input.ownerSentFromJmail || (!input.replyToMessageId && !input.sourcePath)) {
    return { allowed: true, outsiderRecipients };
  }

  const auth = await resolveOutboundMailAuthorization({
    filesRoot: input.filesRoot,
    projectRoot: input.projectRoot,
    replyToMessageId: input.replyToMessageId,
    sourcePath: input.sourcePath,
  });
  if (auth?.agent_authorized) return { allowed: true, outsiderRecipients };
  if (outsiderRecipients.length > 0) {
    return { allowed: false, reason: auth?.reason ?? "not_copied_or_delegated" };
  }
  const ownerOkQuestionThreadId =
    input.sourcePath && input.filesRoot
      ? (await readMailMirrorFrontmatter(input.filesRoot, input.sourcePath))?.thread_id
      : undefined;
  return { allowed: true, outsiderRecipients, ...(ownerOkQuestionThreadId ? { ownerOkQuestionThreadId } : {}) };
}

/** Write the outsider send record after a send. A failure is logged, never thrown. */
export async function recordCompanionSend(input: {
  filesRoot: string | null;
  sendAuth: CompanionSendAuthorization;
  messageId: string;
  replyToMessageId?: string;
  sourcePath?: string;
  subject: string;
}): Promise<void> {
  const { filesRoot, sendAuth } = input;
  if (!filesRoot || !sendAuth.allowed) return;
  try {
    if (sendAuth.outsiderRecipients.length > 0) {
      const threadId = input.sourcePath
        ? (await readMailMirrorFrontmatter(filesRoot, input.sourcePath))?.thread_id
        : undefined;
      appendOutsiderSend(filesRoot, {
        messageId: input.messageId,
        threadId,
        replyToMessageId: input.replyToMessageId,
        subject: input.subject,
        recipients: sendAuth.outsiderRecipients,
      });
    } else if (sendAuth.ownerOkQuestionThreadId) {
      appendOwnerOkQuestion(filesRoot, sendAuth.ownerOkQuestionThreadId);
    } else {
      ensureOutsiderSendRecordStarted(filesRoot);
    }
  } catch (err) {
    console.warn(`[nylas-send] outsider send record: ${(err as Error).message}`);
  }
}
