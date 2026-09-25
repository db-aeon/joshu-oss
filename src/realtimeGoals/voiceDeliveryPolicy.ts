import type {
  RealtimeGoalOrigin,
  RealtimeGoalVoiceCallbackOutcome,
} from "./types.js";

/**
 * Redial policy for outbound PSTN goal callbacks.
 *
 * A callback only counts as delivered after the owner unlocks with the
 * passphrase and hears the result. Everything else is "undelivered", but not all
 * undelivered calls are equal:
 *
 * - voicemail / passphrase lockout → the owner is not reachable by phone right
 *   now. Redialing just fills their voicemail. Park the result, text a nudge.
 * - no answer / busy / hung up before unlock → retry with backoff, bounded.
 *
 * Callbacks are also serialized per owner session so several blocked goals do
 * not ring the phone in a burst.
 */

/** Total dial attempts for one goal result before it is parked. */
export const MAX_VOICE_CALLBACK_ATTEMPTS = 3;

/** First redial delay; doubles per attempt (15m, 30m, ...). */
const VOICE_RETRY_BASE_MS = 15 * 60_000;

/** Hold on all callbacks for a session after results were parked. */
export const PARKED_SESSION_HOLD_MS = 60 * 60_000;

/** Minimum gap between two callbacks to the same owner, even after a success. */
export const CALLBACK_GAP_MS = 2 * 60_000;

/** Session hold while a callback call is ringing / in progress (lease). */
export const CALLBACK_IN_FLIGHT_HOLD_MS = 30 * 60_000;

/** Twilio CallStatus values that end a call. */
const TERMINAL_CALL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

export function isTerminalCallStatus(status: string): boolean {
  return TERMINAL_CALL_STATUSES.has(status.trim().toLowerCase());
}

/** Channels whose delivery places an outbound call and must be serialized. */
export function usesExclusiveCallback(origin: RealtimeGoalOrigin): boolean {
  return origin.channel === "pstn_voice";
}

/**
 * Map Twilio AMD `AnsweredBy` to an outcome. `human` and `unknown` return
 * undefined so the passphrase flow decides (AMD is a hint, not proof).
 */
export function answeredByOutcome(
  answeredBy: string | undefined,
): RealtimeGoalVoiceCallbackOutcome | undefined {
  const value = answeredBy?.trim().toLowerCase() ?? "";
  if (value.startsWith("machine") || value === "fax") return "voicemail";
  return undefined;
}

export type VoiceCallbackSettlement =
  | { action: "retry"; retryAt: string; reason: string }
  | { action: "park"; reason: string };

/** Decide what happens after a callback ended without authenticated delivery. */
export function settleUndeliveredCallback(input: {
  attempts: number;
  outcome?: RealtimeGoalVoiceCallbackOutcome;
  twilioStatus?: string;
  nowMs?: number;
}): VoiceCallbackSettlement {
  const nowMs = input.nowMs ?? Date.now();
  if (input.outcome === "voicemail") {
    return { action: "park", reason: "callback reached voicemail" };
  }
  if (input.outcome === "auth_failed") {
    return { action: "park", reason: "callback passphrase attempts exhausted" };
  }
  const why = input.outcome === "no_unlock"
    ? "callback ended before passphrase unlock"
    : `callback ${input.twilioStatus || "ended"} before authenticated delivery`;
  if (input.attempts >= MAX_VOICE_CALLBACK_ATTEMPTS) {
    return { action: "park", reason: `${why}; ${input.attempts} calls unanswered` };
  }
  const delay = VOICE_RETRY_BASE_MS * 2 ** Math.max(0, input.attempts - 1);
  return { action: "retry", retryAt: new Date(nowMs + delay).toISOString(), reason: why };
}
