import fs from "node:fs";

import { Temporal } from "@js-temporal/polyfill";

import { normalizeIanaTimezone } from "../ianaTimezone.js";
import type { ProactiveLastNudge, ProactivePreferences, ProactiveState } from "./types.js";
import { ensureProactiveConfigDir, proactiveStatePath } from "./paths.js";

export const PROACTIVE_FACTORY_PREFERENCES: ProactivePreferences = {
  allowMorePerDay: false,
  allowEvenings: false,
  allowWeekends: false,
  offHoursAskedAt: null,
  notes: [],
};

export function factoryProactiveState(localDate: string): ProactiveState {
  return {
    date: localDate,
    dailyCap: 1,
    sentCount: 0,
    lastNudge: null,
    feedbackPending: false,
    nudgedTaskIds: [],
    preferences: { ...PROACTIVE_FACTORY_PREFERENCES, notes: [] },
    hygieneLastRunAt: null,
    hygieneClosedTaskIds: [],
    lastHygieneSummary: null,
    hygieneAmbiguousQueue: [],
    lastOnboardingNudgeDate: null,
    lastOwnerReplyAt: null,
  };
}

function mergePreferences(raw: Partial<ProactivePreferences> | undefined): ProactivePreferences {
  return {
    allowMorePerDay: raw?.allowMorePerDay === true,
    allowEvenings: raw?.allowEvenings === true,
    allowWeekends: raw?.allowWeekends === true,
    offHoursAskedAt:
      typeof raw?.offHoursAskedAt === "string" && raw.offHoursAskedAt.trim()
        ? raw.offHoursAskedAt.trim()
        : null,
    notes: Array.isArray(raw?.notes)
      ? raw!.notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
      : [],
  };
}

/** Owner-local calendar date YYYY-MM-DD. */
export function ownerLocalDateString(timezone: string, instant = Temporal.Now.instant()): string {
  const tz = normalizeIanaTimezone(timezone);
  return instant.toZonedDateTimeISO(tz).toPlainDate().toString();
}

export function readProactiveState(projectRoot = process.cwd(), timezone?: string): ProactiveState {
  const file = proactiveStatePath(projectRoot);
  const today =
    timezone && timezone.trim()
      ? ownerLocalDateString(timezone)
      : new Date().toISOString().slice(0, 10);

  if (!fs.existsSync(file)) {
    return factoryProactiveState(today);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProactiveState>;
    const prefs = mergePreferences(parsed.preferences);
    let dailyCap =
      typeof parsed.dailyCap === "number" && parsed.dailyCap >= 1 ? Math.floor(parsed.dailyCap) : 1;
    if (prefs.allowMorePerDay && dailyCap < 2) {
      dailyCap = 2;
    }

    const state: ProactiveState = {
      date: typeof parsed.date === "string" ? parsed.date : today,
      dailyCap,
      sentCount: typeof parsed.sentCount === "number" ? Math.max(0, parsed.sentCount) : 0,
      lastNudge:
        parsed.lastNudge && typeof parsed.lastNudge === "object"
          ? (parsed.lastNudge as ProactiveState["lastNudge"])
          : null,
      feedbackPending: parsed.feedbackPending === true,
      nudgedTaskIds: Array.isArray(parsed.nudgedTaskIds)
        ? parsed.nudgedTaskIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [],
      preferences: prefs,
      hygieneLastRunAt:
        typeof parsed.hygieneLastRunAt === "string" ? parsed.hygieneLastRunAt : null,
      hygieneClosedTaskIds: Array.isArray(parsed.hygieneClosedTaskIds)
        ? parsed.hygieneClosedTaskIds.filter((id): id is string => typeof id === "string")
        : [],
      lastHygieneSummary:
        parsed.lastHygieneSummary && typeof parsed.lastHygieneSummary === "object"
          ? (parsed.lastHygieneSummary as ProactiveState["lastHygieneSummary"])
          : null,
      hygieneAmbiguousQueue: Array.isArray(parsed.hygieneAmbiguousQueue)
        ? parsed.hygieneAmbiguousQueue
            .filter(
              (q): q is NonNullable<ProactiveState["hygieneAmbiguousQueue"]>[number] =>
                q &&
                typeof q === "object" &&
                typeof (q as { taskId?: unknown }).taskId === "string" &&
                typeof (q as { board?: unknown }).board === "string",
            )
            .map((q) => ({
              taskId: q.taskId.trim(),
              board: q.board.trim(),
              title:
                typeof q.title === "string" && q.title.trim() ? q.title.trim() : "(untitled)",
              blockReason:
                typeof q.blockReason === "string"
                  ? q.blockReason
                  : q.blockReason === null
                    ? null
                    : null,
              queuedAt:
                typeof q.queuedAt === "string" && q.queuedAt.trim()
                  ? q.queuedAt.trim()
                  : new Date().toISOString(),
            }))
        : [],
      lastOnboardingNudgeDate:
        typeof parsed.lastOnboardingNudgeDate === "string"
          ? parsed.lastOnboardingNudgeDate.trim()
          : null,
      lastOwnerReplyAt:
        typeof parsed.lastOwnerReplyAt === "string" && parsed.lastOwnerReplyAt.trim()
          ? parsed.lastOwnerReplyAt.trim()
          : null,
      refBoards:
        parsed.refBoards && typeof parsed.refBoards === "object"
          ? Object.fromEntries(
              Object.entries(parsed.refBoards).filter(
                (e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0,
              ),
            )
          : {},
    };

    return rolloverProactiveState(state, today);
  } catch {
    return factoryProactiveState(today);
  }
}

/** Reset daily counters when owner-local date changes; keep preferences. */
export function rolloverProactiveState(state: ProactiveState, today: string): ProactiveState {
  if (state.date === today) return state;
  return {
    ...state,
    date: today,
    sentCount: 0,
    nudgedTaskIds: [],
    feedbackPending: false,
  };
}

export function writeProactiveState(state: ProactiveState, projectRoot = process.cwd()): void {
  ensureProactiveConfigDir(projectRoot);
  fs.writeFileSync(proactiveStatePath(projectRoot), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

export const REF_BOARDS_MAX = 20;

/** Remember the board of a task id that an owner text named in its Ref line. */
export function rememberRefBoard(state: ProactiveState, taskId: string, board: string): ProactiveState {
  const refBoards = { ...(state.refBoards ?? {}) };
  delete refBoards[taskId];
  refBoards[taskId] = board;
  const keys = Object.keys(refBoards);
  for (const old of keys.slice(0, Math.max(0, keys.length - REF_BOARDS_MAX))) delete refBoards[old];
  return { ...state, refBoards };
}

/**
 * Board of the task that an owner reply is about: the remembered board of the task id,
 * else the board of `lastNudge`.
 */
export function boardForTaskRef(state: ProactiveState, taskId: string | undefined): string | undefined {
  const id = taskId?.trim();
  if (id && state.refBoards?.[id]) return state.refBoards[id];
  return state.lastNudge?.board;
}

/**
 * A Multiplayer team text that needs an answer (spec team-standup): the owner reply goes to
 * the task through the nudge reply path. The text does not count against the daily nudge cap,
 * and the hourly sweep does not nudge the same task again on the same day.
 */
export function recordOwnerQuestionText(state: ProactiveState, nudge: ProactiveLastNudge): ProactiveState {
  const nudgedTaskIds = state.nudgedTaskIds.includes(nudge.taskId) ? state.nudgedTaskIds : [...state.nudgedTaskIds, nudge.taskId];
  return rememberRefBoard({ ...state, lastNudge: nudge, lastOwnerReplyAt: null, nudgedTaskIds }, nudge.taskId, nudge.board);
}

export function canSendNudge(state: ProactiveState): { ok: boolean; reason?: string } {
  if (state.sentCount >= state.dailyCap) {
    return { ok: false, reason: "daily_cap_reached" };
  }
  return { ok: true };
}

export function wasOnboardingNudgedToday(state: ProactiveState, today: string): boolean {
  return state.lastOnboardingNudgeDate === today;
}

export function wasTaskNudgedToday(state: ProactiveState, taskId: string): boolean {
  return state.nudgedTaskIds.includes(taskId.trim());
}
