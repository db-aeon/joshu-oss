import { callKanbanBridge } from "../hermesKanbanBridge.js";
import { listKanbanBoardSlugs } from "./boards.js";
import { blockReasonNeedsOwnerInput } from "./blockReason.js";
import { projectSlugFromBoard, rankCandidate, sortCandidates } from "./prioritize.js";
import { isDateStaleForNudge } from "./stale.js";
import type { ProactiveCandidate, ProactiveState } from "./types.js";
import { wasTaskNudgedToday } from "./state.js";

async function listBlockedOnBoard(
  board: string,
  opts: { limit?: number; includeActivity?: boolean },
): Promise<
  Array<{
    task_id: string;
    title?: string;
    status?: string;
    body?: string;
    block_reason?: string | null;
  }>
> {
  const result = await callKanbanBridge({
    action: "list",
    board,
    status: "blocked",
    limit: opts.limit ?? 50,
    include_body: true,
    include_activity: opts.includeActivity ?? true,
  });
  if (!result.success || !result.tasks) return [];
  return result.tasks
    .map((t) => ({
      task_id: t.task_id?.trim() ?? "",
      title: t.title,
      status: t.status,
      body: t.body,
      block_reason: t.block_reason ?? null,
    }))
    .filter((t) => t.task_id.length > 0);
}

function toCandidate(
  row: {
    task_id: string;
    title?: string;
    status?: string;
    body?: string;
    block_reason?: string | null;
  },
  board: string,
  filesRoot: string,
): ProactiveCandidate | null {
  if (row.status !== "blocked") return null;
  if (!blockReasonNeedsOwnerInput(row.block_reason)) return null;

  const taskText = `${row.title ?? ""}\n${row.body ?? ""}`;
  if (isDateStaleForNudge(taskText)) return null;

  const projectSlug = projectSlugFromBoard(board);
  return rankCandidate(
    {
      taskId: row.task_id,
      board,
      title: row.title?.trim() || "(untitled)",
      status: row.status ?? "blocked",
      blockReason: row.block_reason ?? null,
      body: row.body,
      projectSlug,
    },
    filesRoot,
  );
}

/** Collect blocked owner-input tasks across all Kanban boards on the box. */
export async function sweepProactiveCandidates(opts: {
  filesRoot: string;
  state: ProactiveState;
}): Promise<ProactiveCandidate[]> {
  const { filesRoot, state } = opts;
  const raw: ProactiveCandidate[] = [];

  for (const board of listKanbanBoardSlugs()) {
    const rows = await listBlockedOnBoard(board, { limit: 50 });
    for (const row of rows) {
      const c = toCandidate(row, board, filesRoot);
      if (c && !wasTaskNudgedToday(state, c.taskId)) raw.push(c);
    }
  }

  return sortCandidates(raw);
}

export async function pickTopProactiveCandidate(opts: {
  filesRoot: string;
  state: ProactiveState;
}): Promise<ProactiveCandidate | null> {
  const candidates = await sweepProactiveCandidates(opts);
  return candidates[0] ?? null;
}
