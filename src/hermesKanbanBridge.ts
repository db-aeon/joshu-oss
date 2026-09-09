import { spawnHermesPython } from "./hermesVoiceRuntime.js";

export type KanbanBridgeAction =
  | "ensure_board"
  | "create"
  | "unblock"
  | "block"
  | "complete"
  | "update_block_reason"
  | "find_by_idempotency"
  | "list"
  | "show"
  | "comment"
  | "append_body";

export type KanbanBridgePayload = Record<string, unknown> & { action: KanbanBridgeAction };

export type KanbanTaskSummary = {
  task_id?: string;
  title?: string;
  status?: string;
  assignee?: string;
  idempotency_key?: string;
  body?: string;
  block_reason?: string | null;
  created_at?: number | string;
  recent_comments?: Array<{
    author?: string;
    body?: string;
    created_at?: string;
  }>;
};

export type KanbanBridgeResult = {
  success?: boolean;
  error?: string;
  task_id?: string;
  action_taken?: string;
  found?: boolean;
  task?: KanbanTaskSummary;
  tasks?: KanbanTaskSummary[];
  board?: Record<string, unknown>;
};

export async function callKanbanBridge(payload: KanbanBridgePayload): Promise<KanbanBridgeResult> {
  const { stdout, stderr, code } = await spawnHermesPython(
    "hermes-kanban-bridge.py",
    [],
    JSON.stringify(payload),
  );
  const text = stdout.trim();
  if (!text) {
    throw new Error(stderr.trim() || `kanban bridge exited with code ${code ?? "?"}`);
  }
  let parsed: KanbanBridgeResult;
  try {
    parsed = JSON.parse(text) as KanbanBridgeResult;
  } catch {
    throw new Error(stderr.trim() || text.slice(0, 500));
  }
  return parsed;
}

export const EA_SCHEDULING_KANBAN_BOARD = "ea-scheduling";

/** Hermes profile that runs Kanban workers (`hermes -p <assignee>`). Must exist on the box. */
export function eaSchedulingKanbanAssignee(): string {
  return process.env.JOSHU_HERMES_KANBAN_ASSIGNEE?.trim() || "default";
}

export const EA_SCHED_INGRESS_KANBAN_BOARD = "ea-sched-ingress";

export const EA_MAIL_INGRESS_KANBAN_BOARD = "ea-mail-ingress";

/** Owner→agent deliverable replies (spawned after mail ingress; ready, not default-blocked). */
export const EA_OWNER_REPLY_KANBAN_BOARD = "ea-owner-reply";

/** Setup-debt prompts (Connectors, mobile, …) — toast-like registry → blocked cards. */
export const EA_ONBOARDING_KANBAN_BOARD = "ea-onboarding";

/** Boards where create must use assignee → ready (no triage / auto-decompose). */
export const EA_KANBAN_BOARDS = [
  EA_SCHEDULING_KANBAN_BOARD,
  EA_SCHED_INGRESS_KANBAN_BOARD,
  EA_MAIL_INGRESS_KANBAN_BOARD,
  EA_OWNER_REPLY_KANBAN_BOARD,
  EA_ONBOARDING_KANBAN_BOARD,
] as const;

export type KanbanCreatePayload = KanbanBridgePayload & {
  action: "create";
  board?: string;
  title: string;
  body?: string;
  assignee?: string;
  idempotency_key?: string;
  skills?: string[] | string;
  workspace_kind?: "dir" | "scratch" | "worktree";
  workspace_path?: string;
  /** Land in triage for auto-decompose (forbidden on EA boards). */
  triage?: boolean;
  /** ISO8601 — dispatcher skips until this time. */
  scheduled_at?: string;
  /** Parent task ids for dependency promotion. */
  parents?: string[];
};

/** Idempotent board setup for EA scheduling workers. */
export async function ensureEaSchedulingBoard(filesRoot: string): Promise<KanbanBridgeResult> {
  return callKanbanBridge({
    action: "ensure_board",
    slug: EA_SCHEDULING_KANBAN_BOARD,
    name: "EA Scheduling",
    description: "Joshu executive assistant — multi-thread scheduling negotiations",
    default_workdir: filesRoot,
  });
}

/** Idempotent board setup for per-email scheduling ingress tasks. */
export async function ensureEaSchedIngressBoard(filesRoot: string): Promise<KanbanBridgeResult> {
  return callKanbanBridge({
    action: "ensure_board",
    slug: EA_SCHED_INGRESS_KANBAN_BOARD,
    name: "EA Scheduling Ingress",
    description: "Joshu executive assistant — one Kanban task per scheduling email (route to ea-scheduling)",
    default_workdir: filesRoot,
  });
}

/** Idempotent board setup for per-email general mail ingress tasks. */
export async function ensureEaMailIngressBoard(filesRoot: string): Promise<KanbanBridgeResult> {
  return callKanbanBridge({
    action: "ensure_board",
    slug: EA_MAIL_INGRESS_KANBAN_BOARD,
    name: "EA Mail Ingress",
    description: "Joshu executive assistant — one Kanban task per trackable email (route to project boards)",
    default_workdir: filesRoot,
  });
}

/** Idempotent board setup for owner→agent reply workers (do-the-ask then nylas_send). */
export async function ensureEaOwnerReplyBoard(filesRoot: string): Promise<KanbanBridgeResult> {
  return callKanbanBridge({
    action: "ensure_board",
    slug: EA_OWNER_REPLY_KANBAN_BOARD,
    name: "EA Owner Reply",
    description: "Joshu executive assistant — owner asked the companion; reply on that Nylas thread",
    default_workdir: filesRoot,
  });
}

/** Idempotent board setup for setup-debt onboarding prompts. */
export async function ensureEaOnboardingBoard(filesRoot: string): Promise<KanbanBridgeResult> {
  return callKanbanBridge({
    action: "ensure_board",
    slug: EA_ONBOARDING_KANBAN_BOARD,
    name: "EA Onboarding",
    description: "Joshu setup checklist — Connectors, owner mobile, and augmentable release prompts",
    default_workdir: filesRoot,
  });
}
