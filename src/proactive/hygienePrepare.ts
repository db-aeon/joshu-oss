import fs from "node:fs";

import { listBlockedCrossBoard, type BlockedKanbanRow } from "./crossBoardKanban.js";
import { projectSlugFromBoard } from "./prioritize.js";
import { ensureProactiveConfigDir, hygienePlanPath } from "./paths.js";
import { isDateStaleForNudge, latestHardDateMs } from "./stale.js";
import type { HygieneCandidate, HygienePlan } from "./types.js";
import { isOnboardingKanbanBody } from "../onboarding/promptState.js";

export const HYGIENE_CANDIDATE_CAP = 20;

/** Sort for daily hygiene: date-stale cards first, then oldest created_at. */
export function sortHygieneCandidates(rows: BlockedKanbanRow[]): BlockedKanbanRow[] {
  return [...rows].sort((a, b) => {
    const aText = `${a.title ?? ""}\n${a.body ?? ""}`;
    const bText = `${b.title ?? ""}\n${b.body ?? ""}`;
    const aStale = isDateStaleForNudge(aText) ? 0 : 1;
    const bStale = isDateStaleForNudge(bText) ? 0 : 1;
    if (aStale !== bStale) return aStale - bStale;
    const aCreated = a.created_at_ms ?? Number.MAX_SAFE_INTEGER;
    const bCreated = b.created_at_ms ?? Number.MAX_SAFE_INTEGER;
    return aCreated - bCreated;
  });
}

function toHygieneCandidate(row: BlockedKanbanRow): HygieneCandidate {
  const text = `${row.title ?? ""}\n${row.body ?? ""}`;
  const latestDate = latestHardDateMs(text);
  const ageDays =
    row.created_at_ms != null
      ? Math.round((Date.now() - row.created_at_ms) / 86_400_000)
      : null;
  return {
    taskId: row.task_id,
    board: row.board,
    title: row.title?.trim() || "(untitled)",
    blockReason: row.block_reason ?? null,
    projectSlug: projectSlugFromBoard(row.board),
    hints: {
      createdAtMs: row.created_at_ms ?? null,
      isDateStale: isDateStaleForNudge(text),
      latestHardDateMs: latestDate,
      ageDays,
    },
  };
}

/** Scan all boards, write `.joshu/proactive/hygiene-plan.json`, return plan. */
export async function prepareHygienePlan(projectRoot = process.cwd()): Promise<HygienePlan> {
  const allBlocked = sortHygieneCandidates(
    await listBlockedCrossBoard({ includeActivity: true }),
  ).filter((row) => !isOnboardingKanbanBody(row.body));
  const candidates = allBlocked.slice(0, HYGIENE_CANDIDATE_CAP).map(toHygieneCandidate);
  const plan: HygienePlan = {
    planId: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    candidateCount: candidates.length,
    totalBlocked: allBlocked.length,
    candidates,
  };
  ensureProactiveConfigDir(projectRoot);
  fs.writeFileSync(hygienePlanPath(projectRoot), JSON.stringify(plan, null, 2), { mode: 0o600 });
  return plan;
}

export function readHygienePlan(projectRoot = process.cwd()): HygienePlan | null {
  const file = hygienePlanPath(projectRoot);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as HygienePlan;
  } catch {
    return null;
  }
}
