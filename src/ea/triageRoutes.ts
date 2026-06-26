import type { Request, Response, Router } from "express";
import { callKanbanBridge } from "../hermesKanbanBridge.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import {
  commentSchedulingMeetingTask,
  handoffIngressReplyToMeeting,
  listSchedulingMeetingTasks,
  queueMeetingTaskHandler,
  queueSchedulingMeetingTask,
} from "./schedulingCron.js";
import {
  handoffMailToTrackTask,
  listMailTrackTasks,
  queueMailTrackTask,
} from "./mailCron.js";
import {
  countPendingIngressEvents,
  markSchedulingIngressProcessed,
  readSchedulingIngressEvents,
  schedulingIngressPath,
} from "./schedulingIngress.js";
import { findSchedulingCaseById, isCaseTerminal, readSchedulingCase } from "./schedulingCase.js";
import { readMeetingSidecar, writeMeetingSidecar } from "./schedulingMeetingSidecar.js";
import {
  archiveStubsForSchedulingCase,
  reconcileLegacySchedulingStubs,
} from "./triageSchedulingBridge.js";
import { archiveTriageStub } from "./triageStub.js";
import { resolveSchedulingMailAuthorization } from "./agentAuthorization.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => readString(v)).filter(Boolean);
}

function filesRootFromProject(projectRoot: string): string | null {
  return resolveJoshuFilesPaths(projectRoot)?.filesRoot ?? null;
}

/** Folder slug under Projects/ (no project- prefix). */
function projectFolderSlug(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^project-/, "");
  return s.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Hermes board slug: project-<folder-slug>. */
function projectBoardSlug(raw: string): string {
  const folder = projectFolderSlug(raw);
  return folder ? `project-${folder}` : "project-";
}

/** EA triage + Kanban-only scheduling ingress routes. */
export function registerEaTriageRoutes(router: Router, opts: { projectRoot: string }): void {
  router.get("/api/ea/scheduling/ingress", async (_req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    try {
      const events = await readSchedulingIngressEvents(filesRoot);
      const pending = events.filter((e) => e.status === "pending");
      res.json({
        ok: true,
        path: schedulingIngressPath(filesRoot),
        pending_count: pending.length,
        events: pending,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/ea/scheduling/ingress/mark-processed", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = readStringArray(body.ids ?? body.eventIds ?? body.event_ids);
    const meetingTaskId =
      readString(body.meetingTaskId) ||
      readString(body.meeting_task_id) ||
      readString(body.taskId) ||
      readString(body.task_id) ||
      null;

    if (ids.length === 0) {
      res.status(400).json({ error: "ids required (array of ingress event ids)" });
      return;
    }

    try {
      const marked = await markSchedulingIngressProcessed(filesRoot, ids, meetingTaskId);
      const pending = await countPendingIngressEvents(filesRoot);
      res.json({ ok: true, marked, pending_count: pending });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Open meeting tasks on board ea-scheduling (Joshu kanban bridge). */
  router.get("/api/ea/scheduling/meetings", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const threadId =
      readString(req.query.threadId) || readString(req.query.thread_id) || undefined;
    try {
      const tasks = await listSchedulingMeetingTasks({ filesRoot, threadId });
      res.json({ ok: true, board: "ea-scheduling", count: tasks.length, tasks });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Create meeting task on ea-scheduling (ingress worker — do not use Hermes kanban_create). */
  router.post("/api/ea/scheduling/meetings", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const messageId = readString(body.messageId) || readString(body.message_id);
    const sourcePath = readString(body.sourcePath) || readString(body.source_path);
    if (!messageId) {
      res.status(400).json({ error: "messageId required" });
      return;
    }
    if (!sourcePath) {
      res.status(400).json({ error: "sourcePath required" });
      return;
    }

    const auth = await resolveSchedulingMailAuthorization({
      filesRoot,
      projectRoot: opts.projectRoot,
      messageId,
      sourcePath,
    });
    if (!auth?.scheduling_eligible) {
      res.status(403).json({
        error: "scheduling_not_eligible",
        reason: auth?.reason ?? "not_copied_or_delegated",
        agent_authorized: auth?.agent_authorized ?? false,
      });
      return;
    }

    try {
      const result = await queueSchedulingMeetingTask({
        filesRoot,
        messageId,
        sourcePath,
        subject: readString(body.subject) || undefined,
        from: readString(body.from) || undefined,
        timezone: readString(body.timezone) || null,
        title: readString(body.title) || undefined,
        body: readString(body.body) || readString(body.taskBody) || undefined,
        threadId: readString(body.threadId) || readString(body.thread_id) || undefined,
        provider: readString(body.provider) || undefined,
      });
      if (!result.taskId) {
        res.status(502).json({ ok: false, error: result.reason });
        return;
      }
      res.json({
        ok: true,
        board: "ea-scheduling",
        task_id: result.taskId,
        action: result.reason,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/ea/scheduling/meetings/:taskId/comment", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const taskId = readString(req.params.taskId);
    const commentBody = readString((req.body as Record<string, unknown>)?.body);
    if (!taskId || !commentBody) {
      res.status(400).json({ error: "taskId and body required" });
      return;
    }
    try {
      const result = await commentSchedulingMeetingTask({
        filesRoot,
        taskId,
        body: commentBody,
      });
      if (!result.ok) {
        res.status(502).json({ ok: false, error: result.error });
        return;
      }
      res.json({ ok: true, task_id: taskId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Ingress match: deliver new mail to meeting task; queue evaluation if blocked. */
  router.post("/api/ea/scheduling/meetings/:taskId/handoff", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const taskId = readString(req.params.taskId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sourcePath = readString(body.sourcePath) || readString(body.source_path);
    const messageId = readString(body.messageId) || readString(body.message_id);
    const summary = readString(body.summary);
    if (!taskId || !sourcePath || !messageId || !summary) {
      res.status(400).json({ error: "taskId, sourcePath, messageId, summary required" });
      return;
    }
    try {
      const result = await handoffIngressReplyToMeeting({
        filesRoot,
        taskId,
        sourcePath,
        messageId,
        from: readString(body.from) || undefined,
        summary,
      });
      if (!result.ok) {
        res.status(502).json({ ok: false, error: result.error });
        return;
      }
      res.json({
        ok: true,
        task_id: taskId,
        evaluation_queued: result.evaluation_queued === true,
        ...(result.error ? { warning: result.error } : {}),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Manual unblock (ops/debug). */
  router.post("/api/ea/scheduling/meetings/:taskId/unblock", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const taskId = readString(req.params.taskId);
    if (!taskId) {
      res.status(400).json({ error: "taskId required" });
      return;
    }
    try {
      const result = await queueMeetingTaskHandler({
        filesRoot,
        taskId,
        projectRoot: opts.projectRoot,
      });
      if (!result.queued) {
        res.status(502).json({ ok: false, error: result.reason });
        return;
      }
      res.json({
        ok: true,
        board: "ea-scheduling",
        task_id: result.taskId ?? taskId,
        action: result.reason,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/api/ea/scheduling/meetings/:taskId", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const taskId = readString(req.params.taskId);
    if (!taskId) {
      res.status(400).json({ error: "taskId required" });
      return;
    }
    try {
      const sidecar = await readMeetingSidecar(filesRoot, taskId);
      res.json({ ok: true, task_id: taskId, sidecar });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/ea/scheduling/meetings/:taskId", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const taskId = readString(req.params.taskId);
    if (!taskId) {
      res.status(400).json({ error: "taskId required" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const sidecar = await writeMeetingSidecar(filesRoot, taskId, {
        ...(body.calendar_event_id !== undefined
          ? { calendar_event_id: readString(body.calendar_event_id) || null }
          : {}),
        ...(body.timezone !== undefined
          ? { timezone: readString(body.timezone) || null }
          : {}),
        ...(body.source_paths !== undefined
          ? { source_paths: readStringArray(body.source_paths) }
          : {}),
        ...(body.participants !== undefined
          ? { participants: readStringArray(body.participants) }
          : {}),
      });
      res.json({ ok: true, sidecar });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** @deprecated Legacy MD scheduling cases — archive linked triage stubs when terminal. */
  router.post("/api/ea/triage/archive-stubs", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const caseId = readString(body.caseId) || readString(body.case_id);
    const caseRelativePath = readString(body.caseRelativePath) || readString(body.case_relative_path);
    const stubRelativePath = readString(body.stubRelativePath) || readString(body.stub_relative_path);

    try {
      if (stubRelativePath) {
        const archived = await archiveTriageStub(filesRoot, stubRelativePath);
        res.json({ ok: true, archived: archived ? [stubRelativePath] : [] });
        return;
      }

      let record = caseId ? await findSchedulingCaseById(filesRoot, caseId) : null;
      if (!record && caseRelativePath) {
        record = await readSchedulingCase(filesRoot, caseRelativePath);
      }
      if (!record) {
        res.status(404).json({ error: "legacy scheduling case not found" });
        return;
      }
      if (!isCaseTerminal(record.frontmatter.state)) {
        res.status(409).json({
          error: "case not terminal — archive stubs only after confirmed or cancelled",
          state: record.frontmatter.state,
        });
        return;
      }

      const archived = await archiveStubsForSchedulingCase(filesRoot, record);
      res.json({ ok: true, case_id: record.frontmatter.case_id, archived });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/ea/triage/reconcile-stubs", async (_req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    try {
      const archived = await reconcileLegacySchedulingStubs(filesRoot);
      res.json({ ok: true, archived_count: archived });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Ensure project-<slug> board exists (Joshu kanban bridge — use from chat, not Hermes CLI). */
  router.post("/api/ea/project-kanban/boards", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectSlug =
      readString(body.projectSlug) ||
      readString(body.project_slug) ||
      readString(body.slug);
    if (!projectSlug) {
      res.status(400).json({ error: "projectSlug required" });
      return;
    }

    const folderSlug = projectFolderSlug(projectSlug);
    const boardSlug = projectBoardSlug(projectSlug);
    const projectDir = `${filesRoot}/Projects/${folderSlug}`;

    try {
      const result = await callKanbanBridge({
        action: "ensure_board",
        slug: boardSlug,
        name: readString(body.name) || folderSlug,
        description: readString(body.description) || "Joshu ad-hoc project",
        default_workdir: projectDir,
      });
      if (!result.success) {
        res.status(502).json({ ok: false, error: result.error ?? "ensure_board_failed" });
        return;
      }
      res.json({
        ok: true,
        board: boardSlug,
        project_slug: folderSlug,
        project_dir: projectDir,
        meta: result.board,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Create triage root card on project-<slug> for auto-decompose (ea-project-kanban kickoff). */
  router.post("/api/ea/project-kanban/triage-root", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectSlug =
      readString(body.projectSlug) ||
      readString(body.project_slug) ||
      readString(body.slug);
    const title = readString(body.title);
    const taskBody = readString(body.body);
    if (!projectSlug) {
      res.status(400).json({ error: "projectSlug required" });
      return;
    }
    if (!title) {
      res.status(400).json({ error: "title required" });
      return;
    }
    if (!taskBody) {
      res.status(400).json({ error: "body required" });
      return;
    }

    const folderSlug = projectFolderSlug(projectSlug);
    const boardSlug = projectBoardSlug(projectSlug);
    const projectDir = `${filesRoot}/Projects/${folderSlug}`;

    try {
      await callKanbanBridge({
        action: "ensure_board",
        slug: boardSlug,
        name: readString(body.name) || folderSlug,
        description: readString(body.description) || "Joshu ad-hoc project",
        default_workdir: projectDir,
      });

      const result = await callKanbanBridge({
        action: "create",
        board: boardSlug,
        title,
        body: taskBody,
        triage: true,
        workspace_kind: "dir",
        workspace_path: projectDir,
      });
      if (!result.success || !result.task_id) {
        res.status(502).json({ ok: false, error: result.error ?? "triage_create_failed" });
        return;
      }
      res.json({
        ok: true,
        board: boardSlug,
        project_slug: folderSlug,
        task_id: result.task_id,
        action: result.action_taken ?? "created",
        task: result.task,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Open mail track tasks on project-<slug> board. */
  router.get("/api/ea/mail/tracks", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const projectSlug =
      readString(req.query.projectSlug) ||
      readString(req.query.project_slug) ||
      readString(req.query.slug) ||
      "other";
    try {
      const tasks = await listMailTrackTasks({ filesRoot, projectSlug });
      res.json({
        ok: true,
        board: projectBoardSlug(projectSlug),
        project_slug: projectFolderSlug(projectSlug),
        count: tasks.length,
        tasks,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Create mail track task on project-<slug> (mail ingress worker). */
  router.post("/api/ea/mail/tracks", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messageId = readString(body.messageId) || readString(body.message_id);
    const sourcePath = readString(body.sourcePath) || readString(body.source_path);
    const projectSlug =
      readString(body.projectSlug) ||
      readString(body.project_slug) ||
      readString(body.slug) ||
      "other";
    const provider = (readString(body.provider) || "nylas") as "gmail" | "nylas";
    const threadId = readString(body.threadId) || readString(body.thread_id);
    if (!messageId || !sourcePath || !threadId) {
      res.status(400).json({ error: "messageId, sourcePath, threadId, projectSlug required" });
      return;
    }
    try {
      const result = await queueMailTrackTask({
        filesRoot,
        messageId,
        sourcePath,
        subject: readString(body.subject) || undefined,
        from: readString(body.from) || undefined,
        provider,
        threadId,
        projectSlug,
        category: readString(body.category) || undefined,
        isNewTrack: body.isNewTrack === true || body.is_new_track === true,
        title: readString(body.title) || undefined,
      });
      if (!result.taskId) {
        res.status(502).json({ ok: false, reason: result.reason });
        return;
      }
      res.json({
        ok: true,
        board: result.board,
        project_slug: result.project_slug,
        task_id: result.taskId,
        action: result.reason,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Mail ingress handoff: append new mail to existing track task. */
  router.post("/api/ea/mail/tracks/:taskId/handoff", async (req: Request, res: Response) => {
    const filesRoot = filesRootFromProject(opts.projectRoot);
    if (!filesRoot) {
      res.status(503).json({ error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const taskId = readString(req.params.taskId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sourcePath = readString(body.sourcePath) || readString(body.source_path);
    const messageId = readString(body.messageId) || readString(body.message_id);
    const summary = readString(body.summary);
    const projectSlug =
      readString(body.projectSlug) ||
      readString(body.project_slug) ||
      readString(body.slug) ||
      "other";
    if (!taskId || !sourcePath || !messageId || !summary) {
      res.status(400).json({ error: "taskId, sourcePath, messageId, summary required" });
      return;
    }
    try {
      const result = await handoffMailToTrackTask({
        filesRoot,
        projectSlug,
        taskId,
        sourcePath,
        messageId,
        from: readString(body.from) || undefined,
        summary,
      });
      if (!result.ok) {
        res.status(502).json({ ok: false, error: result.error });
        return;
      }
      res.json({
        ok: true,
        task_id: taskId,
        evaluation_queued: result.evaluation_queued === true,
        ...(result.error ? { warning: result.error } : {}),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
