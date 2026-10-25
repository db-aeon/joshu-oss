import { listBlockedOnBoard, type BlockedKanbanRow } from "./crossBoardKanban.js";
import { listKanbanBoardSlugs } from "./boards.js";
import {
  projectSlugFromBoard,
  rankCandidate,
  sortCandidates,
  isProjectActiveForNudge,
  applyRankBoost,
} from "./prioritize.js";
import { isDateStaleForNudge } from "./stale.js";
import type { ProactiveCandidate, ProactiveState } from "./types.js";
import { wasTaskNudgedToday, wasOnboardingNudgedToday } from "./state.js";
import {
  EA_ONBOARDING_KANBAN_BOARD,
  OWNER_QUESTION_BLOCK_KIND,
  REALTIME_GOALS_KANBAN_BOARD,
} from "../hermesKanbanBridge.js";
import {
  isOnboardingCandidateSuppressed,
  isOnboardingSetupDebt,
  ONBOARDING_RANK_BOOST,
} from "../onboarding/onboardingProactive.js";
import { isOnboardingKanbanBody } from "../onboarding/promptState.js";

/**
 * Owner question: a blocked task with block kind `needs_input` (openspec/glossary.md).
 * The text of the block reason does not count.
 */
export function isOwnerQuestion(row: Pick<BlockedKanbanRow, "status" | "block_kind">): boolean {
  return row.status === "blocked" && row.block_kind === OWNER_QUESTION_BLOCK_KIND;
}

/** The realtime-goal broker sends the questions of board `realtime-goals` to the owner itself. */
function isBrokerBoard(board: string): boolean {
  return board === REALTIME_GOALS_KANBAN_BOARD;
}

/** Proactive sweep check for one blocked task. Returns null when the task cannot get a nudge. */
export async function toProactiveCandidate(
  row: Pick<BlockedKanbanRow, "task_id" | "title" | "status" | "body" | "block_reason" | "block_kind" | "created_at_ms">,
  board: string,
  filesRoot: string,
  projectRoot: string,
): Promise<ProactiveCandidate | null> {
  if (isBrokerBoard(board)) return null;
  if (!isOwnerQuestion(row)) return null;

  const taskText = `${row.title ?? ""}\n${row.body ?? ""}`;
  if (!isOnboardingKanbanBody(row.body) && isDateStaleForNudge(taskText)) return null;

  if (isOnboardingCandidateSuppressed(projectRoot, board, row.body)) return null;

  const projectSlug = projectSlugFromBoard(board);
  if (!isProjectActiveForNudge(filesRoot, projectSlug)) return null;

  const createdAt =
    row.created_at_ms != null ? new Date(row.created_at_ms).toISOString() : null;
  let candidate = rankCandidate(
    {
      taskId: row.task_id,
      board,
      title: row.title?.trim() || "(untitled)",
      status: row.status ?? "blocked",
      blockReason: row.block_reason ?? null,
      body: row.body,
      projectSlug,
      createdAt,
    },
    filesRoot,
  );

  if (board === EA_ONBOARDING_KANBAN_BOARD && (await isOnboardingSetupDebt(projectRoot, board))) {
    candidate = applyRankBoost(candidate, -ONBOARDING_RANK_BOOST);
  }

  return candidate;
}

/** Collect blocked owner-input tasks across all Kanban boards on the box. */
export async function sweepProactiveCandidates(opts: {
  filesRoot: string;
  projectRoot: string;
  state: ProactiveState;
  today?: string;
}): Promise<ProactiveCandidate[]> {
  const { filesRoot, projectRoot, state } = opts;
  const today = opts.today;
  const onboardingCapHit =
    today != null && wasOnboardingNudgedToday(state, today);
  const raw: ProactiveCandidate[] = [];

  for (const board of listKanbanBoardSlugs()) {
    if (onboardingCapHit && board === EA_ONBOARDING_KANBAN_BOARD) continue;
    if (isBrokerBoard(board)) continue;
    const rows = await listBlockedOnBoard(board, { limit: 50 });
    for (const row of rows) {
      const c = await toProactiveCandidate(row, board, filesRoot, projectRoot);
      if (c && !wasTaskNudgedToday(state, c.taskId)) raw.push(c);
    }
  }

  return sortCandidates(raw);
}

export async function pickTopProactiveCandidate(opts: {
  filesRoot: string;
  projectRoot: string;
  state: ProactiveState;
  today?: string;
}): Promise<ProactiveCandidate | null> {
  const candidates = await sweepProactiveCandidates(opts);
  return candidates[0] ?? null;
}
