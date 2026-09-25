import type { KanbanTaskSummary } from "../hermesKanbanBridge.js";

/**
 * Why a realtime goal's Kanban task is blocked, reduced to the one decision the
 * broker has to make: is there a question the owner can actually answer?
 *
 * - `owner_question` — the worker called kanban_block with a reason. Deliver it.
 * - `system` — Hermes parked the task (circuit breaker after crashes, timeouts,
 *   spawn failures, or clean exits without kanban_complete/kanban_block), the
 *   block carries no reason, or the worker flagged infrastructure with a
 *   `system:` reason (e.g. "system: browser unavailable" from the browser skill).
 *   There is nothing to ask; paging the owner with a placeholder only invites
 *   the voice model to invent a question.
 */
export type RealtimeGoalBlockCause =
  | { kind: "owner_question"; question: string }
  | { kind: "system"; detail: string };

/** Minimum substance for a worker block reason to be treated as a question. */
const MIN_QUESTION_CHARS = 8;
/** Worker-declared infrastructure failure — skills use `kanban_block("system: …")`. */
const SYSTEM_REASON_RE = /^system\s*:/i;

/** A worker reason that is a real question for the owner (not a placeholder or system flag). */
function ownerQuestion(reason: string): boolean {
  return reason.length >= MIN_QUESTION_CHARS && !SYSTEM_REASON_RE.test(reason);
}

export function classifyBlockCause(task: KanbanTaskSummary): RealtimeGoalBlockCause {
  const cause = task.block_cause;
  if (cause) {
    const reason = cause.reason?.trim() ?? "";
    if (cause.source === "worker" && ownerQuestion(reason)) {
      return { kind: "owner_question", question: reason };
    }
    return { kind: "system", detail: systemDetail(cause, task, reason) };
  }
  // Older bridge without block_cause: fall back to the legacy reason field.
  const legacy = task.block_reason?.trim() ?? "";
  if (ownerQuestion(legacy)) {
    return { kind: "owner_question", question: legacy };
  }
  return { kind: "system", detail: systemDetail(undefined, task, legacy) };
}

function systemDetail(
  cause: KanbanTaskSummary["block_cause"] | undefined,
  task: KanbanTaskSummary,
  reason = "",
): string {
  const parts = [
    SYSTEM_REASON_RE.test(reason) ? reason : "",
    cause?.event ? `event=${cause.event}` : "",
    cause?.trigger ? `trigger=${cause.trigger}` : "",
    typeof cause?.protocol_violations === "number"
      ? `exits_without_complete_or_block=${cause.protocol_violations}`
      : "",
    cause?.error || task.latest_run?.error || "",
  ].filter(Boolean);
  return parts.join("; ").slice(0, 400) || "blocked without a reason";
}

/**
 * Card append that wakes the worker after a system block (or a repeat of a
 * question the owner already answered). Tells it exactly how to end the run so
 * the next stop is either a result or a real question.
 */
export function autoRecoveryKanbanAppend(input: {
  at: string;
  attempt: number;
  maxAttempts: number;
  why: string;
  ownerAnswer?: { question?: string; answer: string };
}): string {
  const lines = [
    `\n## Joshu recovery (${input.at}) — attempt ${input.attempt} of ${input.maxAttempts}`,
    `Why: ${input.why}`,
  ];
  if (input.ownerAnswer) {
    if (input.ownerAnswer.question) lines.push(`You asked: ${input.ownerAnswer.question}`);
    lines.push(`The owner already answered: ${input.ownerAnswer.answer}`);
  }
  lines.push(
    "",
    "Continue this card from where it stopped. Re-read the full body and comments first;",
    "everything the owner already said is on this card — do not ask for it again.",
    "End this run with exactly one of:",
    "- kanban_complete with the result the owner should receive, or",
    "- kanban_block with ONE specific question the owner can answer (never a generic",
    "  \"need more information\", and never a question already answered above).",
    "Exiting without either call counts as a failure.",
  );
  return lines.join("\n");
}
