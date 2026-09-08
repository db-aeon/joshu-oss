import { callKanbanBridge } from "../hermesKanbanBridge.js";

/** Mark a Kanban task done with required audit comment. */
export async function completeKanbanTask(opts: {
  board: string;
  taskId: string;
  comment: string;
  author?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const result = await callKanbanBridge({
    action: "complete",
    board: opts.board,
    task_id: opts.taskId,
    comment: opts.comment,
    author: opts.author ?? "joshu",
  });
  if (!result.success) {
    return { ok: false, error: result.error ?? "complete_failed" };
  }
  return { ok: true };
}
