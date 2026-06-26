/** Shared scheduling constants and helpers (Kanban-only model). */

export const EA_SCHEDULING_BOARD = "ea-scheduling";
/** Per-email ingress board — one Kanban task per scheduling message. */
export const EA_SCHED_INGRESS_BOARD = "ea-sched-ingress";
export const EA_SCHEDULING_SKILL = "ea-scheduling";

/** @deprecated Singleton inbox processor — replaced by per-message tasks on ea-sched-ingress. */
export const SCHEDULING_INBOX_IDEMPOTENCY_KEY = "ea-sched-inbox";

/** Kanban idempotency for a meeting task handler re-run. */
export function meetingTaskIdempotencyKey(taskId: string): string {
  return `ea-meet-${taskId}`;
}

export {
  schedulingIngressTaskIdempotencyKey as ingressTaskIdempotencyKey,
  schedulingMeetingTaskIdempotencyKeyFromMessage as meetingTaskIdempotencyKeyFromMessage,
} from "./mailDedup.js";

/** Stable ingress event id (legacy JSONL + ingress task body). */
export function buildIngressEventId(
  provider: string,
  threadId: string,
  messageId: string,
): string {
  const safeMsg = messageId.replace(/[^a-zA-Z0-9._:@-]+/g, "_").slice(0, 80);
  return `ingress-${provider}-${threadId}-${safeMsg}`;
}

/** Extract bare email from "Name <email>" or return trimmed input. */
export function parseEmailAddress(from?: string): string | null {
  const raw = from?.trim();
  if (!raw) return null;
  const match = /<([^>]+)>/.exec(raw);
  if (match) return match[1]!.trim().toLowerCase();
  if (raw.includes("@")) return raw.toLowerCase();
  return null;
}
