/**
 * Shared Twilio SMS gateway configuration (timeout, default Hermes system prompt).
 */

import { envTrim } from "./twilioSmsSend.js";

/** Default progress check time of an SMS turn, and fixed budget of proactive turns (was 180s). */
export const SMS_HERMES_TIMEOUT_MS_DEFAULT = 300_000;

function boundedEnvMs(name: string, fallback: number, min: number, max: number): number {
  const raw = envTrim(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Min/max bounds when overriding via env. */
const SMS_HERMES_TIMEOUT_MS_MIN = 60_000;
const SMS_HERMES_TIMEOUT_MS_MAX = 600_000;

/**
 * Progress check time of an SMS turn (see smsTurnDeadline), and the fixed timeout
 * of the proactive resolve and compose turns.
 */
export function resolveSmsHermesTimeoutMs(): number {
  return boundedEnvMs(
    "JOSHU_SMS_HERMES_TIMEOUT_MS",
    SMS_HERMES_TIMEOUT_MS_DEFAULT,
    SMS_HERMES_TIMEOUT_MS_MIN,
    SMS_HERMES_TIMEOUT_MS_MAX,
  );
}

/** An SMS turn past the progress check time stops when Hermes reported no progress for this long. */
export const SMS_HERMES_STALL_MS_DEFAULT = 180_000;
/** An SMS turn never runs longer than this; the work then continues as a realtime goal. */
export const SMS_HERMES_MAX_MS_DEFAULT = 1_200_000;

export function resolveSmsHermesStallMs(): number {
  return boundedEnvMs("JOSHU_SMS_HERMES_STALL_MS", SMS_HERMES_STALL_MS_DEFAULT, 30_000, 600_000);
}

export function resolveSmsHermesMaxMs(): number {
  return boundedEnvMs("JOSHU_SMS_HERMES_MAX_MS", SMS_HERMES_MAX_MS_DEFAULT, 60_000, 3_600_000);
}

/** Fixed budget for short SMS model calls (proactive resolve and compose). */
export function smsHermesAbortSignal(): AbortSignal {
  return AbortSignal.timeout(resolveSmsHermesTimeoutMs());
}

/** Default system prompt when TWILIO_SMS_SYSTEM_PROMPT is unset. */
export function defaultTwilioSmsSystemPrompt(): string {
  return [
    "You are Joshu on SMS with the box owner. Reply in concise plain text — no markdown or tables.",
    "Keep most replies short; Joshu splits long SMS automatically (handoff links are OK).",
    "SMS turns must be fast: answer from context you already have. Do not run deep investigations on SMS.",
    "If a request turns out to need longer work, call realtime_goal_defer with a self-contained objective, return its acknowledgment, and stop the turn.",
    "Do not use session_search, execute_code, or terminal on SMS — they are slow and terminal needs desktop Safety approval the owner cannot give mid-text.",
    "If the owner continues a proactive nudge thread, Joshu routes you with Kanban resolve context — use kanban_show, not session_search.",
    "For login-gated sites (Amazon orders, bank, checkout, 2FA): load skill joshu-browser-handoff,",
    "navigate in the shared browser tab, call browser_handoff_request, and text the returned handoff URL.",
    "Do not guess from Gmail/Composio alone when the answer requires the owner's logged-in browser session.",
    "Owner SMS auto-completes any pending handoff for this session before your turn — the browser is already unlocked when you reply.",
    "You can still call browser_handoff_complete if a pending handoff remains (e.g. jChat); owner does not need to tap I'm done on the link.",
    "After handoff completes, reply with the answer in your assistant message only — never nylas_send_message on SMS.",
  ].join(" ");
}
