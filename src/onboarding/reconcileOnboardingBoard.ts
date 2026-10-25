/**
 * Reconcile factory onboarding prompts → ea-onboarding Kanban cards.
 * Idempotent: find_by_idempotency, auto-complete when predicates pass, upsert blocked cards.
 */
import { createHash } from "node:crypto";

import {
  callKanbanBridge,
  EA_ONBOARDING_KANBAN_BOARD,
  eaKanbanCreateDefaults,
  eaSchedulingKanbanAssignee,
  OWNER_QUESTION_BLOCK_KIND,
  type KanbanBridgeCall,
} from "../hermesKanbanBridge.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { bootstrapEaOnboardingKanban } from "./eaOnboardingKanbanBootstrap.js";
import { evaluateOnboardingPredicate } from "./promptPredicates.js";
import { listActiveOnboardingPrompts, type OnboardingPromptDefinition } from "./promptRegistry.js";
import {
  readOnboardingPromptState,
  shouldSuppressPrompt,
  type OnboardingPromptState,
} from "./promptState.js";

export const EA_ONBOARDING_SKILL = "ea-onboarding";

/** Block reason of a required setup card. The card is an owner question (block kind `needs_input`). */
const ONBOARDING_BLOCK_REASON = "awaiting owner";

/** Block reason of a setup tip card. The card has no block kind, so it is not an owner question. */
const SETUP_TIP_BLOCK_REASON = "optional setup tip";

export type OnboardingReconcilePromptStatus =
  | "completed"
  | "open"
  | "skipped"
  | "complete_failed";

export type OnboardingReconcilePromptResult = {
  id: string;
  status: OnboardingReconcilePromptStatus;
  taskId?: string;
  created?: boolean;
  error?: string;
};

export type OnboardingReconcileSummary = {
  ok: boolean;
  error?: string;
  created: number;
  completed: number;
  /** Predicate satisfied but Kanban complete did not stick (bridge/DB failure). */
  completeFailed: number;
  skipped: number;
  open: number;
  prompts: Array<Omit<OnboardingReconcilePromptResult, "created">>;
};

/** Short hash of the how-to text. A changed hash makes the reconcile replace the body of an open card. */
function howtoVersion(prompt: OnboardingPromptDefinition): string {
  const text = JSON.stringify([prompt.title, prompt.why, prompt.steps, prompt.mistakes]);
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function buildOnboardingTaskBody(prompt: OnboardingPromptDefinition): string {
  const lines = [
    "kind: onboarding",
    `prompt_id: ${prompt.id}`,
    `type: ${prompt.type}`,
    `deep_link: ${prompt.deepLink}`,
    `required: ${prompt.required}`,
    "",
    "## Why",
    prompt.why,
    "",
    "## Steps",
    ...prompt.steps.map((step, index) => `${index + 1}. ${step}`),
  ];
  if (prompt.mistakes.length > 0) {
    lines.push("", "## Common mistakes", ...prompt.mistakes.map((mistake) => `- ${mistake}`));
  }
  lines.push(
    "",
    prompt.type === "tip"
      ? "This card is an optional tip. Joshu closes it when it sees the step done, or you can move it to done."
      : "Joshu closes this card when it sees the step done.",
    `howto_version: ${howtoVersion(prompt)}`,
  );
  return lines.join("\n");
}

function blockArgs(prompt: OnboardingPromptDefinition): { reason: string; kind?: string } {
  return prompt.type === "tip"
    ? { reason: SETUP_TIP_BLOCK_REASON }
    : { reason: ONBOARDING_BLOCK_REASON, kind: OWNER_QUESTION_BLOCK_KIND };
}

type ExistingOnboardingTask = {
  taskId: string;
  status?: string;
  blockKind?: string | null;
  body?: string | null;
};

async function findTaskByIdempotency(
  idempotencyKey: string,
  bridge: KanbanBridgeCall = callKanbanBridge,
): Promise<ExistingOnboardingTask | null> {
  const result = await bridge({
    action: "find_by_idempotency",
    board: EA_ONBOARDING_KANBAN_BOARD,
    idempotency_key: idempotencyKey,
    include_body: true,
  });
  if (!result.success || !result.found || !result.task?.task_id) return null;
  return {
    taskId: result.task.task_id,
    status: result.task.status,
    blockKind: result.task.block_kind ?? null,
    body: result.task.body ?? null,
  };
}

type CompleteOnboardingTaskResult = { ok: true } | { ok: false; error: string };

async function completeOnboardingTask(
  taskId: string,
  promptId: string,
  bridge: KanbanBridgeCall = callKanbanBridge,
): Promise<CompleteOnboardingTaskResult> {
  try {
    const result = await bridge({
      action: "complete",
      board: EA_ONBOARDING_KANBAN_BOARD,
      task_id: taskId,
      comment: `Auto-completed by onboarding reconcile — predicate satisfied for ${promptId}.`,
      author: "joshu",
    });
    if (result.success === true) return { ok: true };
    return {
      ok: false,
      error: result.error?.trim() || "kanban complete returned success=false",
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "kanban complete threw" };
  }
}

/** Replace the body of an open card when the how-to of its setup step changed. */
async function refreshOnboardingTaskBody(
  prompt: OnboardingPromptDefinition,
  existing: ExistingOnboardingTask,
  bridge: KanbanBridgeCall,
): Promise<void> {
  const body = buildOnboardingTaskBody(prompt);
  if ((existing.body ?? "").trim() === body.trim()) return;
  await bridge({
    action: "set_body",
    board: EA_ONBOARDING_KANBAN_BOARD,
    task_id: existing.taskId,
    body,
  });
}

export async function upsertBlockedOnboardingTask(
  prompt: OnboardingPromptDefinition,
  filesRoot: string,
  bridge: KanbanBridgeCall = callKanbanBridge,
  /** The card that the caller already found (null: no card). Undefined: look it up. */
  known?: ExistingOnboardingTask | null,
): Promise<{ created: boolean; taskId?: string }> {
  const block = blockArgs(prompt);
  const existing = known === undefined ? await findTaskByIdempotency(prompt.idempotencyKey, bridge) : known;
  if (existing) {
    // The reconcile never opens a done card again (the owner may have completed a setup tip).
    if (existing.status === "done") {
      return { created: false, taskId: existing.taskId };
    }
    await refreshOnboardingTaskBody(prompt, existing, bridge);
    if (existing.status === "blocked") {
      // A required card that an earlier version blocked has no block kind. Set it, so the card is an owner question.
      if (prompt.type === "required" && existing.blockKind !== OWNER_QUESTION_BLOCK_KIND) {
        await bridge({
          action: "update_block_reason",
          board: EA_ONBOARDING_KANBAN_BOARD,
          task_id: existing.taskId,
          ...block,
        });
      }
      return { created: false, taskId: existing.taskId };
    }
    if (existing.status && ["ready", "running", "todo", "scheduled", "triage"].includes(existing.status)) {
      const blocked = await bridge({
        action: "block",
        board: EA_ONBOARDING_KANBAN_BOARD,
        task_id: existing.taskId,
        ...block,
      });
      return { created: false, taskId: blocked.task_id ?? existing.taskId };
    }
  }

  const create = await bridge({
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

  const blocked = await bridge({
    action: "block",
    board: EA_ONBOARDING_KANBAN_BOARD,
    task_id: create.task_id,
    ...block,
  });
  if (!blocked.success) {
    throw new Error(blocked.error ?? "kanban block failed");
  }
  return { created: true, taskId: create.task_id };
}

/** Make the card of one setup step match its checks. */
export async function reconcileOnboardingPrompt(
  prompt: OnboardingPromptDefinition,
  ctx: {
    projectRoot: string;
    filesRoot: string;
    promptState: OnboardingPromptState;
    bridge?: KanbanBridgeCall;
  },
): Promise<OnboardingReconcilePromptResult> {
  const bridge = ctx.bridge ?? callKanbanBridge;
  if (shouldSuppressPrompt(ctx.promptState, prompt.id)) {
    return { id: prompt.id, status: "skipped" };
  }

  const isComplete = await evaluateOnboardingPredicate(prompt.completeWhen, ctx.projectRoot);
  const existing = await findTaskByIdempotency(prompt.idempotencyKey, bridge);

  if (isComplete) {
    if (!existing || existing.status === "done") {
      return { id: prompt.id, status: "skipped", taskId: existing?.taskId };
    }
    const closed = await completeOnboardingTask(existing.taskId, prompt.id, bridge);
    if (closed.ok) return { id: prompt.id, status: "completed", taskId: existing.taskId };
    console.warn(
      `[onboarding] reconcile complete failed prompt=${prompt.id} task=${existing.taskId}: ${closed.error}`,
    );
    return { id: prompt.id, status: "complete_failed", taskId: existing.taskId, error: closed.error };
  }

  if (prompt.type === "required" && !prompt.nudgeEligible) {
    return { id: prompt.id, status: "skipped" };
  }
  // The reconcile never opens a done card again (the owner may have completed a setup tip).
  if (existing?.status === "done") {
    return { id: prompt.id, status: "skipped", taskId: existing.taskId };
  }
  // A setup tip appears only while its showWhen check is true. A card that is already open stays open.
  if (prompt.type === "tip" && prompt.showWhen && !existing) {
    const show = await evaluateOnboardingPredicate(prompt.showWhen, ctx.projectRoot);
    if (!show) return { id: prompt.id, status: "skipped" };
  }

  try {
    const upsert = await upsertBlockedOnboardingTask(prompt, ctx.filesRoot, bridge, existing);
    return { id: prompt.id, status: "open", taskId: upsert.taskId, created: upsert.created };
  } catch (err) {
    console.warn(`[onboarding] reconcile prompt ${prompt.id}: ${(err as Error).message}`);
    return { id: prompt.id, status: "skipped" };
  }
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
      completeFailed: 0,
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
      completeFailed: 0,
      skipped: 0,
      open: 0,
      prompts: [],
    };
  }

  const promptState = readOnboardingPromptState(projectRoot);
  const prompts = await listActiveOnboardingPrompts(projectRoot);
  let created = 0;
  const details: OnboardingReconcileSummary["prompts"] = [];

  for (const prompt of prompts) {
    const { created: isNew, ...row } = await reconcileOnboardingPrompt(prompt, {
      projectRoot,
      filesRoot: paths.filesRoot,
      promptState,
    });
    if (isNew) created += 1;
    details.push(row);
  }

  const count = (status: OnboardingReconcilePromptStatus) =>
    details.filter((row) => row.status === status).length;
  const completed = count("completed");
  const completeFailed = count("complete_failed");
  const skipped = count("skipped");
  const open = count("open");

  console.info(
    `[onboarding] reconcile created=${created} completed=${completed} completeFailed=${completeFailed} open=${open} skipped=${skipped}`,
  );

  return {
    ok: completeFailed === 0,
    error: completeFailed > 0 ? "onboarding_complete_failed" : undefined,
    created,
    completed,
    completeFailed,
    skipped,
    open,
    prompts: details,
  };
}

/** Setup status for API — open required prompts with predicate snapshot. */
export async function getOnboardingSetupStatus(projectRoot = process.cwd()): Promise<{
  openRequired: number;
  prompts: Array<{
    id: string;
    title: string;
    type: OnboardingPromptDefinition["type"];
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
      type: p.type,
      required: p.required,
      complete,
      suppressed,
    });
  }
  return { openRequired, prompts: rows };
}
