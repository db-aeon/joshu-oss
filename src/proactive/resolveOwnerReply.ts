/**
 * Proactive nudge reply → full Hermes chat (same pathway as normal SMS),
 * with resolve context so the companion acts on the Kanban card.
 */
import type { HermesApiRunner, HermesChatMessage } from "../hermesApi.js";
import { callKanbanBridge } from "../hermesKanbanBridge.js";
import { markdownSpeechPlaintext } from "../markdownSpeechPlaintext.js";
import { buildOwnerTimeSystemMessage } from "../ownerLocalTime.js";
import { parseProactiveTaskRef } from "./blockReason.js";
import { getProactiveHermesRunner } from "./composeMessage.js";
import { wakeProactiveTaskAfterOwnerReply } from "./replyRouter.js";
import { readProactiveState, writeProactiveState } from "./state.js";
import type { ProactiveLastNudge } from "./types.js";

export type ProactiveResolveContext = {
  taskId: string;
  board: string;
  title?: string;
  blockReason?: string | null;
  nudgeBody?: string;
};

function resolveTaskRef(opts: {
  body: string;
  projectRoot: string;
  taskId?: string;
  board?: string;
}): ProactiveResolveContext | null {
  const state = readProactiveState(opts.projectRoot);
  const ref = parseProactiveTaskRef(opts.body);
  const last = state.lastNudge;
  const taskId = (opts.taskId ?? ref?.taskId ?? last?.taskId)?.trim();
  const board = (opts.board ?? last?.board)?.trim();
  if (!taskId || !board) return null;
  return {
    taskId,
    board,
    title: last?.taskId === taskId ? last.title : undefined,
    blockReason: last?.taskId === taskId ? last.blockReason : undefined,
    nudgeBody: last?.taskId === taskId ? last.body : undefined,
  };
}

/** Short-lived Hermes session for proactive resolve — never reuse bloated SMS history. */
export function proactiveResolveSessionKey(taskId: string): string {
  const id = taskId.trim();
  return id ? `proactive:resolve:${id}` : "proactive:resolve:unknown";
}

/** Board → skill the resolve turn should load. */
function skillForBoard(board: string): string {
  if (board === "ea-scheduling") return "ea-scheduling";
  if (board === "ea-owner-reply") return "ea-owner-reply";
  if (board.startsWith("project-")) return "ea-project-kanban";
  return "joshu-proactive";
}

/**
 * Comment owner text onto the Kanban card and clear feedbackPending so the next
 * SMS is not forced into the proactive router. Does **not** unblock — Hermes resolve
 * (or fallback unblock) owns that.
 */
export async function prepareProactiveOwnerReply(opts: {
  body: string;
  projectRoot: string;
  taskId?: string;
  board?: string;
}): Promise<{ ok: true; context: ProactiveResolveContext } | { ok: false; reason: string }> {
  const context = resolveTaskRef(opts);
  if (!context) {
    return { ok: false, reason: "no_pending_nudge_ref" };
  }

  const comment = await callKanbanBridge({
    action: "comment",
    board: context.board,
    task_id: context.taskId,
    body: `## Owner reply (proactive nudge)\n\n${opts.body.trim()}`,
    author: "owner",
  });
  if (!comment.success) {
    return { ok: false, reason: comment.error ?? "comment_failed" };
  }

  const state = readProactiveState(opts.projectRoot);
  writeProactiveState({ ...state, feedbackPending: false }, opts.projectRoot);

  // Enrich title/blockReason from live card when lastNudge was for a different task.
  if (!context.title) {
    const shown = await callKanbanBridge({
      action: "show",
      board: context.board,
      task_id: context.taskId,
    });
    const task = shown.task as { title?: string; block_reason?: string } | undefined;
    if (task?.title) context.title = task.title;
    if (task?.block_reason) context.blockReason = task.block_reason;
  }

  return { ok: true, context };
}

/** System message injected into the usual SMS/jChat Hermes turn. */
export function buildProactiveResolveSystemMessage(
  context: ProactiveResolveContext,
  ownerText: string,
): HermesChatMessage {
  const skill = skillForBoard(context.board);
  const lines = [
    "The owner is replying to a proactive Joshu nudge about a blocked Kanban task.",
    "This is a normal conversation turn — be yourself (SOUL.md), not a routing bot.",
    "Interpret their reply, act on the task, and answer them naturally in SMS-friendly plain text.",
    "",
    `Board: ${context.board}`,
    `Task id: ${context.taskId}`,
    context.title ? `Title: ${context.title}` : null,
    context.blockReason ? `Block reason: ${context.blockReason}` : null,
    context.nudgeBody ? `Your outbound nudge was:\n${context.nudgeBody.slice(0, 500)}` : null,
    "",
    `Owner just said:\n${ownerText.trim().slice(0, 1000)}`,
    "",
    "REQUIRED:",
    `1. skill_view('joshu-proactive') — Resolve mode.`,
    `2. skill_view('${skill}') for board-specific rules.`,
    `3. kanban_show(board='${context.board}', task_id='${context.taskId}') — read card + the owner-reply comment already posted.`,
    "4. Do the work their reply authorizes (mail, schedule, file updates, complete/unblock/re-block as appropriate).",
    context.board.startsWith("project-")
      ? "4b. If this project track ties to ea-scheduling (thread_id / meeting_negotiation), load ea-scheduling, find the open meeting task, and send the authorized follow-up — do not only update project files."
      : null,
    "5. Reply to the owner with what you did or what you still need — conversational, not a status footer.",
    "Do not invent a thin 'got it, picking that up' ack without looking at the card.",
  ].filter((l): l is string => l !== null);

  return { role: "system", content: lines.join("\n") };
}

export type ResolveProactiveOwnerReplyResult = {
  ok: boolean;
  action: "resolved" | "fallback_routed" | "ignored" | "error";
  replyText?: string;
  reason?: string;
  taskId?: string;
  board?: string;
  schedulingWokenTaskIds?: string[];
};

/**
 * Preferred path: comment on card → full Hermes chat with resolve context → owner-facing reply.
 * Fallback: comment+unblock (legacy thin route) if Hermes is unavailable or fails.
 */
export async function resolveProactiveOwnerReply(opts: {
  body: string;
  filesRoot: string;
  projectRoot: string;
  sessionKey: string;
  baseSystemPrompt?: string;
  runner?: HermesApiRunner | null;
  taskId?: string;
  board?: string;
}): Promise<ResolveProactiveOwnerReplyResult> {
  const prepared = await prepareProactiveOwnerReply({
    body: opts.body,
    projectRoot: opts.projectRoot,
    taskId: opts.taskId,
    board: opts.board,
  });
  if (!prepared.ok) {
    return { ok: false, action: "ignored", reason: prepared.reason };
  }

  const runner = opts.runner ?? getProactiveHermesRunner();
  if (!runner) {
    const wake = await wakeProactiveTaskAfterOwnerReply({
      board: prepared.context.board,
      taskId: prepared.context.taskId,
      filesRoot: opts.filesRoot,
      ownerText: opts.body,
    });
    return {
      ok: wake.ok,
      action: wake.ok ? "fallback_routed" : "error",
      reason: wake.error ?? "no_hermes_runner",
      taskId: prepared.context.taskId,
      board: prepared.context.board,
      replyText: undefined,
      schedulingWokenTaskIds: wake.schedulingWokenTaskIds,
    };
  }

  const resolveSessionKey = proactiveResolveSessionKey(prepared.context.taskId);

  try {
    await runner.ensureGatewayReady();
    const messages: HermesChatMessage[] = [
      buildOwnerTimeSystemMessage(opts.projectRoot),
      {
        role: "system",
        content:
          opts.baseSystemPrompt?.trim() ||
          "You are Joshu on SMS with the box owner. Reply in concise plain text — no markdown, tables, or long URLs.",
      },
      buildProactiveResolveSystemMessage(prepared.context, opts.body),
      { role: "user", content: opts.body.trim() },
    ];

    const { finalText } = await runner.streamHermesChat(
      {
        sessionId: resolveSessionKey,
        sessionKey: resolveSessionKey,
        messages,
        signal: AbortSignal.timeout(180_000),
      },
      {},
    );

    const replyText = markdownSpeechPlaintext(finalText).trim();
    if (!replyText) {
      throw new Error("empty_resolve_reply");
    }

    return {
      ok: true,
      action: "resolved",
      replyText,
      taskId: prepared.context.taskId,
      board: prepared.context.board,
    };
  } catch (err) {
    console.warn(
      "[proactive-resolve] Hermes resolve failed, falling back to unblock:",
      err instanceof Error ? err.message : err,
    );
    // Comment already posted — wake the Kanban worker as safety net.
    const wake = await wakeProactiveTaskAfterOwnerReply({
      board: prepared.context.board,
      taskId: prepared.context.taskId,
      filesRoot: opts.filesRoot,
      ownerText: opts.body,
    });
    return {
      ok: wake.ok,
      action: wake.ok ? "fallback_routed" : "error",
      reason: err instanceof Error ? err.message : String(err),
      taskId: prepared.context.taskId,
      board: prepared.context.board,
      schedulingWokenTaskIds: wake.schedulingWokenTaskIds,
    };
  }
}

/** Expose last nudge shape for tests / debug. */
export type { ProactiveLastNudge };
