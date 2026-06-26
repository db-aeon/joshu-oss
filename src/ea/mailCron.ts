import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  callKanbanBridge,
  ensureEaMailIngressBoard,
  eaSchedulingKanbanAssignee,
} from "../hermesKanbanBridge.js";
import { readAgentProfile } from "../nylas/profile.js";
import { readAgentGrant } from "../nylas/store.js";
import type { AfterMirrorThreadInput } from "./triageTypes.js";
import { formatKanbanProfileBlock } from "./schedulingCron.js";
import {
  EA_MAIL_INGRESS_BOARD,
  EA_PLAYBOOK_SKILL,
  normalizeProjectSlug,
  parseEmailAddress,
  projectBoardSlug,
} from "./mailTypes.js";
import {
  mailIngressCanonicalId,
  mailIngressTaskIdempotencyKey,
  mailTrackTaskIdempotencyKey,
  lookupMailIngestAuthorization,
} from "./mailDedup.js";
import type { MailAgentAuthorization } from "./agentAuthorization.js";
import { resolveAuthorizationFromSourcePath } from "./agentAuthorization.js";

export type QueueMailIngressTaskResult = {
  queued: boolean;
  reason: string;
  taskId?: string;
};

export type MailTrackTaskSummary = {
  task_id: string;
  title?: string;
  status?: string;
  body?: string;
  board?: string;
  project_slug?: string;
};

const OPEN_TRACK_STATUSES = ["ready", "running", "blocked", "todo"] as const;

async function ensureProjectBoard(
  filesRoot: string,
  folderSlug: string,
  name?: string,
): Promise<string> {
  const boardSlug = projectBoardSlug(folderSlug);
  const projectDir = path.join(filesRoot, "Projects", folderSlug);
  await mkdir(projectDir, { recursive: true });
  await callKanbanBridge({
    action: "ensure_board",
    slug: boardSlug,
    name: name || folderSlug,
    description: "Joshu EA project track",
    default_workdir: projectDir,
  }).catch(() => {});
  return boardSlug;
}

function buildMailIngressTaskBody(
  input: AfterMirrorThreadInput & {
    messageId: string;
    classification: {
      category: string;
      project_slug: string | null;
      is_new_track: boolean;
      reason: string;
      scheduling_hint?: boolean;
      authorization: MailAgentAuthorization;
    };
  },
  profile: ReturnType<typeof readAgentProfile>,
  assistantEmail?: string,
): string {
  const fromEmail = parseEmailAddress(input.from);
  const slug = normalizeProjectSlug(input.classification.project_slug);
  const auth = input.classification.authorization;
  const schedulingEligible = auth.scheduling_eligible && input.classification.scheduling_hint === true;
  const allowedActions = schedulingEligible ? "file,schedule" : "file";
  const lines = [
    "kind: mail_ingress",
    `board: ${EA_MAIL_INGRESS_BOARD}`,
    `Use ${EA_PLAYBOOK_SKILL} skill — MAIL INGRESS mode.`,
    `message_id: ${input.messageId}`,
    `provider: ${input.provider}`,
    `thread_id: ${input.threadId}`,
    `source_path: ${input.sourcePath}`,
    `subject: ${JSON.stringify(input.subject?.trim() ?? "")}`,
    `from: ${JSON.stringify(input.from?.trim() ?? "")}`,
    ...(fromEmail ? [`from_email: ${fromEmail}`] : []),
    ...(input.receivedAt ? [`received_at: ${input.receivedAt}`] : []),
    ...(input.accountKey ? [`account_key: ${input.accountKey}`] : []),
    `agent_authorized: ${auth.agent_authorized}`,
    `scheduling_eligible: ${schedulingEligible}`,
    `allowed_actions: ${allowedActions}`,
    `authorization_reason: ${JSON.stringify(auth.reason)}`,
    "Job: FILE this email — match or create Projects/<slug>/ and project track.",
    "Standalone scheduling with no project → Projects/other/.",
    ...(auth.agent_authorized
      ? []
      : [
          "NOT authorized to act: Patrick was not copied on this message and owner did not delegate. File project docs only — no scheduling child, no outbound mail.",
        ]),
    ...(schedulingEligible
      ? [
          "After filing: scheduling_list_meeting_tasks by thread_id; handoff or scheduling_create_meeting_task (pass threadId) on ea-scheduling.",
        ]
      : []),
    "Route: match open track on project board or create blocked track via mail_* MCP.",
    "Use mail_* MCP — not Hermes kanban_create cross-board. Do not load ea-project-kanban.",
    ...formatKanbanProfileBlock(profile, assistantEmail),
  ];
  return lines.join("\n");
}

function mailIngressTaskTitle(subject?: string, from?: string): string {
  const subj = subject?.trim() || "(no subject)";
  const who = from?.trim();
  if (who) {
    const short = who.length > 48 ? `${who.slice(0, 45)}…` : who;
    return `Mail: ${subj} — ${short}`;
  }
  return `Mail: ${subj}`;
}

export function buildMailTrackTaskBody(opts: {
  subject?: string;
  from?: string;
  sourcePath: string;
  messageId: string;
  provider: string;
  threadId: string;
  projectSlug: string;
  category?: string;
  isNewTrack?: boolean;
}): string {
  const fromEmail = parseEmailAddress(opts.from);
  return [
    "kind: mail_track",
    `project_slug: ${opts.projectSlug}`,
    `state: waiting`,
    `message_id: ${opts.messageId}`,
    `provider: ${opts.provider}`,
    `thread_id: ${opts.threadId}`,
    `source_path: ${opts.sourcePath}`,
    `subject: ${JSON.stringify(opts.subject?.trim() ?? "")}`,
    ...(fromEmail ? [`from_email: ${fromEmail}`] : []),
    ...(opts.category ? [`category: ${opts.category}`] : []),
    ...(opts.isNewTrack !== undefined ? [`is_new_track: ${opts.isNewTrack}`] : []),
  ].join("\n");
}

/** Create one Kanban ingress task per trackable email on ea-mail-ingress. */
export async function queueMailIngressTask(
  input: AfterMirrorThreadInput & {
    messageId: string;
    classification: {
      category: string;
      project_slug: string | null;
      is_new_track: boolean;
      reason: string;
      scheduling_hint?: boolean;
      authorization: MailAgentAuthorization;
    };
  },
): Promise<QueueMailIngressTaskResult> {
  const messageId = input.messageId.trim();
  if (!messageId) {
    return { queued: false, reason: "missing_message_id" };
  }

  const { filesRoot, projectRoot = process.cwd() } = input;
  const profile = readAgentProfile(projectRoot);
  const assistantEmail = readAgentGrant(projectRoot)?.email;
  const body = buildMailIngressTaskBody(input, profile, assistantEmail);
  const canonicalId = mailIngressCanonicalId({
    rfcMessageId: input.rfcMessageId,
    messageId,
  });
  const idempotencyKey = mailIngressTaskIdempotencyKey(canonicalId);

  await ensureEaMailIngressBoard(filesRoot).catch((err) => {
    console.warn(`[ea-mail] ingress board ensure: ${(err as Error).message}`);
  });

  const slug = normalizeProjectSlug(input.classification.project_slug);
  await ensureProjectBoard(filesRoot, slug).catch(() => {});

  const result = await callKanbanBridge({
    action: "create",
    board: EA_MAIL_INGRESS_BOARD,
    title: mailIngressTaskTitle(input.subject, input.from),
    body,
    assignee: eaSchedulingKanbanAssignee(),
    idempotency_key: idempotencyKey,
    skills: [EA_PLAYBOOK_SKILL],
    workspace_kind: "dir",
    workspace_path: filesRoot,
  });

  if (!result.success) {
    console.warn(`[ea-mail] ingress action=failed reason=${result.error ?? "unknown"}`);
    return { queued: false, reason: result.error ?? "kanban_create_failed" };
  }

  const actionTaken = result.action_taken ?? "created";
  console.info(
    `[ea-mail] ingress action=${actionTaken} task=${result.task_id ?? "?"} message=${messageId}`,
  );
  return {
    queued: actionTaken !== "existing_active",
    reason: actionTaken,
    taskId: result.task_id,
  };
}

/** List open mail track tasks on a project board. */
export async function listMailTrackTasks(opts: {
  filesRoot: string;
  projectSlug: string;
  limit?: number;
}): Promise<MailTrackTaskSummary[]> {
  const folderSlug = normalizeProjectSlug(opts.projectSlug);
  const board = projectBoardSlug(folderSlug);
  await ensureProjectBoard(opts.filesRoot, folderSlug);

  const byId = new Map<string, MailTrackTaskSummary>();
  for (const status of OPEN_TRACK_STATUSES) {
    const result = await callKanbanBridge({
      action: "list",
      board,
      status,
      limit: opts.limit ?? 50,
      include_body: true,
    });
    if (!result.success || !result.tasks) continue;
    for (const t of result.tasks) {
      const id = t.task_id?.trim();
      if (!id) continue;
      const body = t.body ?? "";
      if (body.includes("kind: mail_ingress")) continue;
      byId.set(id, {
        task_id: id,
        title: t.title,
        status: t.status,
        body,
        board,
        project_slug: folderSlug,
      });
    }
  }
  return [...byId.values()];
}

export type QueueMailTrackTaskResult = {
  queued: boolean;
  reason: string;
  taskId?: string;
  board?: string;
  project_slug?: string;
};

/** Create blocked track task on project-<slug> (ingress worker — via Joshu bridge). */
export async function queueMailTrackTask(opts: {
  filesRoot: string;
  messageId: string;
  sourcePath: string;
  subject?: string;
  from?: string;
  provider: string;
  threadId: string;
  projectSlug: string;
  category?: string;
  isNewTrack?: boolean;
  title?: string;
}): Promise<QueueMailTrackTaskResult> {
  const messageId = opts.messageId.trim();
  const folderSlug = normalizeProjectSlug(opts.projectSlug);
  const board = await ensureProjectBoard(opts.filesRoot, folderSlug);
  const projectDir = path.join(opts.filesRoot, "Projects", folderSlug);

  const body = buildMailTrackTaskBody({
    subject: opts.subject,
    from: opts.from,
    sourcePath: opts.sourcePath,
    messageId,
    provider: opts.provider,
    threadId: opts.threadId,
    projectSlug: folderSlug,
    category: opts.category,
    isNewTrack: opts.isNewTrack,
  });
  const title =
    opts.title?.trim() ||
    (opts.subject?.trim() ? `Track: ${opts.subject.trim()}` : `Track: ${folderSlug}`);

  const result = await callKanbanBridge({
    action: "create",
    board,
    title,
    body,
    assignee: eaSchedulingKanbanAssignee(),
    idempotency_key: mailTrackTaskIdempotencyKey(messageId),
    skills: [EA_PLAYBOOK_SKILL],
    workspace_kind: "dir",
    workspace_path: projectDir,
  });

  if (!result.success || !result.task_id) {
    return { queued: false, reason: result.error ?? "kanban_create_failed" };
  }

  // Default: waiting on human → blocked
  await callKanbanBridge({
    action: "block",
    board,
    task_id: result.task_id,
    reason: "awaiting owner or external party",
  }).catch((err) => {
    console.warn(`[ea-mail] track block after create: ${(err as Error).message}`);
  });

  console.info(
    `[ea-mail] track action=${result.action_taken ?? "created"} board=${board} task=${result.task_id}`,
  );
  return {
    queued: (result.action_taken ?? "created") !== "existing_active",
    reason: result.action_taken ?? "created",
    taskId: result.task_id,
    board,
    project_slug: folderSlug,
  };
}

export type HandoffMailTrackResult = {
  ok: boolean;
  error?: string;
  evaluation_queued?: boolean;
};

function buildMailHandoffAppend(opts: {
  existingBody: string;
  sourcePath: string;
  messageId: string;
  from?: string;
  summary: string;
}): string {
  const lines: string[] = [];
  const sp = opts.sourcePath.trim();
  if (sp && !opts.existingBody.includes(sp)) {
    if (opts.existingBody.includes("source_paths:")) {
      lines.push(`  - ${sp}`);
    } else {
      lines.push("source_paths:", `  - ${sp}`);
    }
  }
  lines.push(
    "mail_handoff:",
    `  message_id: ${opts.messageId}`,
    `  source_path: ${sp}`,
    ...(opts.from?.trim() ? [`  from: ${opts.from.trim()}`] : []),
    `  at: ${new Date().toISOString()}`,
    `  summary: ${JSON.stringify(opts.summary.trim())}`,
  );
  return lines.join("\n");
}

/** Ingress delivers new mail to an existing track task. */
export async function handoffMailToTrackTask(opts: {
  filesRoot: string;
  projectSlug: string;
  taskId: string;
  sourcePath: string;
  messageId: string;
  from?: string;
  summary: string;
}): Promise<HandoffMailTrackResult> {
  const taskId = opts.taskId.trim();
  const folderSlug = normalizeProjectSlug(opts.projectSlug);
  const board = projectBoardSlug(folderSlug);
  const sourcePath = opts.sourcePath.trim();
  const messageId = opts.messageId.trim();
  const summary = opts.summary.trim();
  if (!taskId || !sourcePath || !messageId || !summary) {
    return { ok: false, error: "taskId, sourcePath, messageId, summary required" };
  }

  const before = await callKanbanBridge({ action: "show", board, task_id: taskId });
  if (!before.success || !before.task) {
    return { ok: false, error: before.error ?? "task_not_found" };
  }
  const wasBlocked = before.task.status === "blocked";

  const append = buildMailHandoffAppend({
    existingBody: before.task.body ?? "",
    sourcePath,
    messageId,
    from: opts.from,
    summary,
  });
  const appended = await callKanbanBridge({
    action: "append_body",
    board,
    task_id: taskId,
    append,
  });
  if (!appended.success) {
    return { ok: false, error: appended.error ?? "append_body_failed" };
  }

  await callKanbanBridge({
    action: "comment",
    board,
    task_id: taskId,
    body: ["## Mail ingress handoff", "", summary, "", `source_path: ${sourcePath}`].join("\n"),
    author: "mail-ingress",
  });

  if (!wasBlocked) {
    return { ok: true, evaluation_queued: false };
  }

  const auth =
    (await lookupMailIngestAuthorization(opts.filesRoot, messageId)) ??
    (await resolveAuthorizationFromSourcePath({
      filesRoot: opts.filesRoot,
      sourcePath,
    }));
  if (auth && !auth.agent_authorized) {
    console.info(
      `[ea-mail] handoff file-only task=${taskId} message=${messageId} (${auth.reason})`,
    );
    return { ok: true, evaluation_queued: false };
  }

  const wake = await queueMailTrackTaskHandler({
    filesRoot: opts.filesRoot,
    projectSlug: folderSlug,
    taskId,
  });
  return {
    ok: true,
    evaluation_queued: wake.queued,
    ...(wake.queued ? {} : { error: `handoff_ok_evaluation_failed:${wake.reason}` }),
  };
}

export async function queueMailTrackTaskHandler(opts: {
  filesRoot: string;
  projectSlug: string;
  taskId: string;
}): Promise<QueueMailTrackTaskResult> {
  const board = projectBoardSlug(normalizeProjectSlug(opts.projectSlug));
  const result = await callKanbanBridge({
    action: "unblock",
    board,
    task_id: opts.taskId.trim(),
  });
  if (!result.success) {
    return { queued: false, reason: result.error ?? "unblock_failed" };
  }
  return { queued: true, reason: result.action_taken ?? "unblocked", taskId: opts.taskId };
}

export { EA_MAIL_INGRESS_BOARD, EA_PLAYBOOK_SKILL } from "./mailTypes.js";
