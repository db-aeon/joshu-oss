import { callKanbanBridge } from "../hermesKanbanBridge.js";
import { queueMeetingTaskHandler } from "../ea/schedulingCron.js";
import { queueOwnerReplyTaskHandler } from "../ea/ownerReplyCron.js";
import { queueMailTrackTaskHandler } from "../ea/mailCron.js";
import { normalizeProjectSlug } from "../ea/mailTypes.js";
import { completeKanbanTask } from "./kanbanComplete.js";
import { projectSlugFromBoard } from "./prioritize.js";
import { wakeLinkedSchedulingTasks } from "./schedulingHandoff.js";
import { readProactiveState, writeProactiveState } from "./state.js";
import { parseProactiveTaskRef } from "./blockReason.js";
import type { TaskActionKeyword } from "./feedback.js";

export type ProactiveOwnerReplyResult = {
  ok: boolean;
  action: "feedback_keyword" | "routed" | "completed" | "kept" | "ignored" | "error";
  reason?: string;
  taskId?: string;
  board?: string;
  evaluationQueued?: boolean;
};

function resolveProactiveTaskRef(opts: {
  body: string;
  projectRoot: string;
  taskId?: string;
  board?: string;
}): { taskId: string; board: string } | null {
  const state = readProactiveState(opts.projectRoot);
  const ref = parseProactiveTaskRef(opts.body);
  const taskId = (opts.taskId ?? ref?.taskId ?? state.lastNudge?.taskId)?.trim();
  const board = (opts.board ?? state.lastNudge?.board)?.trim();
  if (!taskId || !board) return null;
  return { taskId, board };
}

async function commentAndUnblock(
  board: string,
  taskId: string,
  ownerText: string,
  filesRoot: string,
  opts?: { skipComment?: boolean },
): Promise<{
  ok: boolean;
  evaluationQueued: boolean;
  error?: string;
  schedulingWokenTaskIds?: string[];
}> {
  if (!opts?.skipComment) {
    const comment = await callKanbanBridge({
      action: "comment",
      board,
      task_id: taskId,
      body: `## Owner reply (proactive nudge)\n\n${ownerText.trim()}`,
      author: "owner",
    });
    if (!comment.success) {
      return { ok: false, evaluationQueued: false, error: comment.error ?? "comment_failed" };
    }
  }

  if (board === "ea-scheduling") {
    const wake = await queueMeetingTaskHandler({ filesRoot, taskId });
    return { ok: true, evaluationQueued: wake.queued, error: wake.queued ? undefined : wake.reason };
  }
  if (board === "ea-owner-reply") {
    const wake = await queueOwnerReplyTaskHandler({ filesRoot, taskId });
    return { ok: true, evaluationQueued: wake.queued, error: wake.queued ? undefined : wake.reason };
  }

  const slug = projectSlugFromBoard(board);
  if (slug) {
    // Owner approval on project tracks often authorizes ea-scheduling outreach — wake linked meeting tasks first.
    const schedulingWake = await wakeLinkedSchedulingTasks({
      filesRoot,
      projectBoard: board,
      projectTaskId: taskId,
      ownerText,
    });
    const wake = await queueMailTrackTaskHandler({
      filesRoot,
      projectSlug: normalizeProjectSlug(slug),
      taskId,
    });
    return {
      ok: true,
      evaluationQueued: wake.queued || schedulingWake.wokenTaskIds.length > 0,
      error: wake.queued ? undefined : wake.reason,
      schedulingWokenTaskIds: schedulingWake.wokenTaskIds,
    };
  }

  const unblock = await callKanbanBridge({ action: "unblock", board, task_id: taskId });
  if (!unblock.success) {
    return { ok: false, evaluationQueued: false, error: unblock.error ?? "unblock_failed" };
  }
  return { ok: true, evaluationQueued: true };
}

/** Wake Kanban worker after owner reply was already commented (no second comment). */
export async function wakeProactiveTaskAfterOwnerReply(opts: {
  board: string;
  taskId: string;
  filesRoot: string;
  ownerText?: string;
}): Promise<{
  ok: boolean;
  evaluationQueued: boolean;
  error?: string;
  schedulingWokenTaskIds?: string[];
}> {
  return commentAndUnblock(
    opts.board,
    opts.taskId,
    opts.ownerText ?? "",
    opts.filesRoot,
    { skipComment: true },
  );
}

/** Owner said DONE/CLOSE/KEEP on a proactive stale-review or nudge. */
export async function handleProactiveTaskAction(opts: {
  action: TaskActionKeyword;
  body: string;
  filesRoot: string;
  projectRoot?: string;
  taskId?: string;
  board?: string;
}): Promise<ProactiveOwnerReplyResult> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const resolved = resolveProactiveTaskRef({ ...opts, projectRoot });
  if (!resolved) {
    return { ok: false, action: "ignored", reason: "no_pending_nudge_ref" };
  }
  const { taskId, board } = resolved;

  if (opts.action === "KEEP") {
    await callKanbanBridge({
      action: "comment",
      board,
      task_id: taskId,
      body: `## Owner reply (proactive nudge)\n\nKEEP — leave blocked.\n\n${opts.body.trim()}`,
      author: "owner",
    });
    const state = readProactiveState(projectRoot);
    const nudgedTaskIds = state.nudgedTaskIds.includes(taskId)
      ? state.nudgedTaskIds
      : [...state.nudgedTaskIds, taskId];
    writeProactiveState({ ...state, nudgedTaskIds, feedbackPending: false }, projectRoot);
    return { ok: true, action: "kept", taskId, board };
  }

  const completed = await completeKanbanTask({
    board,
    taskId,
    comment: `## Owner closed via proactive nudge (${opts.action})\n\n${opts.body.trim()}`,
    author: "owner",
  });
  if (!completed.ok) {
    return { ok: false, action: "error", reason: completed.error, taskId, board };
  }
  const state = readProactiveState(projectRoot);
  writeProactiveState({ ...state, feedbackPending: false }, projectRoot);
  return { ok: true, action: "completed", taskId, board };
}

/** Route owner SMS/jChat reply to the Kanban task referenced by pending nudge or Ref line. */
export async function handleProactiveOwnerReply(opts: {
  body: string;
  filesRoot: string;
  projectRoot?: string;
  taskId?: string;
  board?: string;
}): Promise<ProactiveOwnerReplyResult> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const resolved = resolveProactiveTaskRef({ ...opts, projectRoot });
  if (!resolved) {
    return { ok: false, action: "ignored", reason: "no_pending_nudge_ref" };
  }
  const { taskId, board } = resolved;

  const routed = await commentAndUnblock(board, taskId, opts.body, opts.filesRoot);
  if (!routed.ok) {
    return {
      ok: false,
      action: "error",
      reason: routed.error,
      taskId,
      board,
    };
  }

  return {
    ok: true,
    action: "routed",
    taskId,
    board,
    evaluationQueued: routed.evaluationQueued,
  };
}
