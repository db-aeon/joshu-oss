/**
 * Per-box onboarding prompt dismiss / skip state (.joshu/onboarding/prompt-state.json).
 */
import fs from "node:fs";
import path from "node:path";

import { joshuConfigDir } from "../nylas/paths.js";
import { writeJsonFile, readJsonFile } from "./paths.js";

export type OnboardingPromptEntryState = {
  declined?: boolean;
  /** ISO8601 — suppress upsert and proactive nudge until this instant. */
  dismissedUntil?: string | null;
};

export type OnboardingPromptState = {
  schemaVersion: 1;
  prompts: Record<string, OnboardingPromptEntryState>;
};

export const DEFAULT_ONBOARDING_PROMPT_STATE: OnboardingPromptState = {
  schemaVersion: 1,
  prompts: {},
};

function promptStatePath(projectRoot: string): string | null {
  const base = joshuConfigDir(projectRoot);
  if (!base) return null;
  return path.join(base, "onboarding", "prompt-state.json");
}

export function readOnboardingPromptState(projectRoot = process.cwd()): OnboardingPromptState {
  const file = promptStatePath(projectRoot);
  const raw = readJsonFile<OnboardingPromptState>(file);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ONBOARDING_PROMPT_STATE, prompts: {} };
  const prompts: Record<string, OnboardingPromptEntryState> = {};
  if (raw.prompts && typeof raw.prompts === "object") {
    for (const [id, entry] of Object.entries(raw.prompts)) {
      if (!entry || typeof entry !== "object") continue;
      prompts[id] = {
        declined: entry.declined === true,
        dismissedUntil:
          typeof entry.dismissedUntil === "string" && entry.dismissedUntil.trim()
            ? entry.dismissedUntil.trim()
            : null,
      };
    }
  }
  return { schemaVersion: 1, prompts };
}

export function writeOnboardingPromptState(
  state: OnboardingPromptState,
  projectRoot = process.cwd(),
): void {
  const file = promptStatePath(projectRoot);
  if (!file) throw new Error("onboarding prompt-state path unavailable");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonFile(file, state);
}

/** Owner declined this optional prompt permanently. */
export function isPromptDeclined(state: OnboardingPromptState, promptId: string): boolean {
  return state.prompts[promptId]?.declined === true;
}

/** Snoozed — reconcile skips upsert; sweep should skip nudge. */
export function isPromptSnoozed(state: OnboardingPromptState, promptId: string, now = Date.now()): boolean {
  const until = state.prompts[promptId]?.dismissedUntil;
  if (!until?.trim()) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now;
}

export function shouldSuppressPrompt(
  state: OnboardingPromptState,
  promptId: string,
  now = Date.now(),
): boolean {
  return isPromptDeclined(state, promptId) || isPromptSnoozed(state, promptId, now);
}

/** Extract prompt_id from Kanban task body (kind: onboarding). */
export function parseOnboardingPromptIdFromBody(body: string | undefined): string | null {
  if (!body) return null;
  const match = /^prompt_id:\s*(\S+)/m.exec(body);
  return match?.[1]?.trim() || null;
}

export function isOnboardingKanbanBody(body: string | undefined): boolean {
  if (!body) return false;
  return /^kind:\s*onboarding\b/m.test(body);
}
