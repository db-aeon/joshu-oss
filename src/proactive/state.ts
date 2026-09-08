import fs from "node:fs";

import { Temporal } from "@js-temporal/polyfill";

import { normalizeIanaTimezone } from "../ianaTimezone.js";
import type { ProactivePreferences, ProactiveState } from "./types.js";
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

export function canSendNudge(state: ProactiveState): { ok: boolean; reason?: string } {
  if (state.sentCount >= state.dailyCap) {
    return { ok: false, reason: "daily_cap_reached" };
  }
  return { ok: true };
}

export function wasTaskNudgedToday(state: ProactiveState, taskId: string): boolean {
  return state.nudgedTaskIds.includes(taskId.trim());
}
