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
 *   the voice model to invent a question. `stepLimit` is true when the newest
 *   run reached the step limit, so the recovery note can say so.
 */
export type RealtimeGoalBlockCause =
  | { kind: "owner_question"; question: string }
  | { kind: "system"; detail: string; stepLimit: boolean };

/** Minimum substance for a worker block reason to be treated as a question. */
const MIN_QUESTION_CHARS = 8;
/** Worker-declared infrastructure failure — skills use `kanban_block("system: …")`. */
const SYSTEM_REASON_RE = /^system\s*:/i;
/** Start of the error that Hermes writes when a worker reaches the step limit. */
const STEP_LIMIT_ERROR_PREFIX = "Iteration budget exhausted";

/** True when the block cause or the newest run says the worker reached the step limit. */
function reachedStepLimit(task: KanbanTaskSummary): boolean {
  return [task.block_cause?.error, task.latest_run?.error].some((error) =>
    error?.trim().startsWith(STEP_LIMIT_ERROR_PREFIX),
  );
}

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
    return { kind: "system", detail: systemDetail(cause, task, reason), stepLimit: reachedStepLimit(task) };
  }
  // Older bridge without block_cause: fall back to the legacy reason field.
  const legacy = task.block_reason?.trim() ?? "";
  if (ownerQuestion(legacy)) {
    return { kind: "owner_question", question: legacy };
  }
  return { kind: "system", detail: systemDetail(undefined, task, legacy), stepLimit: reachedStepLimit(task) };
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
  /** The last run reached the step limit (see the step-limit note on the card). */
  stepLimit?: boolean;
}): string {
  const lines = [
    `\n## Joshu recovery (${input.at}) — attempt ${input.attempt} of ${input.maxAttempts}`,
    `Why: ${input.why}`,
  ];
  if (input.ownerAnswer) {
    if (input.ownerAnswer.question) lines.push(`You asked: ${input.ownerAnswer.question}`);
    lines.push(`The owner already answered: ${input.ownerAnswer.answer}`);
  }
  if (input.stepLimit) {
    lines.push(
      "The last run reached the step limit before it called kanban_complete or kanban_block.",
      "Read the newest comment that starts with \"## Step-limit note\" first: it says what that run found.",
      "Do not repeat the work that the step-limit note describes. End this run within its first",
      "few steps with the result, or with one question that says what the last run found.",
    );
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
