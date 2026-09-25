/**
 * When a realtime-goal voice callback may ring the owner.
 *
 * Proactive nudges follow the owner's working hours (weekdays 08:00–17:00 by
 * default). A callback the owner just asked for is different: "I'll call you
 * back when it's done" is a promise, so for a few hours after the request it may
 * ring any day within civil hours — never in the middle of the night.
 */
import { Temporal } from "@js-temporal/polyfill";

import { normalizeIanaTimezone } from "../ianaTimezone.js";
import type { NylasAgentProfile } from "../nylas/profile.js";
import type { ProactivePreferences } from "../proactive/types.js";
import { isWithinProactiveWindow, parseMinutesSinceMidnight } from "../proactive/workingHours.js";
import type { RealtimeGoalRecord } from "./types.js";

/** How long after the owner's last message a callback still counts as requested. */
export const OWNER_REQUESTED_CALLBACK_MS = 6 * 60 * 60_000;
/** Owner-local civil hours for requested callbacks: [start, end). */
const REQUESTED_CALLBACK_START = parseMinutesSinceMidnight("07:00")!;
const REQUESTED_CALLBACK_END = parseMinutesSinceMidnight("22:00")!;
const SCAN_STEP_MINUTES = 15;
const SCAN_HORIZON_MINUTES = 7 * 24 * 60;

type CallbackGoal = Pick<RealtimeGoalRecord, "ownerInteractedAt" | "createdAt">;

export type RealtimeGoalCallbackWindow = {
  ok: boolean;
  /** Allowed only because the owner asked for this callback recently. */
  ownerRequested?: boolean;
  reason?: string;
};

function ownerRequestedRecently(goal: CallbackGoal, nowMs: number): boolean {
  const requestedAt = Date.parse(goal.ownerInteractedAt ?? goal.createdAt);
  if (!Number.isFinite(requestedAt)) return false;
  const age = nowMs - requestedAt;
  return age >= 0 && age < OWNER_REQUESTED_CALLBACK_MS;
}

export function realtimeGoalCallbackWindow(
  goal: CallbackGoal,
  profile: NylasAgentProfile | null,
  preferences: ProactivePreferences,
  instant = Temporal.Now.instant(),
): RealtimeGoalCallbackWindow {
  const proactive = isWithinProactiveWindow(profile, preferences, instant);
  if (proactive.ok) return { ok: true };

  const tz = profile?.timezone?.trim();
  if (tz && ownerRequestedRecently(goal, instant.epochMilliseconds)) {
    const local = instant.toZonedDateTimeISO(normalizeIanaTimezone(tz));
    const minutes = local.hour * 60 + local.minute;
    if (minutes >= REQUESTED_CALLBACK_START && minutes < REQUESTED_CALLBACK_END) {
      return { ok: true, ownerRequested: true };
    }
    return { ok: false, reason: "owner_quiet_hours" };
  }
  return { ok: false, reason: proactive.reason || "outside owner working hours" };
}

/** First time (ISO) within the next week the callback may ring, on a 15-minute grid. */
export function nextRealtimeGoalCallbackWindow(
  goal: CallbackGoal,
  profile: NylasAgentProfile | null,
  preferences: ProactivePreferences,
  nowMs = Date.now(),
): string | undefined {
  for (let offset = 0; offset <= SCAN_HORIZON_MINUTES; offset += SCAN_STEP_MINUTES) {
    const at = nowMs + offset * 60_000;
    const instant = Temporal.Instant.fromEpochMilliseconds(at);
    if (realtimeGoalCallbackWindow(goal, profile, preferences, instant).ok) {
      return new Date(at).toISOString();
    }
  }
  return undefined;
}

/** "9:15 AM tomorrow" / "8:00 AM Monday" in the owner's timezone, for the defer text. */
export function describeCallbackTime(iso: string, timezone: string, nowMs = Date.now()): string {
  const tz = normalizeIanaTimezone(timezone);
  const at = Temporal.Instant.fromEpochMilliseconds(Date.parse(iso)).toZonedDateTimeISO(tz);
  const today = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(tz).toPlainDate();
  // ZonedDateTime formats in its own zone (passing timeZone throws).
  const clock = at.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
  const days = at.toPlainDate().since(today).days;
  if (days === 0) return `${clock} today`;
  if (days === 1) return `${clock} tomorrow`;
  return `${clock} ${at.toLocaleString("en-US", { weekday: "long" })}`;
}
