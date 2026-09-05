/**
 * Owner-reply Kanban child — mirror schedulingCron: ready create, thread dedup, handoff unblock.
 */
import {
  callKanbanBridge,
  ensureEaOwnerReplyBoard,
  eaSchedulingKanbanAssignee,
} from "../hermesKanbanBridge.js";
import { parseEmailAddress } from "./schedulingTypes.js";
import { parseThreadIdFromTaskBody, threadIdInTaskSourcePaths } from "./schedulingCron.js";
import {
  assertSpawnAllowed,
  findOpenOwnerReplyByScope,
  listActiveCoordinationForScope,
  registerCoordination,
  resolveMailCoordinationScope,
} from "./conversationScope.js";
import {
  EA_OWNER_REPLY_BOARD,
  EA_OWNER_REPLY_SKILL,
  OWNER_REPLY_DEFAULT_BLOCK_AFTER_CREATE,
  ownerReplyTaskIdempotencyKey,
  ownerReplyTaskIdempotencyKeyFromMessage,
} from "./ownerReplyTypes.js";

export type QueueOwnerReplyTaskResult = {
  queued: boolean;
  reason: string;
  taskId?: string;
};

export type OwnerReplyTaskSummary = {
  task_id: string;
  title?: string;
  status?: string;
  body?: string;
  block_reason?: string | null;
  recent_comments?: Array<{
    author?: string;
    body?: string;
    created_at?: string;
  }>;
};

const OPEN_OWNER_REPLY_STATUSES = ["ready", "running", "blocked", "todo"] as const;

export function buildOwnerReplyTaskBody(opts: {
  subject?: string;
  fromEmail?: string | null;
  sourcePath: string;
  messageId?: string;
  threadId?: string;
  provider?: string;
}): string {
  const lines = [
    "kind: owner_reply",
    "state: open",
    "participants:",
    ...(opts.fromEmail ? [`  - ${opts.fromEmail}`] : []),
    "source_paths:",
    `  - ${opts.sourcePath}`,
    ...(opts.messageId?.trim() ? [`message_id: ${opts.messageId.trim()}`] : []),
    ...(opts.provider?.trim() ? [`provider: ${opts.provider.trim()}`] : []),
    ...(opts.threadId?.trim() ? [`thread_id: ${opts.threadId.trim()}`] : []),
    `subject: ${JSON.stringify(opts.subject?.trim() || "(no subject)")}`,
    "Job: do the owner's ask, then nylas_send_message on this thread (replyToMessageId + parent subject + sourcePath).",
    "Never delete/trash. Never send scheduling slots (hand off to ea-scheduling).",
    "kanban_complete if delivered; kanban_block(awaiting owner) only if the reply asked a real question.",
  ];
  return lines.join("\n");
}

export function findOpenOwnerReplyByThread(
  tasks: OwnerReplyTaskSummary[],
  threadId: string,
): OwnerReplyTaskSummary | undefined {
  const normalized = threadId.trim();
  if (!normalized) return undefined;
  return tasks.find((t) => {
    const body = t.body ?? "";
    if (parseThreadIdFromTaskBody(body) === normalized) return true;
    return threadIdInTaskSourcePaths(body, normalized);
  });
}

function ownerReplyTaskTitle(subject?: string, from?: string): string {
  const subj = subject?.trim() || "Owner ask";
  const who = from?.trim();
  if (who) {
    const short = who.length > 40 ? `${who.slice(0, 37)}…` : who;
    return `${subj} — ${short}`;
  }
  return subj;
}

export async function listOwnerReplyTasks(opts: {
  filesRoot: string;
  limit?: number;
  threadId?: string;
}): Promise<OwnerReplyTaskSummary[]> {
  const { filesRoot, limit = 50, threadId } = opts;
  await ensureEaOwnerReplyBoard(filesRoot).catch(() => {});

  const byId = new Map<string, OwnerReplyTaskSummary>();
  for (const status of OPEN_OWNER_REPLY_STATUSES) {
    const result = await callKanbanBridge({
      action: "list",
      board: EA_OWNER_REPLY_BOARD,
      status,
      limit,
      include_body: true,
      include_activity: true,
    });
    if (!result.success || !result.tasks) continue;
    for (const t of result.tasks) {
      const id = t.task_id?.trim();
      if (!id) continue;
      const body = t.body ?? "";
      if (body.includes("kind: mail_ingress") || body.includes("kind: meeting")) continue;
      byId.set(id, {
        task_id: id,
        title: t.title,
        status: t.status,
        body,
        block_reason: t.block_reason ?? null,
        recent_comments: t.recent_comments,
      });
    }
  }
  const tasks = [...byId.values()];
  const filterThread = threadId?.trim();
  if (!filterThread) return tasks;
  const matched = findOpenOwnerReplyByThread(tasks, filterThread);
  return matched ? [matched] : [];
}

/**
 * Create (or return existing) owner_reply task — assignee → ready.
 * Do not default-block (unlike mail_create_track_task).
 */
export async function queueOwnerReplyTask(opts: {
  filesRoot: string;
  messageId: string;
  subject?: string;
  from?: string;
  sourcePath: string;
  title?: string;
  body?: string;
  threadId?: string;
  provider?: string;
}): Promise<QueueOwnerReplyTaskResult> {
  const messageId = opts.messageId.trim();
  if (!messageId) {
    return { queued: false, reason: "missing_message_id" };
  }

  const { filesRoot } = opts;
  const threadId = opts.threadId?.trim();
  const fromEmail = parseEmailAddress(opts.from);
  const body =
    opts.body?.trim() ||
    buildOwnerReplyTaskBody({
      subject: opts.subject,
      fromEmail,
      sourcePath: opts.sourcePath,
      messageId,
      threadId,
      provider: opts.provider,
    });
  const title = opts.title?.trim() || ownerReplyTaskTitle(opts.subject, opts.from);
  const idempotencyKey = ownerReplyTaskIdempotencyKeyFromMessage(messageId);

  await ensureEaOwnerReplyBoard(filesRoot).catch((err) => {
    console.warn(`[ea-owner-reply] board ensure: ${(err as Error).message}`);
  });

  if (threadId) {
    const scope = await resolveMailCoordinationScope({
      channel: "mail",
      filesRoot,
      threadId,
      provider: opts.provider,
      sourcePath: opts.sourcePath,
      subject: opts.subject,
      from: opts.from,
    });
    const { listSchedulingMeetingTasks } = await import("./schedulingCron.js");
    const openScheduling = await listSchedulingMeetingTasks({ filesRoot });
    const openOwnerReply = await listOwnerReplyTasks({ filesRoot });
    const active = await listActiveCoordinationForScope({
      filesRoot,
      scope,
      schedulingTasks: openScheduling,
      ownerReplyTasks: openOwnerReply,
    });
    const gate = assertSpawnAllowed({
      scope,
      requestingBoard: EA_OWNER_REPLY_BOARD,
      capability: "owner_deliverable",
      active,
    });
    if (!gate.ok) {
      console.info(
        `[ea-owner-reply] coordination mutex scope=${scope.scopeId} reason=${gate.conflict.reason} task=${gate.conflict.task_id} message=${messageId}`,
      );
      return {
        queued: false,
        reason: gate.conflict.reason,
        taskId: gate.conflict.task_id,
      };
    }

    const existing = findOpenOwnerReplyByScope(openOwnerReply, scope);
    if (existing?.task_id) {
      console.info(
        `[ea-owner-reply] thread dedup thread=${threadId} task=${existing.task_id} message=${messageId}`,
      );
      return { queued: false, reason: "existing_thread", taskId: existing.task_id };
    }
  }

  const result = await callKanbanBridge({
    action: "create",
    board: EA_OWNER_REPLY_BOARD,
    title,
    body,
    assignee: eaSchedulingKanbanAssignee(),
    idempotency_key: idempotencyKey,
    skills: [EA_OWNER_REPLY_SKILL],
    workspace_kind: "dir",
    workspace_path: filesRoot,
  });

  if (!result.success) {
    console.warn(`[ea-owner-reply] create failed reason=${result.error ?? "unknown"}`);
    return { queued: false, reason: result.error ?? "kanban_create_failed" };
  }

  // Ready-create: never default-block. Mail tracks still block; this child must run.
  if (OWNER_REPLY_DEFAULT_BLOCK_AFTER_CREATE) {
    console.warn("[ea-owner-reply] OWNER_REPLY_DEFAULT_BLOCK_AFTER_CREATE is true — unexpected");
  }

  const actionTaken = result.action_taken ?? "created";
  console.info(
    `[ea-owner-reply] action=${actionTaken} board=${EA_OWNER_REPLY_BOARD} task=${result.task_id ?? "?"} message=${messageId}`,
  );

  if (result.task_id && threadId && actionTaken !== "existing_active") {
    const scope = await resolveMailCoordinationScope({
      channel: "mail",
      filesRoot,
      threadId,
      provider: opts.provider,
      sourcePath: opts.sourcePath,
      subject: opts.subject,
      from: opts.from,
    }).catch(() => null);
    if (scope) {
      await registerCoordination({
        filesRoot,
        scopeId: scope.scopeId,
        capability: "owner_deliverable",
        board: EA_OWNER_REPLY_BOARD,
        task_id: result.task_id,
        channel: "mail",
      }).catch(() => {});
    }
  }

  return {
    queued: actionTaken !== "existing_active",
    reason: actionTaken,
    taskId: result.task_id,
  };
}

export async function queueOwnerReplyTaskHandler(opts: {
  filesRoot: string;
  taskId: string;
}): Promise<QueueOwnerReplyTaskResult> {
  const { filesRoot, taskId } = opts;
  await ensureEaOwnerReplyBoard(filesRoot).catch((err) => {
    console.warn(`[ea-owner-reply] kanban board ensure: ${(err as Error).message}`);
  });

  const result = await callKanbanBridge({
    action: "unblock",
    board: EA_OWNER_REPLY_BOARD,
    task_id: taskId,
    idempotency_key: ownerReplyTaskIdempotencyKey(taskId),
  });

  if (!result.success) {
    console.warn(
      `[ea-owner-reply] task=${taskId} unblock failed reason=${result.error ?? "unknown"}`,
    );
    return { queued: false, reason: result.error ?? "unblock_failed" };
  }

  const actionTaken = result.action_taken ?? "unblocked";
  console.info(`[ea-owner-reply] task=${taskId} action=${actionTaken}`);
  return { queued: true, reason: actionTaken, taskId };
}

export type HandoffOwnerReplyResult = {
  ok: boolean;
  error?: string;
  evaluation_queued?: boolean;
};

function buildIngressHandoffAppend(opts: {
  existingBody: string;
  sourcePath: string;
  messageId: string;
  from?: string;
  summary: string;
}): string {
  const lines: string[] = [];
  const path = opts.sourcePath.trim();
  if (path && !opts.existingBody.includes(path)) {
    if (opts.existingBody.includes("source_paths:")) {
      lines.push(`  - ${path}`);
    } else {
      lines.push("source_paths:", `  - ${path}`);
    }
  }
  lines.push(
    "ingress_handoff:",
    `  message_id: ${opts.messageId}`,
    `  source_path: ${path}`,
    ...(opts.from?.trim() ? [`  from: ${opts.from.trim()}`] : []),
    `  at: ${new Date().toISOString()}`,
    `  summary: ${JSON.stringify(opts.summary.trim())}`,
  );
  return lines.join("\n");
}

/** Append source_path + comment; unblock if blocked (same as meeting / mail track handoff). */
export async function handoffOwnerReplyTask(opts: {
  filesRoot: string;
  taskId: string;
  sourcePath: string;
  messageId: string;
  from?: string;
  summary: string;
}): Promise<HandoffOwnerReplyResult> {
  const taskId = opts.taskId.trim();
  const sourcePath = opts.sourcePath.trim();
  const messageId = opts.messageId.trim();
  const summary = opts.summary.trim();
  if (!taskId || !sourcePath || !messageId || !summary) {
    return { ok: false, error: "taskId, sourcePath, messageId, summary required" };
  }

  const before = await callKanbanBridge({
    action: "show",
    board: EA_OWNER_REPLY_BOARD,
    task_id: taskId,
  });
  if (!before.success || !before.task) {
    return { ok: false, error: before.error ?? "task_not_found" };
  }
  const wasBlocked = before.task.status === "blocked";
  const existingBody = before.task.body ?? "";

  const append = buildIngressHandoffAppend({
    existingBody,
    sourcePath,
    messageId,
    from: opts.from,
    summary,
  });
  const appended = await callKanbanBridge({
    action: "append_body",
    board: EA_OWNER_REPLY_BOARD,
    task_id: taskId,
    append,
  });
  if (!appended.success) {
    return { ok: false, error: appended.error ?? "append_body_failed" };
  }

  const commentBody = [
    "## Ingress mail handoff",
    "",
    summary,
    "",
    `source_path: ${sourcePath}`,
    `message_id: ${messageId}`,
    ...(opts.from?.trim() ? [`from: ${opts.from.trim()}`] : []),
    "",
    "Owner-reply worker: do the ask, nylas_send_message on the thread, then complete or block awaiting owner.",
  ].join("\n");

  const commented = await callKanbanBridge({
    action: "comment",
    board: EA_OWNER_REPLY_BOARD,
    task_id: taskId,
    body: commentBody,
    author: "ingress",
  });
  if (!commented.success) {
    return { ok: false, error: commented.error ?? "comment_failed" };
  }

  if (!wasBlocked) {
    console.info(`[ea-owner-reply] ingress handoff task=${taskId} (already active)`);
    return { ok: true, evaluation_queued: false };
  }

  const wake = await queueOwnerReplyTaskHandler({ filesRoot: opts.filesRoot, taskId });
  if (!wake.queued) {
    console.warn(
      `[ea-owner-reply] handoff ok but evaluation queue failed task=${taskId} reason=${wake.reason}`,
    );
    return {
      ok: true,
      evaluation_queued: false,
      error: `handoff_ok_evaluation_failed:${wake.reason}`,
    };
  }
  console.info(`[ea-owner-reply] ingress handoff task=${taskId} evaluation_queued`);
  return { ok: true, evaluation_queued: true };
}

export { parseThreadIdFromTaskBody, threadIdInTaskSourcePaths };
