/**
 * Cross-board blocked Kanban queries on this box (all boards under ~/.hermes/kanban/boards/).
 * Shared by proactive nudge sweep and daily hygiene precompute.
 */
import { callKanbanBridge, type KanbanTaskSummary } from "../hermesKanbanBridge.js";
import { listKanbanBoardSlugs } from "./boards.js";

export type BlockedKanbanRow = {
  board: string;
  task_id: string;
  title?: string;
  status?: string;
  body?: string;
  block_reason?: string | null;
  created_at_ms?: number | null;
  recent_comments?: KanbanTaskSummary["recent_comments"];
};

/** Hermes kanban_db stores created_at as unix seconds (int) or ISO string. */
export function normalizeKanbanCreatedAtMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const t = Date.parse(raw.trim());
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function mapTaskRow(board: string, t: KanbanTaskSummary): BlockedKanbanRow | null {
  const task_id = t.task_id?.trim() ?? "";
  if (!task_id) return null;
  return {
    board,
    task_id,
    title: t.title,
    status: t.status,
    body: t.body,
    block_reason: t.block_reason ?? null,
    created_at_ms: normalizeKanbanCreatedAtMs(t.created_at),
    recent_comments: t.recent_comments,
  };
}

/** List blocked tasks on one Kanban board. */
export async function listBlockedOnBoard(
  board: string,
  opts: { limit?: number; includeActivity?: boolean } = {},
): Promise<BlockedKanbanRow[]> {
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
    .map((t) => mapTaskRow(board, t))
    .filter((row): row is BlockedKanbanRow => row !== null);
}

/** All blocked tasks across every board on this box. */
export async function listBlockedCrossBoard(
  opts: { perBoardLimit?: number; includeActivity?: boolean } = {},
): Promise<BlockedKanbanRow[]> {
  const out: BlockedKanbanRow[] = [];
  for (const board of listKanbanBoardSlugs()) {
    const rows = await listBlockedOnBoard(board, {
      limit: opts.perBoardLimit ?? 50,
      includeActivity: opts.includeActivity ?? true,
    });
    out.push(...rows);
  }
  return out;
}
