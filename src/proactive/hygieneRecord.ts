import { readProactiveState, writeProactiveState } from "./state.js";
import type { HygieneAmbiguousItem, ProactiveState } from "./types.js";

export type HygieneRecordInput = {
  closedTaskIds?: string[];
  ambiguous?: Array<{
    taskId: string;
    board: string;
    title?: string;
    blockReason?: string | null;
  }>;
  skipped?: number;
  active?: number;
  summary?: string;
};

/** Persist hygiene run results into proactive state (and ambiguous queue for stale_review nudges). */
export function recordHygieneRun(
  projectRoot: string,
  input: HygieneRecordInput,
): ProactiveState {
  const state = readProactiveState(projectRoot);
  const now = new Date().toISOString();
  const closed = (input.closedTaskIds ?? []).map((id) => id.trim()).filter(Boolean);
  const ambiguous = input.ambiguous ?? [];

  const closedSet = new Set(state.hygieneClosedTaskIds ?? []);
  for (const id of closed) closedSet.add(id);

  const queueMap = new Map(
    (state.hygieneAmbiguousQueue ?? []).map((q) => [q.taskId, q] as const),
  );
  for (const id of closed) queueMap.delete(id);
  for (const item of ambiguous) {
    const taskId = item.taskId?.trim();
    if (!taskId) continue;
    queueMap.set(taskId, {
      taskId,
      board: item.board,
      title: item.title?.trim() || "(untitled)",
      blockReason: item.blockReason ?? null,
      queuedAt: now,
    } satisfies HygieneAmbiguousItem);
  }

  const next: ProactiveState = {
    ...state,
    hygieneLastRunAt: now,
    hygieneClosedTaskIds: [...closedSet].sort(),
    lastHygieneSummary: {
      closed: closed.length,
      ambiguous: ambiguous.length,
      skipped: input.skipped ?? 0,
      active: input.active ?? 0,
      ranAt: now,
    },
    hygieneAmbiguousQueue: [...queueMap.values()],
  };
  writeProactiveState(next, projectRoot);
  return next;
}

/** Convert queued ambiguous card to a proactive candidate for stale_review SMS. */
export function pickTopStaleReviewCandidate(state: ProactiveState): {
  taskId: string;
  board: string;
  title: string;
  blockReason: string | null;
} | null {
  for (const item of state.hygieneAmbiguousQueue ?? []) {
    if (state.nudgedTaskIds.includes(item.taskId)) continue;
    return {
      taskId: item.taskId,
      board: item.board,
      title: item.title,
      blockReason: item.blockReason,
    };
  }
  return null;
}
