/**
 * After a gated Nylas send settles (approved+delivered, denied, timeout, or
 * approval unavailable), rewrite the meeting task block_reason so status UIs
 * and jChat stop claiming "awaiting owner approval" when mail already left
 * (or was never sent).
 *
 * Requires `kanbanTaskId` on the send body — no thread inference in v1.
 */
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { updateSchedulingMeetingBlockReason } from "./schedulingCron.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Optional scheduling context passed on `nylas_send_message` / REST send. */
export function readSchedulingSendContext(body: Record<string, unknown>): {
  kanbanTaskId?: string;
  threadId?: string;
} {
  const kanbanTaskId =
    readString(body.kanbanTaskId) ||
    readString(body.kanban_task_id) ||
    readString(body.taskId) ||
    readString(body.task_id) ||
    undefined;
  const threadId =
    readString(body.threadId) || readString(body.thread_id) || undefined;
  return {
    ...(kanbanTaskId ? { kanbanTaskId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function formatRecipients(to: unknown): string {
  if (typeof to === "string" && to.trim()) return to.trim();
  if (Array.isArray(to)) {
    const parts = to
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object" && "email" in item) {
          return readString((item as { email?: unknown }).email);
        }
        return "";
      })
      .filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return "recipient";
}

export type SchedulingSendFollowupOutcome =
  | { kind: "delivered"; messageId: string }
  | { kind: "denied" }
  | { kind: "timeout" }
  | { kind: "unavailable"; code?: string; message?: string };

function buildReasonAndComment(
  outcome: SchedulingSendFollowupOutcome,
  body: Record<string, unknown>,
): { reason: string; comment: string } {
  const toLabel = formatRecipients(body.to);
  const subject = readString(body.subject) || "(no subject)";
  const day = new Date().toISOString().slice(0, 10);

  if (outcome.kind === "delivered") {
    return {
      reason: `awaiting reply: availability/outreach delivered to ${toLabel} (${day}); waiting on counterparty`,
      comment:
        `Action guard cleared — mail delivered (messageId=${outcome.messageId}). ` +
        `Subject: ${subject}. Waiting on reply from ${toLabel}.`,
    };
  }
  if (outcome.kind === "denied") {
    return {
      reason: `owner denied send: outreach to ${toLabel} was not delivered`,
      comment: `Action guard denied — no mail sent to ${toLabel}. Subject: ${subject}.`,
    };
  }
  if (outcome.kind === "timeout") {
    return {
      reason: `approval timed out: outreach to ${toLabel} was not delivered`,
      comment: `Action guard timed out — no mail sent to ${toLabel}. Subject: ${subject}.`,
    };
  }
  const detail = outcome.message || outcome.code || "owner channel unavailable";
  return {
    reason: `action-guard-unavailable: ${detail}`,
    comment: `Action guard unavailable (${outcome.code ?? "unknown"}) — no mail sent. ${detail}`,
  };
}

/**
 * Best-effort Kanban rewrite. Never throws into the send path.
 * No-ops when kanbanTaskId is missing or files root is unavailable.
 */
export async function applySchedulingSendFollowup(opts: {
  projectRoot: string;
  body: Record<string, unknown>;
  outcome: SchedulingSendFollowupOutcome;
}): Promise<void> {
  const ctx = readSchedulingSendContext(opts.body);
  if (!ctx.kanbanTaskId) return;

  const filesRoot = resolveJoshuFilesPaths(opts.projectRoot)?.filesRoot ?? null;
  if (!filesRoot) {
    console.warn(
      `[ea-scheduling] send followup skipped task=${ctx.kanbanTaskId}: JOSHU_FILES_ROOT unavailable`,
    );
    return;
  }

  const { reason, comment } = buildReasonAndComment(opts.outcome, opts.body);
  try {
    const result = await updateSchedulingMeetingBlockReason({
      filesRoot,
      taskId: ctx.kanbanTaskId,
      reason,
      comment,
      author: "joshu",
    });
    if (!result.ok) {
      console.warn(
        `[ea-scheduling] send followup failed task=${ctx.kanbanTaskId}: ${result.error ?? "unknown"}`,
      );
      return;
    }
    console.info(
      `[ea-scheduling] send followup task=${ctx.kanbanTaskId} outcome=${opts.outcome.kind} reason=${reason.slice(0, 120)}`,
    );
  } catch (err) {
    console.warn(
      `[ea-scheduling] send followup error task=${ctx.kanbanTaskId}: ${(err as Error).message}`,
    );
  }
}
