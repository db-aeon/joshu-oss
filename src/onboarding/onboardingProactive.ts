/**
 * Proactive sweep helpers for ea-onboarding setup-debt cards.
 */
import { EA_ONBOARDING_KANBAN_BOARD } from "../hermesKanbanBridge.js";
import { onboardingStatePath, readJsonFile } from "./paths.js";
import type { OnboardingState } from "./types.js";
import { listActiveOnboardingPrompts } from "./promptRegistry.js";
import { countOpenRequiredOnboardingPrompts } from "./promptPredicates.js";
import {
  isOnboardingKanbanBody,
  isPromptSnoozed,
  parseOnboardingPromptIdFromBody,
  readOnboardingPromptState,
} from "./promptState.js";

/** Days after Welcome complete during which onboarding nudges rank above mail tracks. */
export const ONBOARDING_SETUP_DEBT_DAYS = 14;

/** Score subtracted in rankCandidate — lower score wins. */
export const ONBOARDING_RANK_BOOST = 120;

export function readOnboardingCompletedAt(projectRoot: string): string | null {
  const state = readJsonFile<OnboardingState>(onboardingStatePath(projectRoot));
  return state?.completedAt?.trim() || null;
}

export function isWithinOnboardingSetupWindow(
  completedAt: string | null,
  now = Date.now(),
): boolean {
  if (!completedAt) return true;
  const t = Date.parse(completedAt);
  if (!Number.isFinite(t)) return true;
  const days = (now - t) / 86_400_000;
  return days <= ONBOARDING_SETUP_DEBT_DAYS;
}

/** True when ea-onboarding should get rank boost in proactive sweep. */
export async function isOnboardingSetupDebt(
  projectRoot: string,
  board: string,
): Promise<boolean> {
  if (board !== EA_ONBOARDING_KANBAN_BOARD) return false;
  const completedAt = readOnboardingCompletedAt(projectRoot);
  if (!isWithinOnboardingSetupWindow(completedAt)) return false;
  const prompts = await listActiveOnboardingPrompts(projectRoot);
  const openRequired = await countOpenRequiredOnboardingPrompts(projectRoot, prompts);
  return openRequired > 0;
}

/** Skip proactive nudge for snoozed onboarding prompt cards. */
export function isOnboardingCandidateSuppressed(
  projectRoot: string,
  board: string,
  body: string | undefined,
): boolean {
  if (board !== EA_ONBOARDING_KANBAN_BOARD) return false;
  if (!isOnboardingKanbanBody(body)) return false;
  const promptId = parseOnboardingPromptIdFromBody(body);
  if (!promptId) return false;
  const state = readOnboardingPromptState(projectRoot);
  return isPromptSnoozed(state, promptId);
}
