/**
 * Skip proactive nudges while the owner is in a calendar busy block (Google FreeBusy).
 */
import { Temporal } from "@js-temporal/polyfill";

import { isComposioEnabled } from "../composioApi.js";
import { fetchGoogleCalendarFreeSlots } from "../connectors/composio/calendar.js";
import {
  getDefaultCalendarAccount,
  isAnyGoogleCalendarConnected,
} from "../connectors/composio/calendarAccounts.js";
import { combineCalendarFreeBusy } from "../connectors/composio/calendarAvailability.js";
import { normalizeIanaTimezone } from "../ianaTimezone.js";
import { readAgentProfile } from "../nylas/profile.js";

/** Do not nudge this many ms before a busy block starts (back-to-back prep). */
const PRE_MEETING_BUFFER_MS = 5 * 60 * 1000;

export type OwnerMeetingCheck = {
  /** true when nudges may send (not in a meeting). */
  ok: boolean;
  inMeeting?: boolean;
  reason?: string;
  busyUntil?: string;
};

/**
 * Returns ok:false when owner local time falls inside a combined FreeBusy interval.
 * Fails open when calendar is unavailable so Composio outages do not silence nudges forever.
 */
export async function isOwnerAvailableForProactive(
  projectRoot: string,
  instant = Temporal.Now.instant(),
): Promise<OwnerMeetingCheck> {
  if (!isComposioEnabled()) {
    return { ok: true, reason: "composio_disabled" };
  }
  if (!(await isAnyGoogleCalendarConnected(projectRoot))) {
    return { ok: true, reason: "calendar_not_connected" };
  }

  const profile = readAgentProfile(projectRoot);
  const tzRaw = profile?.timezone?.trim();
  if (!tzRaw) {
    return { ok: true, reason: "missing_timezone" };
  }
  const tz = normalizeIanaTimezone(tzRaw);

  const account = await getDefaultCalendarAccount(projectRoot);
  if (!account?.connectedAccountId) {
    return { ok: true, reason: "no_calendar_account" };
  }

  const timeMin = instant.subtract({ minutes: 5 }).toString();
  const timeMax = instant.add({ hours: 3 }).toString();
  const nowMs = instant.epochMilliseconds;

  try {
    const slots = await fetchGoogleCalendarFreeSlots(
      projectRoot,
      { connectedAccountId: account.connectedAccountId },
      { timeMin, timeMax, timezone: tz },
    );
    const combined = combineCalendarFreeBusy(slots.calendars, slots.timeMin, slots.timeMax);

    for (const block of combined.busy) {
      const startMs = Date.parse(block.start);
      const endMs = Date.parse(block.end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      if (nowMs >= startMs - PRE_MEETING_BUFFER_MS && nowMs < endMs) {
        return {
          ok: false,
          inMeeting: true,
          reason: "owner_in_meeting",
          busyUntil: block.end,
        };
      }
    }
    return { ok: true };
  } catch (err) {
    console.warn("[proactive] calendar busy check failed:", (err as Error).message);
    return { ok: true, reason: "calendar_check_failed" };
  }
}
