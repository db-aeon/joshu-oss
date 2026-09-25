import type { RealtimeGoalRecord } from "./types.js";

/** Normalize an owner reply to a blocked question for storage and card appends. */
export function normalizeOwnerAnswer(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 500);
}

/**
 * After the owner answers a blocked question, a worker that blocks again with
 * the same question has not used the answer. The broker nudges the worker
 * instead of re-asking the owner.
 */
export function isRepeatOfAnsweredQuestion(
  goal: Pick<RealtimeGoalRecord, "blockedAnsweredAt" | "lastBlockedPrompt">,
  reason: string,
): boolean {
  if (!goal.blockedAnsweredAt) return false;
  const prev = goal.lastBlockedPrompt?.trim();
  if (!prev) return false;
  const trimmed = reason.trim();
  if (trimmed === prev) return true;
  const prevPrefix = prev.slice(0, 80).toLowerCase();
  const curPrefix = trimmed.slice(0, 80).toLowerCase();
  return Boolean(prevPrefix && prevPrefix === curPrefix);
}

/**
 * Card append when the owner answers the worker's kanban_block question.
 *
 * Deliberately task-neutral: the answer might pick an option, supply a missing
 * detail, or decline. The worker decides what it means for its own objective.
 */
export function ownerAnswerKanbanAppend(input: {
  text: string;
  at: string;
  sourceId: string;
  question?: string;
}): string {
  const lines = [
    `\n## Owner answer (${input.at})`,
    `Realtime-Source: ${input.sourceId}`,
  ];
  if (input.question?.trim()) lines.push(`You asked: ${input.question.trim()}`);
  lines.push(
    `Owner replied: ${normalizeOwnerAnswer(input.text)}`,
    "",
    "Continue from where you stopped using this answer. Do not repeat finished work",
    "and do not ask this question again. If the reply picks one of the options you",
    "offered, proceed with that option.",
  );
  return lines.join("\n");
}

/** Generic owner update append for non-blocked mid-task amendments. */
export function ownerUpdateKanbanAppend(
  text: string,
  at: string,
  sourceId: string,
): string {
  return `\n## Owner update (${at})\nRealtime-Source: ${sourceId}\n${text}`;
}
