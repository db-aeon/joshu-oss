/**
 * Reply subject must match the parent message for Gmail/Google conversation threading.
 * Agents often decorate subjects (availability, names, task titles) and fork the thread.
 */

/** Strip leading Re:/Fwd:/Fw: prefixes for comparison (Gmail normalizes these). */
export function normalizeMailSubjectForThreadCompare(subject: string): string {
  return subject
    .trim()
    .replace(/^(?:(?:re|fwd|fw)\s*:\s*)+/i, "")
    .trim();
}

/** True when subjects are equivalent for threading (exact match after Re:/Fwd: strip). */
export function replySubjectsMatch(agentSubject: string, parentSubject: string): boolean {
  return (
    normalizeMailSubjectForThreadCompare(agentSubject) ===
    normalizeMailSubjectForThreadCompare(parentSubject)
  );
}

export type ReplySubjectMismatchPayload = {
  error: "reply_subject_mismatch";
  reason: string;
  expectedSubject: string;
  gotSubject: string;
  hint: string;
};

/** Structured 400 body — MCP should surface expectedSubject + hint so the agent can retry. */
export function buildReplySubjectMismatchError(opts: {
  got: string;
  expected: string;
}): ReplySubjectMismatchPayload {
  return {
    error: "reply_subject_mismatch",
    reason:
      "When replying (replyToMessageId set), subject must match the parent message so Gmail/Google keep the conversation threaded. Only Re:/Fwd: prefix differences are allowed.",
    expectedSubject: opts.expected,
    gotSubject: opts.got,
    hint: `Retry nylas_send_message with subject exactly ${JSON.stringify(opts.expected)} — do not append availability, names, task titles, or other decorations.`,
  };
}
