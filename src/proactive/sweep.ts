import { listBlockedOnBoard } from "./crossBoardKanban.js";
import { listKanbanBoardSlugs } from "./boards.js";
import { blockReasonNeedsOwnerInput } from "./blockReason.js";
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
import { EA_ONBOARDING_KANBAN_BOARD } from "../hermesKanbanBridge.js";
import {
  isOnboardingCandidateSuppressed,
  isOnboardingSetupDebt,
  ONBOARDING_RANK_BOOST,
} from "../onboarding/onboardingProactive.js";
import { isOnboardingKanbanBody } from "../onboarding/promptState.js";

async function toCandidate(
  row: {
    task_id: string;
    title?: string;
    status?: string;
    body?: string;
    block_reason?: string | null;
    created_at_ms?: number | null;
  },
  board: string,
  filesRoot: string,
  projectRoot: string,
): Promise<ProactiveCandidate | null> {
  if (row.status !== "blocked") return null;
  if (!blockReasonNeedsOwnerInput(row.block_reason)) return null;

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
    const rows = await listBlockedOnBoard(board, { limit: 50 });
    for (const row of rows) {
      const c = await toCandidate(row, board, filesRoot, projectRoot);
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
