import type { ProactiveFeedbackResult, ProactiveState } from "./types.js";
import { composeProactiveMessage } from "./composeMessage.js";
import { readProactiveState, writeProactiveState } from "./state.js";

export type FeedbackKeyword =
  | "MORE"
  | "LESS"
  | "USEFUL"
  | "NOT_USEFUL"
  | "EVENINGS_OK"
  | "WEEKENDS_OK"
  | "NO_EVENINGS"
  | "NO_WEEKENDS";

export type TaskActionKeyword = "DONE" | "CLOSE" | "KEEP";

const KEYWORD_MAP: Record<string, FeedbackKeyword> = {
  MORE: "MORE",
  LESS: "LESS",
  USEFUL: "USEFUL",
  "NOT USEFUL": "NOT_USEFUL",
  NOTUSEFUL: "NOT_USEFUL",
  "EVENINGS OK": "EVENINGS_OK",
  EVENINGSOK: "EVENINGS_OK",
  "WEEKENDS OK": "WEEKENDS_OK",
  WEEKENDSOK: "WEEKENDS_OK",
  "NO EVENINGS": "NO_EVENINGS",
  NOEVENINGS: "NO_EVENINGS",
  "NO WEEKENDS": "NO_WEEKENDS",
  NOWEEKENDS: "NO_WEEKENDS",
};

const TASK_ACTION_MAP: Record<string, TaskActionKeyword> = {
  DONE: "DONE",
  CLOSE: "CLOSE",
  KEEP: "KEEP",
};

export function parseFeedbackKeyword(body: string): FeedbackKeyword | null {
  const normalized = body.trim().replace(/\s+/g, " ").toUpperCase();
  if (KEYWORD_MAP[normalized]) return KEYWORD_MAP[normalized];

  // Short replies to nudge cadence prompts (e.g. "more please", "less", "useful").
  if (normalized.length > 48) return null;
  if (/\bNOT USEFUL\b/.test(normalized) || /\bNOTUSEFUL\b/.test(normalized)) {
    return "NOT_USEFUL";
  }
  const wordCount = normalized.split(" ").length;
  if (/\bUSEFUL\b/.test(normalized) && wordCount <= 4) return "USEFUL";
  if (
    /\bMORE\b/.test(normalized) &&
    wordCount <= 4 &&
    !/\bTELL ME MORE\b/.test(normalized) &&
    !/\bMORE ABOUT\b/.test(normalized)
  ) {
    return "MORE";
  }
  if (/\bLESS\b/.test(normalized) && wordCount <= 4) return "LESS";
  if (/\bEVENINGS OK\b/.test(normalized) || /\bEVENINGSOK\b/.test(normalized)) {
    return "EVENINGS_OK";
  }
  if (/\bWEEKENDS OK\b/.test(normalized) || /\bWEEKENDSOK\b/.test(normalized)) {
    return "WEEKENDS_OK";
  }
  if (/\bNO EVENINGS\b/.test(normalized) || /\bNOEVENINGS\b/.test(normalized)) {
    return "NO_EVENINGS";
  }
  if (/\bNO WEEKENDS\b/.test(normalized) || /\bNOWEEKENDS\b/.test(normalized)) {
    return "NO_WEEKENDS";
  }
  return null;
}

/** Exact-match owner task action (stale review). */
export function parseTaskActionKeyword(body: string): TaskActionKeyword | null {
  const normalized = body.trim().replace(/\s+/g, " ").toUpperCase();
  return TASK_ACTION_MAP[normalized] ?? null;
}

function applyKeyword(state: ProactiveState, keyword: FeedbackKeyword): ProactiveState {
  const next: ProactiveState = {
    ...state,
    preferences: { ...state.preferences, notes: [...state.preferences.notes] },
    feedbackPending: false,
  };

  switch (keyword) {
    case "MORE":
      next.preferences.allowMorePerDay = true;
      next.dailyCap = Math.min(Math.max(next.dailyCap, 2) + 1, 5);
      break;
    case "LESS":
      next.dailyCap = 1;
      next.preferences.allowMorePerDay = false;
      break;
    case "NOT_USEFUL":
      next.dailyCap = 1;
      next.preferences.notes.push(`negative feedback at ${new Date().toISOString()}`);
      break;
    case "EVENINGS_OK":
      next.preferences.allowEvenings = true;
      break;
    case "WEEKENDS_OK":
      next.preferences.allowWeekends = true;
      break;
    case "NO_EVENINGS":
      next.preferences.allowEvenings = false;
      break;
    case "NO_WEEKENDS":
      next.preferences.allowWeekends = false;
      break;
    case "USEFUL":
      next.preferences.notes.push(`positive feedback at ${new Date().toISOString()}`);
      break;
    default:
      break;
  }
  return next;
}

export async function recordProactiveFeedback(
  body: string,
  projectRoot = process.cwd(),
  timezone?: string,
): Promise<ProactiveFeedbackResult> {
  const keyword = parseFeedbackKeyword(body);
  if (!keyword) {
    return { ok: false, message: "unrecognized_feedback" };
  }
  const state = readProactiveState(projectRoot, timezone);
  const updated = applyKeyword(state, keyword);
  writeProactiveState(updated, projectRoot);

  const message = await composeProactiveMessage({
    kind: "feedback_ack",
    projectRoot,
    feedbackKeyword: keyword,
    dailyCap: updated.dailyCap,
  });

  return { ok: true, message, state: updated };
}

/** Sync apply without compose (tests / internal). */
export function applyProactiveFeedbackKeyword(
  body: string,
  projectRoot = process.cwd(),
  timezone?: string,
): ProactiveFeedbackResult {
  const keyword = parseFeedbackKeyword(body);
  if (!keyword) {
    return { ok: false, message: "unrecognized_feedback" };
  }
  const state = readProactiveState(projectRoot, timezone);
  const updated = applyKeyword(state, keyword);
  writeProactiveState(updated, projectRoot);
  return { ok: true, message: keyword, state: updated };
}
