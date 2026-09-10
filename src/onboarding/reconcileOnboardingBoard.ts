/**
 * Reconcile factory onboarding prompts → ea-onboarding Kanban cards.
 * Idempotent: find_by_idempotency, auto-complete when predicates pass, upsert blocked cards.
 */
import {
  callKanbanBridge,
  EA_ONBOARDING_KANBAN_BOARD,
  eaKanbanCreateDefaults,
  eaSchedulingKanbanAssignee,
} from "../hermesKanbanBridge.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { bootstrapEaOnboardingKanban } from "./eaOnboardingKanbanBootstrap.js";
import { evaluateOnboardingPredicate } from "./promptPredicates.js";
import { listActiveOnboardingPrompts, type OnboardingPromptDefinition } from "./promptRegistry.js";
import { readOnboardingPromptState, shouldSuppressPrompt } from "./promptState.js";

export const EA_ONBOARDING_SKILL = "ea-onboarding";

export type OnboardingReconcileSummary = {
  ok: boolean;
  error?: string;
  created: number;
  completed: number;
  skipped: number;
  open: number;
  prompts: Array<{
    id: string;
    status: "completed" | "open" | "skipped";
    taskId?: string;
  }>;
};

function buildOnboardingTaskBody(prompt: OnboardingPromptDefinition): string {
  return [
    "kind: onboarding",
    `prompt_id: ${prompt.id}`,
    `deep_link: ${prompt.deepLink}`,
    `required: ${prompt.required}`,
    "",
    "Setup item from the Joshu onboarding registry. Complete the step in the desktop app;",
    "reconcile auto-closes this card when the box detects completion.",
  ].join("\n");
}

async function findTaskByIdempotency(
  idempotencyKey: string,
): Promise<{ taskId: string; status?: string } | null> {
  const result = await callKanbanBridge({
    action: "find_by_idempotency",
    board: EA_ONBOARDING_KANBAN_BOARD,
    idempotency_key: idempotencyKey,
  });
  if (!result.success || !result.found || !result.task?.task_id) return null;
  return { taskId: result.task.task_id, status: result.task.status };
}

async function completeOnboardingTask(taskId: string, promptId: string): Promise<boolean> {
  const result = await callKanbanBridge({
    action: "complete",
    board: EA_ONBOARDING_KANBAN_BOARD,
    task_id: taskId,
    comment: `Auto-completed by onboarding reconcile — predicate satisfied for ${promptId}.`,
    author: "joshu",
  });
  return result.success === true;
}

async function upsertBlockedOnboardingTask(
  prompt: OnboardingPromptDefinition,
  filesRoot: string,
): Promise<{ created: boolean; taskId?: string }> {
  const existing = await findTaskByIdempotency(prompt.idempotencyKey);
  if (existing) {
    if (existing.status === "done") {
      return { created: false, taskId: existing.taskId };
    }
    if (existing.status === "blocked") {
      return { created: false, taskId: existing.taskId };
    }
    if (existing.status && ["ready", "running", "todo", "scheduled", "triage"].includes(existing.status)) {
      const block = await callKanbanBridge({
        action: "block",
        board: EA_ONBOARDING_KANBAN_BOARD,
        task_id: existing.taskId,
        reason: "awaiting owner",
      });
      return { created: false, taskId: block.task_id ?? existing.taskId };
    }
  }

  const create = await callKanbanBridge({
    action: "create",
    board: EA_ONBOARDING_KANBAN_BOARD,
    ...eaKanbanCreateDefaults(EA_ONBOARDING_KANBAN_BOARD),
    title: prompt.title,
    body: buildOnboardingTaskBody(prompt),
    assignee: eaSchedulingKanbanAssignee(),
    idempotency_key: prompt.idempotencyKey,
    skills: [EA_ONBOARDING_SKILL],
    workspace_kind: "dir",
    workspace_path: filesRoot,
  });
  if (!create.success || !create.task_id) {
    throw new Error(create.error ?? "kanban create failed");
  }

  const block = await callKanbanBridge({
    action: "block",
    board: EA_ONBOARDING_KANBAN_BOARD,
    task_id: create.task_id,
    reason: "awaiting owner",
  });
  if (!block.success) {
    throw new Error(block.error ?? "kanban block failed");
  }
  return { created: true, taskId: create.task_id };
}

/** Reconcile all active registry prompts to ea-onboarding. */
export async function reconcileOnboardingBoard(
  projectRoot = process.cwd(),
): Promise<OnboardingReconcileSummary> {
  const paths = resolveJoshuFilesPaths(projectRoot);
  if (!paths?.filesRoot) {
    return {
      ok: false,
      error: "files_root_unavailable",
      created: 0,
      completed: 0,
      skipped: 0,
      open: 0,
      prompts: [],
    };
  }

  const bootstrap = await bootstrapEaOnboardingKanban(projectRoot);
  if (!bootstrap.ok) {
    return {
      ok: false,
      error: bootstrap.error,
      created: 0,
      completed: 0,
      skipped: 0,
      open: 0,
      prompts: [],
    };
  }

  const promptState = readOnboardingPromptState(projectRoot);
  const prompts = await listActiveOnboardingPrompts(projectRoot);
  let created = 0;
  let completed = 0;
  let skipped = 0;
  let open = 0;
  const details: OnboardingReconcileSummary["prompts"] = [];

  for (const prompt of prompts) {
    if (shouldSuppressPrompt(promptState, prompt.id)) {
      skipped += 1;
      details.push({ id: prompt.id, status: "skipped" });
      continue;
    }

    const isComplete = await evaluateOnboardingPredicate(prompt.completeWhen, projectRoot);
    const existing = await findTaskByIdempotency(prompt.idempotencyKey);

    if (isComplete) {
      if (existing && existing.status !== "done") {
        await completeOnboardingTask(existing.taskId, prompt.id);
        completed += 1;
        details.push({ id: prompt.id, status: "completed", taskId: existing.taskId });
      } else {
        skipped += 1;
        details.push({ id: prompt.id, status: "skipped", taskId: existing?.taskId });
      }
      continue;
    }

    if (!prompt.nudgeEligible) {
      skipped += 1;
      details.push({ id: prompt.id, status: "skipped" });
      continue;
    }

    try {
      const upsert = await upsertBlockedOnboardingTask(prompt, paths.filesRoot);
      if (upsert.created) created += 1;
      open += 1;
      details.push({ id: prompt.id, status: "open", taskId: upsert.taskId });
    } catch (err) {
      console.warn(`[onboarding] reconcile prompt ${prompt.id}: ${(err as Error).message}`);
      skipped += 1;
      details.push({ id: prompt.id, status: "skipped" });
    }
  }

  console.info(
    `[onboarding] reconcile created=${created} completed=${completed} open=${open} skipped=${skipped}`,
  );

  return { ok: true, created, completed, skipped, open, prompts: details };
}

/** Setup status for API — open required prompts with predicate snapshot. */
export async function getOnboardingSetupStatus(projectRoot = process.cwd()): Promise<{
  openRequired: number;
  prompts: Array<{
    id: string;
    title: string;
    required: boolean;
    complete: boolean;
    suppressed: boolean;
  }>;
}> {
  const promptState = readOnboardingPromptState(projectRoot);
  const prompts = await listActiveOnboardingPrompts(projectRoot);
  let openRequired = 0;
  const rows = [];
  for (const p of prompts) {
    const complete = await evaluateOnboardingPredicate(p.completeWhen, projectRoot);
    const suppressed = shouldSuppressPrompt(promptState, p.id);
    if (p.required && !complete && !suppressed) openRequired += 1;
    rows.push({
      id: p.id,
      title: p.title,
      required: p.required,
      complete,
      suppressed,
    });
  }
  return { openRequired, prompts: rows };
}
