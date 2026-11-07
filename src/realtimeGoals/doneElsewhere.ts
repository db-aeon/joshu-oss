/**
 * Realtime goals that another channel made unnecessary (issue #172).
 *
 * On box clara (2026-10-22) the owner asked for a meeting on Slack, the Slack
 * realtime goal blocked with a question, and the owner then sent the same
 * request by email. Mail ingress and ea-scheduling booked the meeting, but the
 * Slack realtime goal stayed blocked for days. Two rules close such goals:
 *
 * 1. The mail ingress worker sees the open realtime goals of the owner on its
 *    card and closes one that the email asks for again
 *    (`RealtimeGoalBroker.closeDoneElsewhere`). The owner gets one short line
 *    on the channel of the realtime goal.
 * 2. A blocked realtime goal whose question had no owner answer for 48 hours
 *    is cancelled without a message (`blockedGoalExpired`).
 */
import type { OwnerOutboxItem, RealtimeGoalRecord } from "./types.js";

const DEFAULT_BLOCKED_EXPIRY_HOURS = 48;
/** Open realtime goals listed on a mail ingress card, newest first. */
export const MAIL_INGRESS_OPEN_GOAL_LIMIT = 5;

/** Hours without an owner answer before a blocked realtime goal expires. */
export function blockedGoalExpiryMs(): number {
  const raw = Number.parseFloat(process.env.JOSHU_REALTIME_GOALS_BLOCKED_EXPIRY_HOURS ?? "");
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BLOCKED_EXPIRY_HOURS;
  return hours * 3_600_000;
}

function latest(...values: Array<string | undefined>): number {
  return Math.max(0, ...values.map((value) => (value ? Date.parse(value) : 0)).filter(Number.isFinite));
}

/**
 * When the realtime goal asked its open question: `blockedAskedAt`, else the
 * newest outbox item of kind blocked (goals blocked before the field existed),
 * else the last update of the goal.
 */
export function blockedQuestionAskedAt(goal: RealtimeGoalRecord, outbox: OwnerOutboxItem[]): string {
  if (goal.blockedAskedAt) return goal.blockedAskedAt;
  const asked = outbox
    .filter((item) => item.goalId === goal.id && item.kind === "blocked")
    .map((item) => item.createdAt)
    .sort()
    .at(-1);
  return asked ?? goal.updatedAt;
}

/** True when a blocked realtime goal had no owner answer or owner message for the expiry time. */
export function blockedGoalExpired(
  goal: RealtimeGoalRecord,
  outbox: OwnerOutboxItem[],
  nowMs = Date.now(),
  expiryMs = blockedGoalExpiryMs(),
): boolean {
  if (goal.status !== "blocked") return false;
  const lastTouch = latest(
    blockedQuestionAskedAt(goal, outbox),
    goal.blockedAnsweredAt,
    goal.ownerInteractedAt,
  );
  return lastTouch > 0 && nowMs - lastTouch >= expiryMs;
}

function quote(text: string | undefined, max: number): string {
  return JSON.stringify((text ?? "").replace(/\s+/g, " ").trim().slice(0, max));
}

/**
 * Lines for the card of a mail ingress task from the owner: the open realtime
 * goals, and what to do when the email asks for one of them again.
 */
export function mailIngressOpenGoalLines(goals: RealtimeGoalRecord[]): string[] {
  const open = goals.slice(0, MAIL_INGRESS_OPEN_GOAL_LIMIT);
  if (!open.length) return [];
  return [
    "Open realtime goals (the owner asked for these on another channel; one may be the same request as this email):",
    ...open.map(
      (goal) =>
        `open_realtime_goal: id=${goal.id} channel=${goal.origin.channel} status=${goal.status} asked_at=${goal.createdAt} title=${quote(goal.title, 120)}` +
        (goal.status === "blocked" && goal.lastBlockReason
          ? ` waiting_on_owner=${quote(goal.lastBlockReason, 200)}`
          : ""),
    ),
    "When this email asks for the same thing as an open realtime goal (same people, day, and time, or the same request), file the email and start the work as usual, then call realtime_goal_close_done_elsewhere(goalId, taskId=<the task that does the work: the scheduling or owner_reply task you created or handed off to, else this task>, note=<one short line for the owner, for example \"Your email asked for the same meeting, so I'm booking it from there.\">). Do not close a realtime goal that asks for something else.",
  ];
}
