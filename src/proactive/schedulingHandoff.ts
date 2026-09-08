/**
 * When a proactive owner reply lands on a project mail_track, wake linked ea-scheduling
 * meeting tasks so outreach happens on the scheduling board (not only project filing).
 */
import {
  listSchedulingMeetingTasks,
  parseThreadIdFromTaskBody,
  queueMeetingTaskHandler,
} from "../ea/schedulingCron.js";
import { EA_SCHEDULING_BOARD } from "../ea/schedulingTypes.js";
import { callKanbanBridge } from "../hermesKanbanBridge.js";
import { projectSlugFromBoard } from "./prioritize.js";

const TASK_ID_RE = /\b(t_[a-f0-9]{6,})\b/gi;

/** Extract Kanban task ids referenced in free text (comments, ingress notes). */
export function extractSchedulingTaskIdsFromText(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(TASK_ID_RE)) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

export async function discoverLinkedSchedulingTaskIds(opts: {
  filesRoot: string;
  projectBoard: string;
  projectTaskId: string;
}): Promise<string[]> {
  if (!projectSlugFromBoard(opts.projectBoard)) return [];

  const shown = await callKanbanBridge({
    action: "show",
    board: opts.projectBoard,
    task_id: opts.projectTaskId,
  });
  const task = shown.task;
  if (!task) return [];

  const ids = new Set<string>();
  const body = task.body ?? "";

  for (const id of extractSchedulingTaskIdsFromText(body)) ids.add(id);

  for (const comment of task.recent_comments ?? []) {
    for (const id of extractSchedulingTaskIdsFromText(comment.body ?? "")) ids.add(id);
  }

  const threadId = parseThreadIdFromTaskBody(body);
  if (threadId) {
    const meetings = await listSchedulingMeetingTasks({
      filesRoot: opts.filesRoot,
      threadId,
    });
    for (const meeting of meetings) {
      if (meeting.task_id) ids.add(meeting.task_id);
    }
  }

  return [...ids];
}

export type WakeLinkedSchedulingResult = {
  wokenTaskIds: string[];
  errors: string[];
};

/** Comment owner text onto ea-scheduling child tasks and queue meeting workers. */
export async function wakeLinkedSchedulingTasks(opts: {
  filesRoot: string;
  projectBoard: string;
  projectTaskId: string;
  ownerText: string;
}): Promise<WakeLinkedSchedulingResult> {
  const taskIds = await discoverLinkedSchedulingTaskIds(opts);
  const wokenTaskIds: string[] = [];
  const errors: string[] = [];

  for (const taskId of taskIds) {
    const comment = await callKanbanBridge({
      action: "comment",
      board: EA_SCHEDULING_BOARD,
      task_id: taskId,
      body: [
        `## Owner reply (proactive nudge via ${opts.projectBoard}/${opts.projectTaskId})`,
        "",
        opts.ownerText.trim(),
      ].join("\n"),
      author: "owner",
    });
    if (!comment.success) {
      errors.push(`${taskId}:comment_failed`);
      continue;
    }

    const wake = await queueMeetingTaskHandler({
      filesRoot: opts.filesRoot,
      taskId,
    });
    if (wake.queued) {
      wokenTaskIds.push(taskId);
    } else {
      errors.push(`${taskId}:${wake.reason ?? "wake_failed"}`);
    }
  }

  return { wokenTaskIds, errors };
}
