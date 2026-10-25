import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  callKanbanBridge,
  type KanbanBridgeCall,
  eaKanbanCreateDefaults,
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
} from "./mailDedup.js";
import type { MailAgentAuthorization } from "./agentAuthorization.js";
import { resolveOwnerEmails } from "./agentAuthorization.js";
import { resolveJoshuAgentEmails } from "./ingestFilters.js";
import { isOwnerReplyEligible, isOwnerDirectAgentAsk, ownerReplyIngressPlaybookLines } from "./ownerReplyEligibility.js";
import {
  listActiveCoordinationForScope,
  resolveMailCoordinationScope,
} from "./conversationScope.js";
import {
  listSchedulingMeetingTasks,
  parseThreadIdFromTaskBody,
  threadIdInTaskSourcePaths,
} from "./schedulingCron.js";
import { listOwnerReplyTasks } from "./ownerReplyCron.js";

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
  bridge: KanbanBridgeCall = callKanbanBridge,
): Promise<string> {
  const boardSlug = projectBoardSlug(folderSlug);
  const projectDir = path.join(filesRoot, "Projects", folderSlug);
  await mkdir(projectDir, { recursive: true });
  await bridge({
    action: "ensure_board",
    slug: boardSlug,
    name: name || folderSlug,
    description: "Joshu EA project track",
    default_workdir: projectDir,
  }).catch(() => {});
  return boardSlug;
}

export async function buildMailIngressTaskBody(
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
): Promise<string> {
  const fromEmail = parseEmailAddress(input.from);
  const slug = normalizeProjectSlug(input.classification.project_slug);
  const auth = input.classification.authorization;
  const projectRoot = input.projectRoot ?? process.cwd();
  const schedulingHint = auth.scheduling_eligible && input.classification.scheduling_hint === true;
  const gateAgentEmails = resolveJoshuAgentEmails(projectRoot);
  if (assistantEmail?.trim()) {
    gateAgentEmails.add(assistantEmail.trim().toLowerCase());
  }
  const directAgentAsk = isOwnerDirectAgentAsk({
    from: input.from,
    to: input.to,
    cc: input.cc,
    projectRoot,
    agentEmails: gateAgentEmails,
    ownerEmails: resolveOwnerEmails(projectRoot, input.accountEmail),
    provider: input.provider,
  });
  const schedulingPathA = schedulingHint && !directAgentAsk;

  let hasMeetingNegotiation = false;
  let hasOwnerDeliverable = false;
  let coordinationScopeId: string | undefined;
  const threadId = input.threadId?.trim();
  if (threadId && input.filesRoot) {
    try {
      const scope = await resolveMailCoordinationScope({
        channel: "mail",
        filesRoot: input.filesRoot,
        threadId,
        provider: input.provider,
        sourcePath: input.sourcePath,
        subject: input.subject,
        from: input.from,
        to: input.to,
        cc: input.cc,
        projectSlug: slug,
        projectRoot,
      });
      coordinationScopeId = scope.scopeId;
      const [schedulingTasks, ownerReplyTasks] = await Promise.all([
        listSchedulingMeetingTasks({ filesRoot: input.filesRoot }),
        listOwnerReplyTasks({ filesRoot: input.filesRoot }),
      ]);
      const active = await listActiveCoordinationForScope({
        filesRoot: input.filesRoot,
        scope,
        schedulingTasks,
        ownerReplyTasks,
      });
      hasMeetingNegotiation = active.some((a) => a.capability === "meeting_negotiation");
      hasOwnerDeliverable = active.some((a) => a.capability === "owner_deliverable");
    } catch {
      /* scope preflight is best-effort at ingress body build */
    }
  }

  const ownerReplyGate = isOwnerReplyEligible({
    provider: input.provider,
    agentInbox: input.provider === "nylas",
    from: input.from,
    to: input.to,
    cc: input.cc,
    ownerEmails: resolveOwnerEmails(projectRoot, input.accountEmail),
    disposition: "track",
    category: input.classification.category,
    schedulingPathA,
    projectRoot,
    agentEmails: gateAgentEmails,
  });
  const ownerReplyEligible =
    ownerReplyGate.eligible && !hasMeetingNegotiation && !hasOwnerDeliverable;
  const schedulingEligible =
    schedulingHint && !ownerReplyEligible && !hasOwnerDeliverable;
  const schedulingHandoffOnly = hasMeetingNegotiation && schedulingHint;
  const allowedActions = schedulingEligible
    ? "file,schedule"
    : ownerReplyEligible
      ? "file,reply"
      : "file";
  const lines = [
    "kind: mail_ingress",
    `board: ${EA_MAIL_INGRESS_BOARD}`,
    `Use ${EA_PLAYBOOK_SKILL} skill — MAIL INGRESS mode.`,
    "REQUIRED FIRST: skill_view('ea-playbook') then follow MAIL INGRESS short-circuit (do not explore).",
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
    ...(auth.owner_on_thread !== undefined ? [`owner_on_thread: ${auth.owner_on_thread}`] : []),
    `scheduling_eligible: ${schedulingEligible}`,
    `owner_reply_eligible: ${ownerReplyEligible}`,
    `allowed_actions: ${allowedActions}`,
    `authorization_reason: ${JSON.stringify(auth.reason)}`,
    ...(coordinationScopeId ? [`coordination_scope_id: ${coordinationScopeId}`] : []),
    ...(hasMeetingNegotiation
      ? ["coordination_note: open meeting_negotiation on scope — handoff only, do not create duplicate child."]
      : []),
    ...(hasOwnerDeliverable
      ? ["coordination_note: open owner_deliverable on scope — handoff only."]
      : []),
    `Order: (1) skill_view ea-playbook (2) read_file source_path (3) file Projects/<slug>/ (4) mail_list_track_tasks(projectSlug=…, threadId=${input.threadId}) — one track returned → handoff to it; none but done_match → handoff to done_match if this email continues that matter (Joshu reopens it); else mail_list_track_tasks(projectSlug=…) (compact track list) and match by judgment, else create (4b) Project reconcile only if no handoff returned evaluation_queued: true (5) schedule only if allowed_actions includes schedule (5b) owner_reply spawn if owner_reply_eligible (6) Triage stub state:done → _done/ (7) kanban_complete.`,
    "MCP args: projectSlug = folder slug (not board id, not nested tool_call). Stub = Triage/gmail-<account_key>-<thread_id>.stub.md (or <provider>-<thread_id>.stub.md).",
    "Job: FILE this email — match or create Projects/<slug>/ and project track.",
    "Standalone scheduling with no project → Projects/other/.",
    ...(auth.agent_authorized
      ? []
      : [
          "NOT authorized to act: the companion was not copied on this message and owner did not delegate. File project docs only — no scheduling child, no outbound mail.",
        ]),
    ...(auth.owner_on_thread === false
      ? [
          "Owner was not on prior thread messages — external replies must CC owner (API enforced); include brief context in outreach.",
        ]
      : []),
    ...(schedulingEligible
      ? [
          "After filing: scheduling_list_meeting_tasks by thread_id; handoff or scheduling_create_meeting_task (pass threadId) on ea-scheduling.",
        ]
      : []),
    ...(schedulingHandoffOnly
      ? [
          "After filing: scheduling_list_meeting_tasks by thread_id; scheduling_handoff_meeting_task only — coordination scope already has open meeting_negotiation (do not scheduling_create_meeting_task).",
        ]
      : []),
    ...ownerReplyIngressPlaybookLines(ownerReplyEligible),
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
  const body = await buildMailIngressTaskBody(input, profile, assistantEmail);
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
    ...eaKanbanCreateDefaults(EA_MAIL_INGRESS_BOARD),
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

/** Match an open mail track task to a mail thread (body field or source_paths). */
export function findOpenMailTrackByThread(
  tasks: MailTrackTaskSummary[],
  threadId: string,
): MailTrackTaskSummary | undefined {
  const normalized = threadId.trim();
  if (!normalized) return undefined;
  return tasks.find((t) => {
    const body = t.body ?? "";
    if (parseThreadIdFromTaskBody(body) === normalized) return true;
    return threadIdInTaskSourcePaths(body, normalized);
  });
}

const PROJECT_BOARD_PREFIX = "project-";

/**
 * Each open track on the given project boards that is a thread match.
 * One Kanban bridge call for all boards (spec gmail-sync).
 */
export async function findOpenMailTracksByThreadOnBoards(
  threadId: string,
  boards: string[],
  bridge: KanbanBridgeCall = callKanbanBridge,
): Promise<MailTrackTaskSummary[]> {
  const normalized = threadId.trim();
  const projectBoards = boards.filter((b) => b.startsWith(PROJECT_BOARD_PREFIX));
  if (!normalized || projectBoards.length === 0) return [];
  const result = await bridge({
    action: "find_open_by_text",
    boards: projectBoards,
    text: normalized,
    statuses: [...OPEN_TRACK_STATUSES],
  });
  if (!result.success || !result.tasks) return [];
  const out: MailTrackTaskSummary[] = [];
  for (const t of result.tasks) {
    const id = t.task_id?.trim();
    const board = t.board?.trim();
    const body = t.body ?? "";
    if (!id || !board || body.includes("kind: mail_ingress")) continue;
    const track: MailTrackTaskSummary = {
      task_id: id,
      title: t.title,
      status: t.status,
      body,
      board,
      project_slug: board.slice(PROJECT_BOARD_PREFIX.length),
    };
    if (findOpenMailTrackByThread([track], normalized)) out.push(track);
  }
  return out;
}

/** Entry of the compact track list (openspec/glossary.md): no full body. */
export type CompactMailTrack = {
  task_id: string;
  title?: string;
  status?: string;
  thread_ids: string[];
  latest_handoff?: { at?: string; summary: string };
  completed_at?: number | string;
};

export type MailTrackList = {
  tasks: Array<MailTrackTaskSummary | CompactMailTrack>;
  /** Done match (openspec/glossary.md): only when threadId finds no open track. */
  done_match?: CompactMailTrack;
};

const LATEST_HANDOFF_SUMMARY_MAX = 200;
const OPEN_TRACK_LIST_LIMIT = 200;
const DONE_TRACK_LIST_LIMIT = 1000;

/** Thread ids that the full body of a track references, in order of first reference. */
export function threadIdsInTaskBody(body: string): string[] {
  const ids: string[] = [];
  const add = (id: string | null | undefined) => {
    const v = id?.trim();
    if (v && !ids.includes(v)) ids.push(v);
  };
  add(parseThreadIdFromTaskBody(body));
  for (const m of body.matchAll(/\/threads\/([^/\s"']+?)\.md/g)) add(m[1]);
  return ids;
}

/** `at` and `summary` of the last `mail_handoff:` block of a full body. */
function latestHandoffInTaskBody(body: string): CompactMailTrack["latest_handoff"] {
  const idx = body.lastIndexOf("mail_handoff:");
  if (idx < 0) return undefined;
  const block = body.slice(idx).split("\n").slice(1);
  let at: string | undefined;
  let summary = "";
  for (const line of block) {
    if (!/^\s/.test(line)) break;
    const m = /^\s+(at|summary):\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = (m[2] ?? "").trim();
    if (m[1] === "at") at = value;
    else {
      const raw = value;
      try {
        summary = raw.startsWith('"') ? String(JSON.parse(raw)) : raw;
      } catch {
        summary = raw;
      }
    }
  }
  if (summary.length > LATEST_HANDOFF_SUMMARY_MAX) {
    summary = `${summary.slice(0, LATEST_HANDOFF_SUMMARY_MAX - 1)}…`;
  }
  return { ...(at ? { at } : {}), summary };
}

/** Compact track list entry (spec mail-tracks, "Compact track list"). */
export function compactMailTrack(
  task: MailTrackTaskSummary & { completed_at?: number | string },
): CompactMailTrack {
  const body = task.body ?? "";
  const latest = latestHandoffInTaskBody(body);
  return {
    task_id: task.task_id,
    title: task.title,
    status: task.status,
    thread_ids: threadIdsInTaskBody(body),
    ...(latest ? { latest_handoff: latest } : {}),
    // A reopened track keeps its old completion time; report it only for a done track.
    ...(task.status === "done" && task.completed_at !== undefined
      ? { completed_at: task.completed_at }
      : {}),
  };
}

async function listTracksByStatus(
  bridge: KanbanBridgeCall,
  board: string,
  folderSlug: string,
  status: string,
  limit: number,
): Promise<Array<MailTrackTaskSummary & { completed_at?: number | string }>> {
  const result = await bridge({ action: "list", board, status, limit, include_body: true });
  if (!result.success || !result.tasks) return [];
  const out: Array<MailTrackTaskSummary & { completed_at?: number | string }> = [];
  for (const t of result.tasks) {
    const id = t.task_id?.trim();
    if (!id) continue;
    const body = t.body ?? "";
    if (body.includes("kind: mail_ingress")) continue;
    out.push({
      task_id: id,
      title: t.title,
      status: t.status,
      body,
      board,
      project_slug: folderSlug,
      ...(t.completed_at !== undefined ? { completed_at: t.completed_at } : {}),
    });
  }
  return out;
}

/**
 * Track list of a project board (openspec/specs/mail-tracks).
 * - taskId: that one track with its full body, for each status.
 * - threadId: the thread match with its full body, or no track and the done match.
 * - neither: the compact track list of every open track.
 */
export async function listMailTrackTasks(
  opts: {
    filesRoot: string;
    projectSlug: string;
    limit?: number;
    threadId?: string;
    taskId?: string;
  },
  bridge: KanbanBridgeCall = callKanbanBridge,
): Promise<MailTrackList> {
  const folderSlug = normalizeProjectSlug(opts.projectSlug);
  const board = projectBoardSlug(folderSlug);
  await ensureProjectBoard(opts.filesRoot, folderSlug, undefined, bridge);

  const taskId = opts.taskId?.trim();
  if (taskId) {
    const shown = await bridge({ action: "show", board, task_id: taskId });
    const t = shown.success ? shown.task : undefined;
    if (!t?.task_id || (t.body ?? "").includes("kind: mail_ingress")) return { tasks: [] };
    return {
      tasks: [
        {
          task_id: t.task_id,
          title: t.title,
          status: t.status,
          body: t.body ?? "",
          board,
          project_slug: folderSlug,
        },
      ],
    };
  }

  const byId = new Map<string, MailTrackTaskSummary>();
  for (const status of OPEN_TRACK_STATUSES) {
    const limit = opts.limit ?? OPEN_TRACK_LIST_LIMIT;
    for (const t of await listTracksByStatus(bridge, board, folderSlug, status, limit)) {
      byId.set(t.task_id, t);
    }
  }
  const tasks = [...byId.values()];
  const filterThread = opts.threadId?.trim();
  if (!filterThread) return { tasks: tasks.map(compactMailTrack) };

  const matched = findOpenMailTrackByThread(tasks, filterThread);
  if (matched) return { tasks: [matched] };

  const done = await listTracksByStatus(bridge, board, folderSlug, "done", DONE_TRACK_LIST_LIMIT);
  const doneMatch = done
    .filter((t) => findOpenMailTrackByThread([t], filterThread))
    .sort((a, b) => Number(b.completed_at ?? 0) - Number(a.completed_at ?? 0))[0];
  return { tasks: [], ...(doneMatch ? { done_match: compactMailTrack(doneMatch) } : {}) };
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
    ...eaKanbanCreateDefaults(board),
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
  /** True when the handoff unblocked a blocked track so that its worker reads the email. */
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

/**
 * Handoff: add a new email to an existing track (openspec/specs/mail-tracks).
 * For a blocked track, the handoff unblocks the track. For a done track, the
 * handoff reopens the track. In both cases the worker of the track reads the
 * email and decides the next status. The handoff does not judge
 * the email and does not complete the track.
 */
export async function handoffMailToTrackTask(
  opts: {
    filesRoot: string;
    projectSlug: string;
    taskId: string;
    sourcePath: string;
    messageId: string;
    from?: string;
    summary: string;
  },
  bridge: KanbanBridgeCall = callKanbanBridge,
): Promise<HandoffMailTrackResult> {
  const taskId = opts.taskId.trim();
  const folderSlug = normalizeProjectSlug(opts.projectSlug);
  const board = projectBoardSlug(folderSlug);
  const sourcePath = opts.sourcePath.trim();
  const messageId = opts.messageId.trim();
  const summary = opts.summary.trim();
  if (!taskId || !sourcePath || !messageId || !summary) {
    return { ok: false, error: "taskId, sourcePath, messageId, summary required" };
  }

  const before = await bridge({ action: "show", board, task_id: taskId });
  if (!before.success || !before.task) {
    return { ok: false, error: before.error ?? "task_not_found" };
  }
  const wasBlocked = before.task.status === "blocked";
  const wasDone = before.task.status === "done";

  const append = buildMailHandoffAppend({
    existingBody: before.task.body ?? "",
    sourcePath,
    messageId,
    from: opts.from,
    summary,
  });
  const appended = await bridge({
    action: "append_body",
    board,
    task_id: taskId,
    append,
  });
  if (!appended.success) {
    return { ok: false, error: appended.error ?? "append_body_failed" };
  }

  await bridge({
    action: "comment",
    board,
    task_id: taskId,
    body: ["## Mail ingress handoff", "", summary, "", `source_path: ${sourcePath}`].join("\n"),
    author: "mail-ingress",
  });

  if (wasDone) {
    // A done track reopens, so that the worker of the track reads the email (spec mail-tracks).
    const reopened = await bridge({ action: "reopen", board, task_id: taskId });
    console.info(
      `[ea-mail] handoff reopened done track task=${taskId} message=${messageId} ok=${reopened.success === true}`,
    );
    return reopened.success
      ? { ok: true, evaluation_queued: true }
      : {
          ok: true,
          evaluation_queued: false,
          error: `handoff_ok_reopen_failed:${reopened.error ?? "unknown"}`,
        };
  }

  if (!wasBlocked) {
    return { ok: true, evaluation_queued: false };
  }

  // Wake the worker also when the companion is not agent authorized for the email.
  // Agent authorized limits only the outgoing emails of the worker.
  const wake = await queueMailTrackTaskHandler(
    { filesRoot: opts.filesRoot, projectSlug: folderSlug, taskId },
    bridge,
  );
  console.info(
    `[ea-mail] handoff woke worker task=${taskId} message=${messageId} queued=${wake.queued}`,
  );
  return {
    ok: true,
    evaluation_queued: wake.queued,
    ...(wake.queued ? {} : { error: `handoff_ok_evaluation_failed:${wake.reason}` }),
  };
}

export async function queueMailTrackTaskHandler(
  opts: {
    filesRoot: string;
    projectSlug: string;
    taskId: string;
  },
  bridge: KanbanBridgeCall = callKanbanBridge,
): Promise<QueueMailTrackTaskResult> {
  const board = projectBoardSlug(normalizeProjectSlug(opts.projectSlug));
  const result = await bridge({
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
