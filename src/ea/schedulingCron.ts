import { connectorStatePath } from "../connectors/paths.js";
import {
  callKanbanBridge,
  ensureEaSchedIngressBoard,
  ensureEaSchedulingBoard,
  eaSchedulingKanbanAssignee,
} from "../hermesKanbanBridge.js";
import { readAgentProfile, type NylasAgentProfile } from "../nylas/profile.js";
import { readAgentGrant } from "../nylas/store.js";
import type { AfterMirrorThreadInput } from "./triageTypes.js";
import {
  buildIngressEventId,
  EA_SCHED_INGRESS_BOARD,
  EA_SCHEDULING_BOARD,
  EA_SCHEDULING_SKILL,
  ingressTaskIdempotencyKey,
  meetingTaskIdempotencyKey,
  meetingTaskIdempotencyKeyFromMessage,
  parseEmailAddress,
} from "./schedulingTypes.js";
import { mailIngressCanonicalId } from "./mailDedup.js";

export type QueueIngressTaskResult = {
  queued: boolean;
  reason: string;
  taskId?: string;
};

/** @deprecated Use QueueIngressTaskResult */
export type QueueInboxProcessorResult = QueueIngressTaskResult;

export type QueueMeetingTaskResult = {
  queued: boolean;
  reason: string;
  taskId?: string;
};

export type SchedulingMeetingTaskSummary = {
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

const OPEN_MEETING_STATUSES = ["ready", "running", "blocked", "todo"] as const;

export function buildMeetingTaskBody(opts: {
  subject?: string;
  fromEmail?: string | null;
  sourcePath: string;
  timezone?: string | null;
  messageId?: string;
  threadId?: string;
  provider?: string;
}): string {
  const lines = [
    "kind: meeting",
    "state: open",
    "participants:",
    ...(opts.fromEmail ? [`  - ${opts.fromEmail}`] : []),
    "source_paths:",
    `  - ${opts.sourcePath}`,
    ...(opts.messageId?.trim() ? [`message_id: ${opts.messageId.trim()}`] : []),
    ...(opts.provider?.trim() ? [`provider: ${opts.provider.trim()}`] : []),
    ...(opts.threadId?.trim() ? [`thread_id: ${opts.threadId.trim()}`] : []),
    `subject: ${JSON.stringify(opts.subject?.trim() || "(no subject)")}`,
    `timezone: ${opts.timezone?.trim() || "pending"}`,
    "calendar_event_id: null",
  ];
  return lines.join("\n");
}

/** Parse `thread_id:` from a meeting task body (YAML-ish). */
export function parseThreadIdFromTaskBody(body: string): string | null {
  const match = /^thread_id:\s*(.+)$/m.exec(body);
  const value = match?.[1]?.trim();
  return value || null;
}

/** True when a mirror path in the task body references this thread id. */
export function threadIdInTaskSourcePaths(body: string, threadId: string): boolean {
  const id = threadId.trim();
  if (!id) return false;
  return body.includes(`/threads/${id}`) || body.includes(`${id}.md`);
}

/** Match an open meeting task to a mail thread (body field or source_paths). */
export function findOpenMeetingByThread(
  tasks: SchedulingMeetingTaskSummary[],
  threadId: string,
): SchedulingMeetingTaskSummary | undefined {
  const normalized = threadId.trim();
  if (!normalized) return undefined;
  return tasks.find((t) => {
    const body = t.body ?? "";
    if (parseThreadIdFromTaskBody(body) === normalized) return true;
    return threadIdInTaskSourcePaths(body, normalized);
  });
}

function meetingTaskTitle(subject?: string, from?: string): string {
  const subj = subject?.trim() || "Scheduling";
  const who = from?.trim();
  if (who) {
    const short = who.length > 40 ? `${who.slice(0, 37)}…` : who;
    return `${subj} — ${short}`;
  }
  return subj;
}

/** List non-terminal meeting tasks on ea-scheduling (Joshu bridge — correct board). */
export async function listSchedulingMeetingTasks(opts: {
  filesRoot: string;
  limit?: number;
  threadId?: string;
}): Promise<SchedulingMeetingTaskSummary[]> {
  const { filesRoot, limit = 50, threadId } = opts;
  await ensureEaSchedulingBoard(filesRoot).catch(() => {});

  const byId = new Map<string, SchedulingMeetingTaskSummary>();
  for (const status of OPEN_MEETING_STATUSES) {
    const result = await callKanbanBridge({
      action: "list",
      board: EA_SCHEDULING_BOARD,
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
      // Board is ea-scheduling-only; meeting workers may omit `kind: meeting` (e.g. after kanban_block).
      if (body.includes("kind: ingress")) continue;
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
  const matched = findOpenMeetingByThread(tasks, filterThread);
  return matched ? [matched] : [];
}

/** Create (or return existing) meeting task on ea-scheduling — never on ingress. */
export async function queueSchedulingMeetingTask(opts: {
  filesRoot: string;
  messageId: string;
  subject?: string;
  from?: string;
  sourcePath: string;
  timezone?: string | null;
  title?: string;
  body?: string;
  threadId?: string;
  provider?: string;
}): Promise<QueueMeetingTaskResult> {
  const messageId = opts.messageId.trim();
  if (!messageId) {
    return { queued: false, reason: "missing_message_id" };
  }

  const { filesRoot } = opts;
  const threadId = opts.threadId?.trim();
  const fromEmail = parseEmailAddress(opts.from);
  const body =
    opts.body?.trim() ||
    buildMeetingTaskBody({
      subject: opts.subject,
      fromEmail,
      sourcePath: opts.sourcePath,
      timezone: opts.timezone,
      messageId,
      threadId,
      provider: opts.provider,
    });
  const title = opts.title?.trim() || meetingTaskTitle(opts.subject, opts.from);
  const idempotencyKey = meetingTaskIdempotencyKeyFromMessage(messageId);

  await ensureEaSchedulingBoard(filesRoot).catch((err) => {
    console.warn(`[ea-scheduling] meeting board ensure: ${(err as Error).message}`);
  });

  // Safety net: one open meeting per mail thread (follow-up messages should handoff, not create).
  if (threadId) {
    const open = await listSchedulingMeetingTasks({ filesRoot });
    const existing = findOpenMeetingByThread(open, threadId);
    if (existing?.task_id) {
      console.info(
        `[ea-scheduling] meeting thread dedup thread=${threadId} task=${existing.task_id} message=${messageId}`,
      );
      return { queued: false, reason: "existing_thread", taskId: existing.task_id };
    }
  }

  const result = await callKanbanBridge({
    action: "create",
    board: EA_SCHEDULING_BOARD,
    title,
    body,
    assignee: eaSchedulingKanbanAssignee(),
    idempotency_key: idempotencyKey,
    skills: [EA_SCHEDULING_SKILL],
    workspace_kind: "dir",
    workspace_path: filesRoot,
  });

  if (!result.success) {
    console.warn(`[ea-scheduling] meeting create failed reason=${result.error ?? "unknown"}`);
    return { queued: false, reason: result.error ?? "kanban_create_failed" };
  }

  const actionTaken = result.action_taken ?? "created";
  console.info(
    `[ea-scheduling] meeting action=${actionTaken} board=${EA_SCHEDULING_BOARD} task=${result.task_id ?? "?"} message=${messageId}`,
  );
  return {
    queued: actionTaken !== "existing_active",
    reason: actionTaken,
    taskId: result.task_id,
  };
}

export type CommentMeetingTaskResult = { ok: boolean; error?: string };

/** Simple comment on a meeting task (e.g. link after create). */
export async function commentSchedulingMeetingTask(opts: {
  filesRoot: string;
  taskId: string;
  body: string;
}): Promise<CommentMeetingTaskResult> {
  const taskId = opts.taskId.trim();
  if (!taskId) return { ok: false, error: "task_id required" };
  const result = await callKanbanBridge({
    action: "comment",
    board: EA_SCHEDULING_BOARD,
    task_id: taskId,
    body: opts.body,
    author: "ingress",
  });
  return result.success ? { ok: true } : { ok: false, error: result.error ?? "comment_failed" };
}

export type HandoffIngressReplyResult = {
  ok: boolean;
  error?: string;
  /** Meeting worker was queued to evaluate new mail (task may return to blocked). */
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

/**
 * Ingress delivers new mail to a meeting task — append paths + handoff record, comment.
 * If the task was blocked, Joshu queues one meeting-worker evaluation run (not "waiting over").
 * The meeting worker decides: book, negotiate, or kanban_block again.
 */
export async function handoffIngressReplyToMeeting(opts: {
  filesRoot: string;
  taskId: string;
  sourcePath: string;
  messageId: string;
  from?: string;
  summary: string;
}): Promise<HandoffIngressReplyResult> {
  const taskId = opts.taskId.trim();
  const sourcePath = opts.sourcePath.trim();
  const messageId = opts.messageId.trim();
  const summary = opts.summary.trim();
  if (!taskId || !sourcePath || !messageId || !summary) {
    return { ok: false, error: "taskId, sourcePath, messageId, summary required" };
  }

  const before = await callKanbanBridge({
    action: "show",
    board: EA_SCHEDULING_BOARD,
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
    board: EA_SCHEDULING_BOARD,
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
    "Meeting worker: read the thread, then decide — book, negotiate, or kanban_block if still waiting.",
  ].join("\n");

  const commented = await callKanbanBridge({
    action: "comment",
    board: EA_SCHEDULING_BOARD,
    task_id: taskId,
    body: commentBody,
    author: "ingress",
  });
  if (!commented.success) {
    return { ok: false, error: commented.error ?? "comment_failed" };
  }

  if (!wasBlocked) {
    console.info(`[ea-scheduling] ingress handoff task=${taskId} (meeting already active)`);
    return { ok: true, evaluation_queued: false };
  }

  const wake = await queueMeetingTaskHandler({ filesRoot: opts.filesRoot, taskId });
  if (!wake.queued) {
    console.warn(
      `[ea-scheduling] ingress handoff ok but evaluation queue failed task=${taskId} reason=${wake.reason}`,
    );
    return {
      ok: true,
      evaluation_queued: false,
      error: `handoff_ok_evaluation_failed:${wake.reason}`,
    };
  }
  console.info(`[ea-scheduling] ingress handoff task=${taskId} evaluation_queued`);
  return { ok: true, evaluation_queued: true };
}

/** Human-readable owner profile block — avoids Hermes hunting `.joshu` under JOSHU_FILES_ROOT. */
export function formatKanbanProfileBlock(
  profile: NylasAgentProfile | null,
  assistantEmail?: string,
): string[] {
  const lines = [
    "Owner profile (injected at queue — use this; do not read .joshu from disk):",
  ];
  if (!profile) {
    lines.push("  (no profile on file — timezone MISSING; must clarify before booking)");
    if (assistantEmail) lines.push(`  assistant_email: ${assistantEmail}`);
    return lines;
  }

  if (profile.ownerName) lines.push(`  owner_name: ${profile.ownerName}`);
  if (profile.assistantName) lines.push(`  assistant_name: ${profile.assistantName}`);
  const email = profile.assistantEmail?.trim() || assistantEmail;
  if (email) lines.push(`  assistant_email: ${email}`);
  if (profile.primaryWorkEmail) lines.push(`  primary_work_email: ${profile.primaryWorkEmail}`);
  if (profile.personalEmail) lines.push(`  personal_email: ${profile.personalEmail}`);

  const tz = profile.timezone?.trim();
  if (tz) {
    lines.push(`  timezone: ${tz}`);
  } else {
    lines.push("  timezone: MISSING — must clarify before booking");
  }

  if (profile.workingHoursStart || profile.workingHoursEnd) {
    lines.push(
      `  working_hours: ${profile.workingHoursStart ?? "?"}–${profile.workingHoursEnd ?? "?"}`,
    );
  }

  return lines;
}

function buildIngressTaskBody(
  input: AfterMirrorThreadInput & { messageId: string },
  profile: NylasAgentProfile | null,
  assistantEmail?: string,
): string {
  const ingressId = buildIngressEventId(input.provider, input.threadId, input.messageId);
  const fromEmail = parseEmailAddress(input.from);
  const lines = [
    "kind: ingress",
    `board: ${EA_SCHED_INGRESS_BOARD}`,
    `Use ${EA_SCHEDULING_SKILL} skill — INGRESS mode (see skill).`,
    `ingress_id: ${ingressId}`,
    `message_id: ${input.messageId}`,
    `provider: ${input.provider}`,
    `thread_id: ${input.threadId}`,
    `source_path: ${input.sourcePath}`,
    `subject: ${JSON.stringify(input.subject?.trim() ?? "")}`,
    `from: ${JSON.stringify(input.from?.trim() ?? "")}`,
    ...(fromEmail ? [`from_email: ${fromEmail}`] : []),
    ...(input.receivedAt ? [`received_at: ${input.receivedAt}`] : []),
    ...(input.accountKey ? [`account_key: ${input.accountKey}`] : []),
    "Route to ea-scheduling: match open meeting tasks or create new meeting task.",
    ...formatKanbanProfileBlock(profile, assistantEmail),
  ];
  return lines.join("\n");
}

function ingressTaskTitle(subject?: string, from?: string): string {
  const subj = subject?.trim() || "(no subject)";
  const who = from?.trim();
  if (who) {
    const short = who.length > 48 ? `${who.slice(0, 45)}…` : who;
    return `Scheduling mail: ${subj} — ${short}`;
  }
  return `Scheduling mail: ${subj}`;
}

/**
 * Create one Kanban ingress task per scheduling email on ea-sched-ingress.
 * Called after classifier flags scheduling mail.
 */
export async function queueSchedulingIngressTask(
  input: AfterMirrorThreadInput & { messageId: string },
): Promise<QueueIngressTaskResult> {
  const messageId = input.messageId.trim();
  if (!messageId) {
    return { queued: false, reason: "missing_message_id" };
  }

  const { filesRoot, projectRoot = process.cwd() } = input;
  const profile = readAgentProfile(projectRoot);
  const assistantEmail = readAgentGrant(projectRoot)?.email;
  const body = buildIngressTaskBody(input, profile, assistantEmail);
  const canonicalId = mailIngressCanonicalId({
    rfcMessageId: input.rfcMessageId,
    messageId,
  });
  const idempotencyKey = ingressTaskIdempotencyKey(canonicalId);

  await Promise.all([
    ensureEaSchedIngressBoard(filesRoot).catch((err) => {
      console.warn(`[ea-scheduling] ingress board ensure: ${(err as Error).message}`);
    }),
    ensureEaSchedulingBoard(filesRoot).catch((err) => {
      console.warn(`[ea-scheduling] scheduling board ensure: ${(err as Error).message}`);
    }),
  ]);

  const result = await callKanbanBridge({
    action: "create",
    board: EA_SCHED_INGRESS_BOARD,
    title: ingressTaskTitle(input.subject, input.from),
    body,
    assignee: eaSchedulingKanbanAssignee(),
    idempotency_key: idempotencyKey,
    skills: [EA_SCHEDULING_SKILL],
    workspace_kind: "dir",
    workspace_path: filesRoot,
  });

  if (!result.success) {
    console.warn(
      `[ea-scheduling] ingress action=failed reason=${result.error ?? "unknown"}`,
    );
    return { queued: false, reason: result.error ?? "kanban_create_failed" };
  }

  const actionTaken = result.action_taken ?? "created";
  console.info(
    `[ea-scheduling] ingress action=${actionTaken} task=${result.task_id ?? "?"} message=${messageId}`,
  );
  return {
    queued: actionTaken !== "existing_active",
    reason: actionTaken,
    taskId: result.task_id,
  };
}

/**
 * @deprecated Singleton inbox processor — use queueSchedulingIngressTask.
 */
export async function queueSchedulingInboxProcessor(opts: {
  filesRoot: string;
  ingressRelativePath: string;
  projectRoot?: string;
}): Promise<QueueInboxProcessorResult> {
  console.warn(
    "[ea-scheduling] queueSchedulingInboxProcessor is deprecated — use queueSchedulingIngressTask",
  );
  void opts;
  return { queued: false, reason: "deprecated_use_queueSchedulingIngressTask" };
}

/**
 * Unblock an existing meeting task (task_id = meeting project).
 */
export async function queueMeetingTaskHandler(opts: {
  filesRoot: string;
  taskId: string;
  projectRoot?: string;
}): Promise<QueueMeetingTaskResult> {
  const { filesRoot, taskId } = opts;

  await ensureEaSchedulingBoard(filesRoot).catch((err) => {
    console.warn(`[ea-scheduling] kanban board ensure: ${(err as Error).message}`);
  });

  const result = await callKanbanBridge({
    action: "unblock",
    board: EA_SCHEDULING_BOARD,
    task_id: taskId,
    idempotency_key: meetingTaskIdempotencyKey(taskId),
  });

  if (!result.success) {
    console.warn(
      `[ea-scheduling] meeting task=${taskId} unblock failed reason=${result.error ?? "unknown"}`,
    );
    return { queued: false, reason: result.error ?? "unblock_failed" };
  }

  const actionTaken = result.action_taken ?? "unblocked";
  console.info(`[ea-scheduling] meeting task=${taskId} action=${actionTaken}`);
  return { queued: true, reason: actionTaken, taskId };
}

/** Path for optional meeting sidecar backup keyed by task_id. */
export function meetingSidecarPath(filesRoot: string, taskId: string): string {
  const safe = taskId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
  return connectorStatePath(filesRoot, `meetings/${safe}.json`);
}

export {
  EA_SCHED_INGRESS_BOARD,
  EA_SCHEDULING_BOARD,
  EA_SCHEDULING_SKILL,
} from "./schedulingTypes.js";

/** @deprecated MD case queue removed — use queueSchedulingIngressTask. */
export async function queueSchedulingCaseHandler(_opts: {
  filesRoot: string;
  record: { relativePath: string; frontmatter: { case_id: string; state: string; subject: string } };
  stubRelativePath?: string;
  force?: boolean;
  projectRoot?: string;
}): Promise<{ queued: boolean; reason: string; taskId?: string }> {
  console.warn("[ea-scheduling] queueSchedulingCaseHandler is deprecated — use ingress + Kanban");
  return { queued: false, reason: "deprecated_use_ingress" };
}

/** @deprecated */
export async function queueSchedulingCron(_opts: unknown): Promise<void> {
  console.warn("[ea-scheduling] queueSchedulingCron is deprecated");
}
