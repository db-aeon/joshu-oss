import { createHash, randomUUID } from "node:crypto";

import { cancelPendingHandoffsForKanbanTask } from "../browserHandoff/store.js";
import {
  callKanbanBridge,
  eaKanbanCreateDefaults,
  eaSchedulingKanbanAssignee,
  ensureRealtimeGoalsBoard,
  REALTIME_GOALS_KANBAN_BOARD,
} from "../hermesKanbanBridge.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import {
  isRepeatOfAnsweredQuestion,
  normalizeOwnerAnswer,
  ownerAnswerKanbanAppend,
  ownerUpdateKanbanAppend,
} from "./blockedAnswer.js";
import { autoRecoveryKanbanAppend, classifyBlockCause } from "./blockCause.js";
import { isContinuableGoal } from "./branchBinding.js";
import { collectHandoffUrls, formatOwnerCompletion } from "./ownerDelivery.js";
import { buildHermesBrokerContextMessage } from "./brokerContext.js";
import { isDeferCapableChannel, isQueueCapableChannel, usesSessionThread } from "./channelPolicy.js";
import {
  isExplicitCancelPhrase,
  routeRealtimeGoalMessage,
  type RouteRealtimeGoalMessageInput,
  type RouteRealtimeGoalMessageOptions,
  type RealtimeGoalRouteDecision,
} from "./router.js";
import { SessionThreadStore } from "./sessionThread.js";
import { RealtimeGoalStore } from "./store.js";
import {
  realtimeGoalSessionKey,
  type RealtimeGoalDeliveryHandler,
  type RealtimeGoalOrigin,
  type RealtimeGoalInboxRecord,
  type RealtimeGoalRecord,
  type RealtimeGoalRouteInput,
  type RealtimeGoalRouteResult,
  type RealtimeGoalSurfaceEvent,
  type RealtimeGoalVoiceCallbackOutcome,
} from "./types.js";
import { answeredByOutcome, isTerminalCallStatus } from "./voiceDeliveryPolicy.js";

const DEFAULT_RELEASE_DELAY_MS = 60_000;
const DEFAULT_POLL_MS = 5_000;
const MAX_DELIVERY_ATTEMPTS = 5;
/** How far back finished goals stay in Hermes' context for follow-up questions. */
const RECENT_RESULT_CONTEXT_MS = 6 * 60 * 60_000;
/**
 * Automatic worker restarts (system stall, or re-asking an answered question)
 * before the owner is told the truth. Reset whenever the owner answers.
 */
const MAX_AUTO_RECOVERIES = 2;

export type RealtimeGoalBrokerOptions = {
  /**
   * Called once when callbacks are parked (owner unreachable by phone), so the
   * owner can be nudged on another channel. Must not disclose results.
   */
  onCallbacksParked?: (goals: RealtimeGoalRecord[], reason: string) => Promise<void>;
};

/** Result of routing an owner utterance heard during a goal callback. */
export type RealtimeGoalCallbackReplyResult = {
  /** False → not about this goal; the voice session handles it as a normal turn. */
  handled: boolean;
  reply?: string;
  /** True when the goal is still waiting on the owner's answer. */
  awaitingReply?: boolean;
};

function isoNow(): string {
  return new Date().toISOString();
}

function releaseDelayMs(): number {
  const raw = Number.parseInt(process.env.JOSHU_REALTIME_GOALS_RELEASE_SECONDS ?? "", 10);
  const seconds = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RELEASE_DELAY_MS / 1000;
  return seconds * 1000;
}

function shortTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "Owner request";
  return firstLine.replace(/\s+/g, " ").slice(0, 100) || "Owner request";
}

function sourceMessageId(origin: RealtimeGoalOrigin): string {
  return origin.messageId?.trim() || randomUUID();
}

function idempotencyKey(origin: RealtimeGoalOrigin, sourceId: string): string {
  const digest = createHash("sha256")
    .update(`${realtimeGoalSessionKey(origin)}\n${sourceId}`)
    .digest("hex")
    .slice(0, 32);
  return `realtime-goal:v1:${digest}`;
}

/**
 * Intake reply for queued work. Phone callers get results by callback, so
 * "I'll reply here" would be wrong there; no trailing "Anything else?" on voice
 * either — the realtime model already asks, and a stacked prompt starts a loop.
 */
function queuedReply(channel?: RealtimeGoalOrigin["channel"]): string {
  if (channel === "pstn_voice") {
    return "That'll take a few minutes, so I'm working on it in the background. I'll call you back when it's done.";
  }
  return "This will take a little longer, so I queued it. I'll reply here when it's done. Anything else?";
}

function statusReply(goal: RealtimeGoalRecord): string {
  if (goal.status === "clarifying") return `I'm waiting on one detail for “${goal.title}.”`;
  if (goal.status === "queued" || goal.status === "releasing") {
    return `“${goal.title}” is queued and will start shortly.`;
  }
  if (goal.status === "blocked") {
    return goal.lastBlockReason
      ? `“${goal.title}” is waiting on: ${goal.lastBlockReason}`
      : `“${goal.title}” is waiting for input.`;
  }
  if (goal.status === "ready" || goal.status === "running") {
    return `I'm still working on “${goal.title}.” I'll get back to you when it's done.`;
  }
  // Terminal goals reach here when their result was parked and the owner asks for it.
  if (goal.status === "done") {
    return goal.resultSummary ? goal.resultSummary : `“${goal.title}” is done.`;
  }
  if (goal.status === "failed") {
    return goal.resultSummary ?? `I couldn't finish “${goal.title}.”`;
  }
  if (goal.status === "cancelled") return `“${goal.title}” was cancelled.`;
  return `“${goal.title}” is ${goal.status}.`;
}

/** Owner message once automatic recovery is exhausted. Their reply restarts the worker. */
function stalledOwnerMessage(goal: RealtimeGoalRecord): string {
  return (
    `I couldn't finish “${goal.title}” — the background worker kept stopping before it had a result. ` +
    `Say “try again” and I'll restart it, or “cancel” to drop it.`
  );
}

function markSourceHandled(
  goal: RealtimeGoalRecord,
  sourceId: string,
  reply: string,
  outcome: "clarify" | "queued" | "updated" | "cancelled" | "status" | "ack",
): void {
  goal.handledSourceIds ??= [goal.sourceMessageId];
  if (!goal.handledSourceIds.includes(sourceId)) {
    goal.handledSourceIds.push(sourceId);
    goal.sourceReceipts ??= [];
    goal.sourceReceipts.push({ sourceId, reply, outcome, at: isoNow() });
  }
  goal.intakeReply = reply;
  goal.ownerInteractedAt = isoNow();
}

function taskBody(goal: RealtimeGoalRecord): string {
  const ownerMessages = goal.messages
    .filter((message) => message.role === "owner")
    .map((message, index) => `${index === 0 ? "Original request" : `Update ${index}`} (${message.at}):\n${message.text}`)
    .join("\n\n");
  return [
    "# Realtime owner goal",
    "",
    `Goal ID: ${goal.id}`,
    `Origin channel: ${goal.origin.channel}`,
    "",
    "## Completion contract",
    "",
    `Objective: ${goal.objective}`,
    "",
    "Complete the owner's request safely. Use reasonable defaults for low-risk details.",
    "Before consequential external writes, follow the normal action guard.",
    "Re-read this task and recent comments before consequential actions and before completion.",
    "An \"Owner answer\" section answers your last kanban_block question: continue from there with that answer.",
    "Never ask the owner for anything already written on this card.",
    "If required owner input is missing, call kanban_block with one concise, specific question.",
    "Every run must end with kanban_complete or kanban_block — exiting without either is a failure.",
    "When checkout is staged with a browser handoff link, call kanban_complete with the link — do not kanban_block with an old menu.",
    "kanban_complete summary is sent to the owner as-is. Write it as a short text to them: itinerary, price, what they still enter, and the full handoff URL on its own line.",
    "Do not write \"the owner\", \"handed to the owner\", \"this run\", or \"at the handoff link\" without the URL.",
    "",
    "## Intake",
    "",
    ownerMessages,
  ].join("\n");
}

export class RealtimeGoalBroker {
  readonly store: RealtimeGoalStore;
  readonly threads: SessionThreadStore;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickRunning = false;
  private boardReady = false;

  constructor(
    readonly projectRoot: string,
    private readonly deliver: RealtimeGoalDeliveryHandler,
    private readonly routeMessage: (
      input: RouteRealtimeGoalMessageInput,
      options?: RouteRealtimeGoalMessageOptions,
    ) => Promise<RealtimeGoalRouteDecision> = routeRealtimeGoalMessage,
    private readonly options: RealtimeGoalBrokerOptions = {},
  ) {
    this.store = new RealtimeGoalStore(projectRoot);
    this.threads = new SessionThreadStore(projectRoot);
  }

  private threadKey(origin: RealtimeGoalOrigin): string {
    return origin.sessionKey.trim();
  }

  async recordOwnerTurn(origin: RealtimeGoalOrigin, text: string): Promise<void> {
    if (!usesSessionThread(origin.channel)) return;
    await this.threads.recordOwnerTurn(
      this.threadKey(origin),
      text,
      origin.messageId,
    );
  }

  async recordBoxTurn(
    origin: RealtimeGoalOrigin,
    text: string,
    source: "broker" | "delivery" | "hermes",
    goalId?: string,
  ): Promise<void> {
    if (!usesSessionThread(origin.channel)) return;
    await this.threads.recordBoxTurn(this.threadKey(origin), text, source, goalId);
  }

  /** Compact broker snapshot for Hermes pass turns on queue-capable channels. */
  async buildHermesContextSnapshot(origin: RealtimeGoalOrigin): Promise<string | undefined> {
    if (!isQueueCapableChannel(origin.channel)) return undefined;
    const session = realtimeGoalSessionKey(origin);
    const active = await this.store.listActiveForSession(session);
    const parked = await this.store.listParkedResultsForSession(session);
    const listed = new Set([...active, ...parked].map((goal) => goal.id));
    // Results the owner already heard still matter for follow-ups ("where did you
    // send the link?") — without them Hermes answers from stale memory.
    const recent = (
      await this.store.listRecentFinishedForSession(session, Date.now() - RECENT_RESULT_CONTEXT_MS)
    ).filter((goal) => !listed.has(goal.id));
    const threadTurns = await this.threads.getTurns(this.threadKey(origin));
    const activeBranch = await this.resolveActiveGoal(session, this.threadKey(origin));
    return buildHermesBrokerContextMessage([...active, ...parked], threadTurns, activeBranch, recent);
  }

  start(): void {
    if (this.timer) return;
    const raw = Number.parseInt(process.env.JOSHU_REALTIME_GOALS_POLL_MS ?? "", 10);
    const interval = Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_POLL_MS;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async route(input: RealtimeGoalRouteInput): Promise<RealtimeGoalRouteResult> {
    const text = input.text.trim();
    if (!text) return { action: "pass" };

    if (!isQueueCapableChannel(input.origin.channel)) {
      await this.recordOwnerTurn(input.origin, text);
      return { action: "pass" };
    }

    const session = realtimeGoalSessionKey(input.origin);
    const src = sourceMessageId(input.origin);
    await this.recordOwnerTurn(input.origin, text);
    const threadTurns = await this.threads.getTurns(this.threadKey(input.origin));

    const duplicate = await this.store.findBySource(session, src);
    if (duplicate) {
      const receipt = duplicate.sourceReceipts?.find((item) => item.sourceId === src);
      const replyText = receipt?.reply ?? duplicate.intakeReply;
      await this.recordBoxTurn(input.origin, replyText, "broker", duplicate.id);
      return {
        action: "reply",
        text: replyText,
        goalId: duplicate.id,
        outcome:
          receipt?.outcome ??
          (duplicate.status === "clarifying"
            ? "clarify"
            : duplicate.status === "cancelled"
              ? "cancelled"
              : "queued"),
      };
    }

    const active = await this.store.listActiveForSession(session);
    if (active.length > 1 && isExplicitCancelPhrase(text)) {
      const choices = active
        .slice(0, 4)
        .map((goal, index) => `${index + 1}) ${goal.title}`)
        .join("; ");
      const replyText = `Which queued job should I cancel? ${choices}. Say “cancel” and the title.`;
      await this.recordBoxTurn(input.origin, replyText, "broker");
      return {
        action: "reply",
        text: replyText,
        outcome: "status",
      };
    }

    const threadKey = this.threadKey(input.origin);
    const activeBranch = await this.resolveActiveGoal(session, threadKey);
    const queueCapable = isQueueCapableChannel(input.origin.channel);
    // Finished results the owner has not heard yet (parked callbacks). Visible to
    // the router so "any updates?" can pick them up; only status acts on them.
    const parkedResults = await this.store.listParkedResultsForSession(session);
    const routable = [...active, ...parkedResults];

    const admission = activeBranch
      ? await this.routeMessage({
          text,
          activeGoals: routable,
          threadTurns,
          queueCapable,
          activeBranch,
        })
      : await this.routeMessage({
          text,
          activeGoals: routable,
          threadTurns,
          queueCapable,
        });
    console.info(
      `[realtime-goals] decision=${admission.decision} confidence=${admission.confidence.toFixed(2)} channel=${input.origin.channel} bound=${Boolean(activeBranch)} reason=${admission.reason}`,
    );

    if (activeBranch && admission.decision === "update") {
      const continuation = await this.handleBranchContinuation(
        activeBranch,
        text,
        src,
        input.origin,
      );
      if (continuation) {
        await this.setActiveGoalPointer(input.origin, activeBranch.id);
        return continuation;
      }
    }

    if (activeBranch && admission.decision === "queue") {
      await this.clearActiveGoalPointer(input.origin);
    }

    if (admission.decision === "pass") return { action: "pass" };

    if (admission.decision === "ack" && admission.reply) {
      const anchor = admission.goalId
        ? active.find((goal) => goal.id === admission.goalId)
        : active[0];
      if (anchor) {
        await this.store.update(anchor.id, (goal) =>
          markSourceHandled(goal, src, admission.reply!, "ack"),
        );
      }
      await this.recordBoxTurn(input.origin, admission.reply, "broker", anchor?.id);
      return {
        action: "reply",
        text: admission.reply,
        goalId: anchor?.id,
        outcome: "ack",
      };
    }

    if (
      admission.decision === "cancel" &&
      admission.goalId &&
      active.some((goal) => goal.id === admission.goalId)
    ) {
      const cancelled = await this.cancel(admission.goalId, text);
      if (!cancelled) return { action: "pass" };
      const reply =
        cancelled.status === "cancelled"
          ? `Cancelled “${cancelled.title}.”`
          : `I'm still stopping “${cancelled.title}.” I won't deliver a completion while cancellation is pending.`;
      await this.store.update(cancelled.id, (goal) =>
        markSourceHandled(goal, src, reply, "cancelled"),
      );
      await this.recordBoxTurn(input.origin, reply, "broker", cancelled.id);
      return {
        action: "reply",
        text: reply,
        goalId: cancelled.id,
        outcome: "cancelled",
      };
    }

    const target = admission.goalId
      ? active.find((goal) => goal.id === admission.goalId)
      : undefined;
    const statusTarget =
      target ?? parkedResults.find((goal) => goal.id === admission.goalId);

    if (admission.decision === "status" && statusTarget) {
      const reply = statusReply(statusTarget);
      await this.store.update(statusTarget.id, (goal) =>
        markSourceHandled(goal, src, reply, "status"),
      );
      // Hearing a parked result on an authenticated channel is delivery.
      await this.store.markParkedResultDelivered(statusTarget.id);
      await this.recordBoxTurn(input.origin, reply, "broker", statusTarget.id);
      return {
        action: "reply",
        text: reply,
        goalId: statusTarget.id,
        outcome: "status",
      };
    }

    if (admission.decision === "update" && target) {
      const updated =
        target.status === "blocked"
          ? (await this.answerBlockedGoal(target.id, text, src)) ?? target
          : await this.appendOwnerUpdate(target, text, src);
      await this.recordBoxTurn(input.origin, updated.intakeReply, "broker", updated.id);
      return {
        action: "reply",
        text: updated.intakeReply,
        goalId: updated.id,
        outcome: "updated",
      };
    }

    if (admission.decision === "queue" && target?.status === "clarifying") {
      const queued = await this.store.update(target.id, (goal) => {
        if (goal.handledSourceIds?.includes(src)) return;
        goal.status = "queued";
        goal.objective = `${goal.objective}\n\nClarification: ${text}`;
        goal.releaseAt = new Date(Date.now() + releaseDelayMs()).toISOString();
        goal.clarificationQuestion = undefined;
        goal.messages.push({ at: isoNow(), role: "owner", text });
        markSourceHandled(goal, src, queuedReply(goal.origin.channel), "queued");
      });
      if (queued) {
        await this.recordBoxTurn(input.origin, queued.intakeReply, "broker", queued.id);
        return {
          action: "reply",
          text: queued.intakeReply,
          goalId: queued.id,
          outcome: "queued",
        };
      }
    }

    if (admission.decision === "clarify" && admission.question) {
      const reply = admission.question;
      if (target?.status === "clarifying") {
        const updated = await this.store.update(target.id, (goal) => {
          if (goal.handledSourceIds?.includes(src)) return;
          goal.objective = `${goal.objective}\n\nClarification answer: ${text}`;
          goal.messages.push({ at: isoNow(), role: "owner", text });
          goal.messages.push({ at: isoNow(), role: "broker", text: reply });
          goal.clarificationQuestion = reply;
          markSourceHandled(goal, src, reply, "clarify");
        });
        if (updated) {
          await this.recordBoxTurn(input.origin, reply, "broker", updated.id);
          return {
            action: "reply",
            text: reply,
            goalId: updated.id,
            outcome: "clarify",
          };
        }
      }
      const goal = await this.createGoal({
        origin: { ...input.origin, messageId: src },
        text,
        title: admission.title,
        status: "clarifying",
        intakeReply: reply,
        clarificationQuestion: reply,
      });
      await this.recordBoxTurn(input.origin, reply, "broker", goal.id);
      return { action: "reply", text: reply, goalId: goal.id, outcome: "clarify" };
    }

    if (admission.decision === "queue") {
      const goal = await this.createGoal({
        origin: { ...input.origin, messageId: src },
        text,
        title: admission.title,
        status: "queued",
        intakeReply: queuedReply(input.origin.channel),
      });
      await this.recordBoxTurn(input.origin, goal.intakeReply, "broker", goal.id);
      return {
        action: "reply",
        text: goal.intakeReply,
        goalId: goal.id,
        outcome: "queued",
      };
    }

    return { action: "pass" };
  }

  async reserveInbound(input: RealtimeGoalRouteInput): Promise<string> {
    const messageId = input.origin.messageId?.trim();
    if (!messageId) throw new Error("durable inbound reservation requires messageId");
    const id = `${input.origin.channel}:${messageId}`;
    const record: RealtimeGoalInboxRecord = {
      id,
      origin: input.origin,
      text: input.text.slice(0, 4_000),
      receivedAt: isoNow(),
    };
    await this.store.reserveInbound(record);
    return id;
  }

  async completeInbound(id: string): Promise<void> {
    await this.store.completeInbound(id);
  }

  /** Agent-callable fallback when a normal Hermes turn discovers the work is long. */
  async defer(input: RealtimeGoalRouteInput, title?: string): Promise<RealtimeGoalRecord> {
    if (!isDeferCapableChannel(input.origin.channel)) {
      throw new Error(`realtime_goal_defer is unavailable on channel ${input.origin.channel}`);
    }
    const src = sourceMessageId(input.origin);
    const session = realtimeGoalSessionKey(input.origin);
    const duplicate = await this.store.findBySource(session, src);
    if (duplicate) return duplicate;
    await this.recordOwnerTurn(input.origin, input.text);
    const goal = await this.createGoal({
      origin: { ...input.origin, messageId: src },
      text: input.text,
      title,
      status: "queued",
      intakeReply: queuedReply(input.origin.channel),
    });
    await this.recordBoxTurn(input.origin, goal.intakeReply, "broker", goal.id);
    return goal;
  }

  async cancel(goalId: string, reason = "Owner cancelled"): Promise<RealtimeGoalRecord | undefined> {
    const goal = await this.store.update(goalId, (item) => {
      item.status = item.kanbanTaskId ? "cancelling" : "cancelled";
      if (!item.kanbanTaskId) item.cancelledAt = isoNow();
      item.cancelReason = reason.slice(0, 500);
      item.delivery.state = "suppressed";
      item.intakeReply = item.kanbanTaskId
        ? `I'm stopping “${item.title}.”`
        : `Cancelled “${item.title}.”`;
    });
    if (!goal?.kanbanTaskId) {
      if (goal?.status === "cancelled") {
        await this.clearActiveGoalPointer(goal.origin);
      }
      return goal;
    }
    const cancelled = await this.retryCancellation(goal.id);
    if (cancelled?.status === "cancelled") {
      await this.clearActiveGoalPointer(cancelled.origin);
    }
    return cancelled;
  }

  private async retryCancellation(goalId: string): Promise<RealtimeGoalRecord | undefined> {
    const goal = await this.store.get(goalId);
    if (!goal) return undefined;
    if (!goal.kanbanTaskId) {
      return this.store.update(goalId, (item) => {
        item.status = "cancelled";
        item.cancelledAt ??= isoNow();
      });
    }
    const result = await callKanbanBridge({
      action: "cancel",
      board: REALTIME_GOALS_KANBAN_BOARD,
      task_id: goal.kanbanTaskId,
      reason: goal.cancelReason || "Owner cancelled",
    }).catch((error) => ({ success: false, error: (error as Error).message }));
    if (!result.success) {
      console.warn(
        `[realtime-goals] cancel task=${goal.kanbanTaskId} pending retry: ${result.error}`,
      );
      return this.store.update(goalId, (item) => {
        item.status = "cancelling";
      });
    }
    const handoffs = cancelPendingHandoffsForKanbanTask(this.projectRoot, goal.kanbanTaskId);
    if (handoffs.length > 0) {
      console.info(
        `[realtime-goals] cancelled ${handoffs.length} pending handoff(s) for task=${goal.kanbanTaskId}`,
      );
    }
    return this.store.update(goalId, (item) => {
      item.status = "cancelled";
      item.cancelledAt = isoNow();
      item.delivery.state = "suppressed";
      item.intakeReply = `Cancelled “${item.title}.”`;
    });
  }

  /**
   * Twilio status / async-AMD webhook for an outbound goal callback.
   *
   * "completed" is not proof of delivery — only the authenticated result ack
   * marks delivery. How an undelivered call is retried (or parked) is decided by
   * voiceDeliveryPolicy from the call's outcome.
   */
  async recordVoiceCallbackStatus(
    goalId: string,
    status: string,
    callSid: string,
    answeredBy?: string,
  ): Promise<void> {
    const machine = answeredByOutcome(answeredBy);
    if (machine) await this.recordVoiceCallbackOutcome(goalId, callSid, machine);
    const normalized = status.trim().toLowerCase();
    if (!isTerminalCallStatus(normalized)) return;
    const { settlement, parked } = await this.store.settleVoiceCallback({
      goalId,
      callSid,
      twilioStatus: normalized,
    });
    if (settlement) {
      console.info(
        `[realtime-goals] callback goal=${goalId} call=${callSid} status=${normalized} → ${settlement.action} (${settlement.reason})`,
      );
    }
    await this.notifyParked(parked, settlement?.reason);
  }

  /** voice-realtime (or AMD) reports how a callback went before/as it ends. */
  async recordVoiceCallbackOutcome(
    goalId: string,
    callSid: string,
    outcome: RealtimeGoalVoiceCallbackOutcome,
  ): Promise<void> {
    const { settlement, parked } = await this.store.settleVoiceCallback({
      goalId,
      callSid,
      outcome,
    });
    console.info(
      `[realtime-goals] callback goal=${goalId} call=${callSid} outcome=${outcome}` +
        (settlement ? ` → ${settlement.action}` : ""),
    );
    await this.notifyParked(parked, settlement?.reason);
  }

  private async notifyParked(parked: RealtimeGoalRecord[], reason?: string): Promise<void> {
    if (parked.length === 0 || !this.options.onCallbacksParked) return;
    await this.options.onCallbacksParked(parked, reason ?? "owner unreachable").catch((error) => {
      console.warn(`[realtime-goals] parked-callback notice failed: ${(error as Error).message}`);
    });
  }

  async markVoiceDelivered(goalId: string): Promise<void> {
    await this.store.update(goalId, (goal) => {
      goal.delivery.state = "delivered";
      goal.delivery.deliveredAt = isoNow();
      goal.delivery.nextAttemptAt = undefined;
      goal.delivery.attemptLeaseUntil = undefined;
      goal.delivery.lastError = undefined;
    });
  }

  async answerBlockedGoal(
    goalId: string,
    text: string,
    sourceId: string,
  ): Promise<RealtimeGoalRecord | undefined> {
    const goal = await this.store.get(goalId);
    if (!goal) return undefined;
    const receipt = goal.sourceReceipts?.find((item) => item.sourceId === sourceId);
    if (receipt) return { ...goal, intakeReply: receipt.reply };
    if (goal.status !== "blocked") return undefined;
    return this.appendOwnerUpdate(goal, text, sourceId);
  }

  /**
   * Route an utterance heard right after a callback asked a blocked question.
   *
   * The owner may answer, but may also ask for status ("did you find them?"),
   * cancel, or start something unrelated. Only a real answer is written to the
   * card; everything else is handled like any other bound-branch turn.
   */
  async answerFromCallback(
    goalId: string,
    text: string,
    sourceId: string,
  ): Promise<RealtimeGoalCallbackReplyResult> {
    const goal = await this.store.get(goalId);
    if (!goal) return { handled: false };
    const receipt = goal.sourceReceipts?.find((item) => item.sourceId === sourceId);
    if (receipt) return { handled: true, reply: receipt.reply };
    if (goal.status !== "blocked") return { handled: false };

    const origin: RealtimeGoalOrigin = { ...goal.origin, messageId: sourceId };
    const decision = await this.routeMessage({
      text,
      activeGoals: [goal],
      threadTurns: await this.threads.getTurns(this.threadKey(origin)),
      queueCapable: true,
      activeBranch: goal,
    });
    console.info(
      `[realtime-goals] callback reply goal=${goal.id} decision=${decision.decision} reason=${decision.reason}`,
    );
    // The owner was just asked this question: when the router is unavailable,
    // treating the reply as the answer is the safe default.
    const routerDown = decision.reason.startsWith("router_");

    let result: RealtimeGoalCallbackReplyResult;
    if (decision.decision === "status") {
      result = { handled: true, reply: statusReply(goal), awaitingReply: true };
    } else if (decision.decision === "cancel") {
      const cancelled = await this.cancel(goal.id, text);
      result = { handled: true, reply: cancelled?.intakeReply ?? `Cancelled “${goal.title}.”` };
    } else if (decision.decision === "ack" && decision.reply) {
      result = { handled: true, reply: decision.reply };
    } else if (decision.decision === "update" || routerDown) {
      const answered = await this.answerBlockedGoal(goal.id, text, sourceId);
      result = answered
        ? { handled: true, reply: answered.intakeReply }
        : { handled: false };
    } else {
      // pass / queue: not about this goal — the voice session runs a normal turn
      // (which records the owner turn itself).
      return { handled: false };
    }
    if (!result.handled) return result;
    await this.recordOwnerTurn(origin, text);
    if (result.reply) await this.recordBoxTurn(origin, result.reply, "broker", goal.id);
    return result;
  }

  async listSurfaceEvents(sessionKey: string): Promise<RealtimeGoalSurfaceEvent[]> {
    const state = await this.store.read();
    return state.goals
      .filter((goal) => goal.origin.sessionKey === sessionKey)
      .flatMap((goal) => goal.surfaceEvents ?? [])
      .filter((event) => !event.consumedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async consumeSurfaceEvent(sessionKey: string, eventId: string): Promise<boolean> {
    const state = await this.store.read();
    const goal = state.goals.find(
      (item) =>
        item.origin.sessionKey === sessionKey &&
        item.surfaceEvents?.some((event) => event.id === eventId && !event.consumedAt),
    );
    if (!goal) return false;
    await this.store.update(goal.id, (item) => {
      const event = item.surfaceEvents?.find((candidate) => candidate.id === eventId);
      if (event && !event.consumedAt) event.consumedAt = isoNow();
    });
    return true;
  }

  private async setActiveGoalPointer(
    origin: RealtimeGoalOrigin,
    goalId: string,
  ): Promise<void> {
    if (!usesSessionThread(origin.channel)) return;
    await this.threads.setActiveGoal(this.threadKey(origin), goalId);
  }

  private async clearActiveGoalPointer(origin: RealtimeGoalOrigin): Promise<void> {
    if (!usesSessionThread(origin.channel)) return;
    await this.threads.clearActiveGoal(this.threadKey(origin));
  }

  /** Resolve the open branch on this trunk via activeGoalId only (no silent re-bind). */
  private async resolveActiveGoal(
    session: string,
    threadKey: string,
  ): Promise<RealtimeGoalRecord | undefined> {
    const pointer = await this.threads.getActiveGoal(threadKey);
    if (!pointer) return undefined;

    const goal = await this.store.get(pointer.goalId);
    if (goal && realtimeGoalSessionKey(goal.origin) === session) {
      if (isContinuableGoal(goal, pointer.setAt)) {
        return goal;
      }
    }
    await this.threads.clearActiveGoal(threadKey);
    return undefined;
  }

  private async handleBranchContinuation(
    goal: RealtimeGoalRecord,
    text: string,
    sourceId: string,
    origin: RealtimeGoalOrigin,
  ): Promise<RealtimeGoalRouteResult | undefined> {
    if (goal.status === "cancelled" || goal.status === "failed") {
      await this.clearActiveGoalPointer(origin);
      return undefined;
    }

    if (goal.status === "done") {
      return this.reopenContinuableGoal(goal, text, sourceId, origin);
    }

    const updated =
      goal.status === "blocked"
        ? (await this.answerBlockedGoal(goal.id, text, sourceId)) ?? goal
        : await this.appendOwnerUpdate(goal, text, sourceId);

    await this.recordBoxTurn(origin, updated.intakeReply, "broker", updated.id);
    return {
      action: "reply",
      text: updated.intakeReply,
      goalId: updated.id,
      outcome:
        updated.status === "queued" && goal.status === "clarifying" ? "queued" : "updated",
    };
  }

  private async reopenContinuableGoal(
    goal: RealtimeGoalRecord,
    text: string,
    sourceId: string,
    origin: RealtimeGoalOrigin,
  ): Promise<RealtimeGoalRouteResult | undefined> {
    if (!isContinuableGoal(goal)) {
      await this.clearActiveGoalPointer(origin);
      return undefined;
    }

    const reply = this.ownerUpdateReply(goal, text, false, false);
    let applied = false;
    const updated = await this.store.update(goal.id, (item) => {
      if (item.handledSourceIds?.includes(sourceId)) return;
      applied = true;
      item.messages.push({ at: isoNow(), role: "owner", text });
      item.objective = `${item.objective}\n\nOwner update: ${text}`;
      item.status = item.kanbanTaskId ? "ready" : "queued";
      if (!item.kanbanTaskId) {
        item.releaseAt = new Date(Date.now() + releaseDelayMs()).toISOString();
      }
      markSourceHandled(item, sourceId, reply, "updated");
      if (item.kanbanTaskId) {
        item.pendingOwnerUpdates ??= [];
        item.pendingOwnerUpdates.push({
          sourceId,
          text,
          at: isoNow(),
          fromBlockedAnswer: false,
        });
      }
    });
    if (!updated) return undefined;

    const receipt = updated.sourceReceipts?.find((item) => item.sourceId === sourceId);
    const replyText = receipt?.reply ?? updated.intakeReply;

    if (applied && updated.kanbanTaskId) {
      await callKanbanBridge({
        action: "reopen",
        board: REALTIME_GOALS_KANBAN_BOARD,
        task_id: updated.kanbanTaskId,
      }).catch((error) => {
        console.warn(
          `[realtime-goals] reopen task=${updated.kanbanTaskId} failed: ${(error as Error).message}`,
        );
      });
      const flushed = await this.flushOwnerUpdates(updated.id).catch(() => false);
      if (!flushed) {
        const fallback = await this.store.update(updated.id, (item) => {
          item.intakeReply =
            `I saved that update for “${item.title}” and will keep retrying the worker handoff.`;
          const itemReceipt = item.sourceReceipts?.find((entry) => entry.sourceId === sourceId);
          if (itemReceipt) itemReceipt.reply = item.intakeReply;
        });
        if (fallback) {
          await this.recordBoxTurn(origin, fallback.intakeReply, "broker", fallback.id);
          return {
            action: "reply",
            text: fallback.intakeReply,
            goalId: fallback.id,
            outcome: "updated",
          };
        }
      }
    }

    const finalGoal = (await this.store.get(updated.id)) ?? updated;
    await this.recordBoxTurn(origin, replyText, "broker", finalGoal.id);
    return {
      action: "reply",
      text: replyText,
      goalId: finalGoal.id,
      outcome: "updated",
    };
  }

  private async createGoal(input: {
    origin: RealtimeGoalOrigin;
    text: string;
    title?: string;
    status: "clarifying" | "queued";
    intakeReply: string;
    clarificationQuestion?: string;
  }): Promise<RealtimeGoalRecord> {
    const now = isoNow();
    const src = sourceMessageId(input.origin);
    const goal: RealtimeGoalRecord = {
      id: randomUUID(),
      version: 1,
      title: input.title?.trim().slice(0, 120) || shortTitle(input.text),
      objective: input.text,
      status: input.status,
      origin: { ...input.origin, messageId: src },
      sourceMessageId: src,
      handledSourceIds: [src],
      idempotencyKey: idempotencyKey(input.origin, src),
      createdAt: now,
      updatedAt: now,
      ownerInteractedAt: now,
      ...(input.status === "queued"
        ? { releaseAt: new Date(Date.now() + releaseDelayMs()).toISOString() }
        : {}),
      ...(input.clarificationQuestion
        ? { clarificationQuestion: input.clarificationQuestion }
        : {}),
      messages: [{ at: now, role: "owner", text: input.text }],
      intakeReply: input.intakeReply,
      sourceReceipts: [
        {
          sourceId: src,
          reply: input.intakeReply,
          outcome: input.status === "clarifying" ? "clarify" : "queued",
          at: now,
        },
      ],
      delivery: { state: "pending", attempts: 0 },
    };
    const inserted = await this.store.insert(goal);
    await this.setActiveGoalPointer(input.origin, inserted.id);
    return inserted;
  }

  private ownerUpdateReply(
    target: RealtimeGoalRecord,
    text: string,
    wasBlocked: boolean,
    wasClarifying: boolean,
  ): string {
    if (wasBlocked) {
      return `Got it — I'll continue “${target.title}” with that and get back to you when it's done.`;
    }
    // Clarifying goals have no Kanban worker yet — be honest that work is queued.
    if (wasClarifying) {
      return queuedReply(target.origin.channel);
    }
    if (target.status === "running") {
      return `Got it — noted for “${target.title}.” I'm still on it and will work that in.`;
    }
    // Background work: never imply the owner should hold for it.
    return `Got it — I added that to “${target.title}.” I'll get back to you when it's ready.`;
  }

  private async appendOwnerUpdate(
    target: RealtimeGoalRecord,
    text: string,
    sourceId: string,
  ): Promise<RealtimeGoalRecord> {
    const wasBlocked = target.status === "blocked";
    const wasClarifying = target.status === "clarifying";
    const reply = this.ownerUpdateReply(target, text, wasBlocked, wasClarifying);
    let applied = false;
    const updated = await this.store.update(target.id, (goal) => {
      if (goal.handledSourceIds?.includes(sourceId)) return;
      applied = true;
      goal.messages.push({ at: isoNow(), role: "owner", text });
      goal.objective = `${goal.objective}\n\nOwner update: ${text}`;
      markSourceHandled(
        goal,
        sourceId,
        reply,
        wasClarifying ? "queued" : "updated",
      );
      if (goal.kanbanTaskId) {
        goal.pendingOwnerUpdates ??= [];
        goal.pendingOwnerUpdates.push({
          sourceId,
          text,
          at: isoNow(),
          fromBlockedAnswer: wasBlocked,
          ...(wasBlocked && goal.lastBlockReason
            ? { answeredQuestion: goal.lastBlockReason }
            : {}),
        });
      }
      if (goal.status === "clarifying") {
        // Owner answered the broker's clarification — enter the commit window.
        goal.status = "queued";
        goal.releaseAt = new Date(Date.now() + releaseDelayMs()).toISOString();
        goal.clarificationQuestion = undefined;
      }
      if (goal.status === "blocked") {
        const now = isoNow();
        goal.blockedAnsweredAt = now;
        goal.lastBlockedPrompt = goal.lastBlockReason;
        goal.lastOwnerAnswer = normalizeOwnerAnswer(text);
        goal.autoRecoveries = 0;
        goal.status = goal.kanbanTaskId ? "ready" : "queued";
        goal.lastKanbanStatus = goal.kanbanTaskId ? "ready" : undefined;
        goal.lastBlockReason = undefined;
        // The owner heard the question and answered it: that is delivery, even
        // if the callback's playback ack never arrived. Stops redials of it.
        if (goal.delivery.state !== "suppressed") {
          goal.delivery.state = "delivered";
          goal.delivery.deliveredAt ??= now;
          goal.delivery.nextAttemptAt = undefined;
          goal.delivery.attemptLeaseUntil = undefined;
        }
      }
    });
    if (!updated) return target;
    if (!applied) return updated;
    if (updated.kanbanTaskId) {
      const flushed = await this.flushOwnerUpdates(updated.id, wasBlocked).catch(() => false);
      if (!flushed) {
        return (
          (await this.store.update(updated.id, (goal) => {
            goal.intakeReply =
              `I saved that update for “${goal.title}” and will keep retrying the worker handoff.`;
            const receipt = goal.sourceReceipts?.find((item) => item.sourceId === sourceId);
            if (receipt) receipt.reply = goal.intakeReply;
          })) ?? updated
        );
      }
    }
    return (await this.store.get(updated.id)) ?? updated;
  }

  private async flushOwnerUpdates(goalId: string, forceUnblock = false): Promise<boolean> {
    const goal = await this.store.get(goalId);
    if (!goal?.kanbanTaskId || !goal.pendingOwnerUpdates?.length) return true;
    const applied: string[] = [];
    for (const update of goal.pendingOwnerUpdates) {
      const append = update.fromBlockedAnswer
        ? ownerAnswerKanbanAppend({
            text: update.text,
            at: update.at,
            sourceId: update.sourceId,
            question: update.answeredQuestion,
          })
        : ownerUpdateKanbanAppend(update.text, update.at, update.sourceId);
      const appended = await callKanbanBridge({
        action: "append_body",
        board: REALTIME_GOALS_KANBAN_BOARD,
        task_id: goal.kanbanTaskId,
        append,
      });
      if (!appended.success) return false;
      applied.push(update.sourceId);
    }
    const shouldUnblock = forceUnblock || goal.lastKanbanStatus === "blocked";
    if (shouldUnblock) {
      const unblocked = await callKanbanBridge({
        action: "unblock",
        board: REALTIME_GOALS_KANBAN_BOARD,
        task_id: goal.kanbanTaskId,
      });
      if (!unblocked.success) return false;
    }
    await this.store.update(goalId, (item) => {
      item.pendingOwnerUpdates = (item.pendingOwnerUpdates ?? []).filter(
        (update) => !applied.includes(update.sourceId),
      );
      if (shouldUnblock) {
        item.status = "ready";
        item.lastKanbanStatus = "ready";
        return;
      }
      // Append-only on a terminal task: wake reconciliation without clearing the
      // done cursor (prevents re-sending an old completion summary on the next tick).
      if (item.lastKanbanStatus === "done" || item.lastKanbanStatus === "archived") {
        item.status = "running";
        return;
      }
      item.status = "ready";
    });
    return true;
  }

  async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.recoverStaleInbound();
      const outstanding = await this.store.listOutstanding();
      if (outstanding.length === 0) return;
      await this.ensureBoard();
      for (const goal of outstanding) {
        if (goal.status === "cancelled") {
          await this.reconcileCancelledTombstone(goal);
          continue;
        }
        if (goal.status === "cancelling") {
          await this.retryCancellation(goal.id);
          continue;
        }
        if (goal.pendingOwnerUpdates?.length) {
          const forceUnblock = goal.pendingOwnerUpdates.some((update) => update.fromBlockedAnswer);
          const flushed = await this.flushOwnerUpdates(goal.id, forceUnblock).catch(() => false);
          if (!flushed) continue;
        }
        if (
          (goal.status === "queued" || goal.status === "releasing") &&
          goal.releaseAt &&
          Date.parse(goal.releaseAt) <= Date.now()
        ) {
          await this.release(goal);
          continue;
        }
        if (goal.kanbanTaskId) await this.reconcileTask(goal);
      }
    } catch (error) {
      console.warn(`[realtime-goals] lifecycle tick failed: ${(error as Error).message}`);
    } finally {
      this.tickRunning = false;
    }
  }

  private async reconcileCancelledTombstone(goal: RealtimeGoalRecord): Promise<void> {
    if (goal.kanbanTaskId || goal.cancellationReconciledAt) return;
    const found = await callKanbanBridge({
      action: "find_by_idempotency",
      board: REALTIME_GOALS_KANBAN_BOARD,
      idempotency_key: goal.idempotencyKey,
      include_archived: true,
    });
    const taskId = found.task?.task_id;
    if (!found.success || !taskId) {
      await this.store.update(goal.id, (item) => {
        item.cancellationReconciledAt = isoNow();
      });
      return;
    }
    await this.store.update(goal.id, (item) => {
      item.kanbanTaskId = taskId;
      item.status = "cancelling";
    });
    await this.retryCancellation(goal.id);
  }

  private async recoverStaleInbound(): Promise<void> {
    const stale = await this.store.listStaleInbound(2 * 60_000);
    for (const inbound of stale) {
      // Twilio was ACKed only after this reservation. If the process died
      // before handling it, make the loss visible and ask for a safe replay.
      if (inbound.origin.channel !== "sms") continue;
      const now = isoNow();
      const synthetic: RealtimeGoalRecord = {
        id: inbound.id,
        version: 1,
        title: "Interrupted SMS",
        objective: inbound.text,
        status: "failed",
        origin: inbound.origin,
        sourceMessageId: inbound.origin.messageId || inbound.id,
        idempotencyKey: `recovery:${inbound.id}`,
        createdAt: inbound.receivedAt,
        updatedAt: now,
        ownerInteractedAt: inbound.receivedAt,
        messages: [{ at: inbound.receivedAt, role: "owner", text: inbound.text }],
        intakeReply: "",
        delivery: { state: "pending", attempts: 0 },
      };
      const preview = inbound.text.replace(/\s+/g, " ").slice(0, 160);
      const result = await this.deliver(
        synthetic,
        `I restarted before I could finish processing this text: “${preview}”. Please resend it.`,
        "failed",
      ).catch(() => ({ delivered: false }));
      if (result.delivered) await this.store.markInboundRecoveryNotified(inbound.id);
    }
  }

  private async ensureBoard(): Promise<void> {
    if (this.boardReady) return;
    const filesRoot = resolveJoshuFilesPaths(this.projectRoot)?.filesRoot;
    if (!filesRoot) throw new Error("JOSHU_FILES_ROOT unavailable");
    const result = await ensureRealtimeGoalsBoard(filesRoot);
    if (!result.success) throw new Error(result.error || "could not ensure realtime-goals board");
    this.boardReady = true;
  }

  private async release(goal: RealtimeGoalRecord): Promise<void> {
    const claimed = await this.store.update(goal.id, (item) => {
      if (item.status === "queued") item.status = "releasing";
    });
    if (!claimed || claimed.status === "cancelled") return;
    const filesRoot = resolveJoshuFilesPaths(this.projectRoot)?.filesRoot;
    if (!filesRoot) return;

    const result = await callKanbanBridge({
      action: "create",
      board: REALTIME_GOALS_KANBAN_BOARD,
      title: claimed.title,
      body: taskBody(claimed),
      assignee: eaSchedulingKanbanAssignee(),
      idempotency_key: claimed.idempotencyKey,
      strict_idempotency: true,
      skills: ["realtime-goal"],
      workspace_kind: "dir",
      workspace_path: filesRoot,
      ...eaKanbanCreateDefaults(REALTIME_GOALS_KANBAN_BOARD),
    });
    if (!result.success || !result.task_id) {
      await this.store.update(goal.id, (item) => {
        if (item.status === "releasing") item.status = "queued";
      });
      throw new Error(result.error || "Kanban create failed");
    }
    const finalized = await this.store.update(goal.id, (item) => {
      item.kanbanTaskId = result.task_id;
      item.lastKanbanStatus = result.task?.status;
      if (item.status !== "cancelled" && item.status !== "cancelling") {
        item.status = (result.task?.status as RealtimeGoalRecord["status"]) || "ready";
      }
    });
    if (finalized?.status === "cancelled" || finalized?.status === "cancelling") {
      // Cancellation may win while create_task is in flight. Preserve the
      // cancelled state and immediately stop/archive the task that appeared.
      await this.store.update(goal.id, (item) => {
        item.status = "cancelling";
      });
      await this.retryCancellation(goal.id);
      return;
    }
    console.info(`[realtime-goals] released goal=${goal.id} task=${result.task_id}`);
  }

  private async reconcileTask(goal: RealtimeGoalRecord): Promise<void> {
    const result = await callKanbanBridge({
      action: "show",
      board: REALTIME_GOALS_KANBAN_BOARD,
      task_id: goal.kanbanTaskId,
      include_activity: true,
      include_run: true,
    });
    const task = result.task;
    if (!result.success || !task?.status) return;
    const status = task.status;

    if (status === "blocked") {
      const cause = classifyBlockCause(task);
      if (cause.kind === "system") {
        // Hermes parked the task (crash / timeout / exit without complete or
        // block). There is no question to ask — restart the worker a bounded
        // number of times, then tell the owner plainly (once).
        const stalled = stalledOwnerMessage(goal);
        const alreadyEscalated = goal.lastBlockReason === stalled;
        if (
          !alreadyEscalated &&
          (await this.autoRecover(
            goal,
            `the previous worker run stopped without kanban_complete or kanban_block (${cause.detail})`,
          ))
        ) {
          return;
        }
        await this.deliverBlockedPrompt(goal, stalled);
        return;
      }
      const question = cause.question;
      const alreadyAsked = goal.lastBlockReason === question;
      if (!alreadyAsked && goal.lastOwnerAnswer && isRepeatOfAnsweredQuestion(goal, question)) {
        // The owner already answered this; nudge the worker instead of re-asking.
        const recovered = await this.autoRecover(
          goal,
          "you asked the owner a question they already answered",
          { question, answer: goal.lastOwnerAnswer },
        );
        if (recovered) return;
      }
      await this.deliverBlockedPrompt(goal, question);
      return;
    }

    if (status === "done") {
      if (goal.status === "cancelled" || goal.delivery.state === "suppressed") return;
      const newCompletion = goal.lastKanbanStatus !== "done";
      const run = task.latest_run;
      const rawSummary =
        run?.summary?.trim() ||
        task.completion_summary?.trim() ||
        task.recent_comments?.at(-1)?.body?.trim() ||
        `Completed “${goal.title}.”`;
      const summary = formatOwnerCompletion(
        rawSummary,
        collectHandoffUrls(this.projectRoot, task, rawSummary),
      );
      await this.store.update(goal.id, (item) => {
        item.status = "done";
        item.lastKanbanStatus = "done";
        item.resultSummary = summary;
        if (newCompletion) {
          item.delivery.state = "pending";
          item.delivery.attempts = 0;
          item.delivery.nextAttemptAt = undefined;
        }
      });
      const shouldDeliver =
        newCompletion ||
        (goal.delivery.state !== "delivered" && goal.delivery.state !== "parked");
      if (shouldDeliver) {
        await this.deliverAndRecord(goal.id, summary, "completed");
      }
      await this.clearActiveGoalPointer(goal.origin);
      return;
    }

    if (status === "archived") {
      if (goal.status === "cancelled" || goal.delivery.state === "suppressed") return;
      const message =
        task.latest_run?.error?.trim() ||
        task.latest_run?.summary?.trim() ||
        `I couldn't finish “${goal.title}.”`;
      const newFailure = goal.lastKanbanStatus !== "archived";
      await this.store.update(goal.id, (item) => {
        item.status = "failed";
        item.lastKanbanStatus = "archived";
        item.resultSummary = message;
        if (newFailure) {
          item.delivery.state = "pending";
          item.delivery.attempts = 0;
          item.delivery.nextAttemptAt = undefined;
        }
      });
      const shouldDeliver =
        newFailure ||
        (goal.delivery.state !== "delivered" && goal.delivery.state !== "parked");
      if (shouldDeliver) {
        await this.deliverAndRecord(goal.id, message, "failed");
      }
      await this.clearActiveGoalPointer(goal.origin);
      return;
    }

    await this.store.update(goal.id, (item) => {
      item.lastKanbanStatus = status;
      item.status = status === "running" ? "running" : "ready";
    });
  }

  /** Deliver a blocked question once per distinct question (retries until delivered). */
  private async deliverBlockedPrompt(goal: RealtimeGoalRecord, question: string): Promise<void> {
    const questionChanged =
      goal.lastKanbanStatus !== "blocked" || goal.lastBlockReason !== question;
    if (questionChanged) {
      await this.store.update(goal.id, (item) => {
        item.status = "blocked";
        item.lastKanbanStatus = "blocked";
        item.lastBlockReason = question;
        item.delivery.state = "pending";
        item.delivery.attempts = 0;
        item.delivery.nextAttemptAt = undefined;
        item.delivery.lastDeliveredKey = undefined;
      });
      await this.setActiveGoalPointer(goal.origin, goal.id);
      await this.deliverAndRecord(goal.id, question, "blocked");
      return;
    }
    if (goal.delivery.state === "pending" || goal.delivery.state === "attempting") {
      await this.deliverAndRecord(goal.id, question, "blocked");
    }
  }

  /**
   * Restart a blocked worker without involving the owner: append a recovery
   * note to the card, then unblock. Returns false once the budget is spent
   * (the caller then tells the owner). Transient bridge errors return true so
   * the next tick retries instead of paging the owner.
   */
  private async autoRecover(
    goal: RealtimeGoalRecord,
    why: string,
    ownerAnswer?: { question?: string; answer: string },
  ): Promise<boolean> {
    const used = goal.autoRecoveries ?? 0;
    if (used >= MAX_AUTO_RECOVERIES || !goal.kanbanTaskId) {
      console.warn(
        `[realtime-goals] auto-recovery exhausted goal=${goal.id} task=${goal.kanbanTaskId} (${why})`,
      );
      return false;
    }
    const attempt = used + 1;
    const append = autoRecoveryKanbanAppend({
      at: isoNow(),
      attempt,
      maxAttempts: MAX_AUTO_RECOVERIES,
      why,
      ownerAnswer,
    });
    const bridgeFailed = (error: unknown) => ({
      success: false,
      error: (error as Error).message,
    });
    const appended = await callKanbanBridge({
      action: "append_body",
      board: REALTIME_GOALS_KANBAN_BOARD,
      task_id: goal.kanbanTaskId,
      append,
    }).catch(bridgeFailed);
    if (!appended.success) {
      console.warn(`[realtime-goals] auto-recovery append failed goal=${goal.id}: ${appended.error}`);
      return true;
    }
    const unblocked = await callKanbanBridge({
      action: "unblock",
      board: REALTIME_GOALS_KANBAN_BOARD,
      task_id: goal.kanbanTaskId,
    }).catch(bridgeFailed);
    if (!unblocked.success) {
      console.warn(`[realtime-goals] auto-recovery unblock failed goal=${goal.id}: ${unblocked.error}`);
      return true;
    }
    await this.store.update(goal.id, (item) => {
      item.autoRecoveries = attempt;
      item.status = "ready";
      item.lastKanbanStatus = "ready";
    });
    console.info(
      `[realtime-goals] auto-recovered goal=${goal.id} task=${goal.kanbanTaskId} attempt=${attempt}/${MAX_AUTO_RECOVERIES} (${why})`,
    );
    return true;
  }

  private async deliverAndRecord(
    goalId: string,
    text: string,
    kind: "blocked" | "completed" | "failed",
  ): Promise<void> {
    const claim = await this.store.claimDeliveryAttempt(
      goalId,
      kind,
      text,
      MAX_DELIVERY_ATTEMPTS,
    );
    if (!claim.claimed || !claim.goal) return;

    const goal = claim.goal;
    if (
      goal.origin.channel === "jchat" ||
      goal.origin.channel === "agui" ||
      goal.origin.channel === "browser_voice"
    ) {
      const alreadyQueued = goal.surfaceEvents?.some(
        (event) => event.kind === kind && event.text === text && !event.consumedAt,
      );
      if (!alreadyQueued) {
        await this.store.update(goalId, (item) => {
          item.surfaceEvents ??= [];
          item.surfaceEvents.push({
            id: randomUUID(),
            kind,
            text,
            createdAt: isoNow(),
          });
        });
      }
    }

    const result: Awaited<ReturnType<RealtimeGoalDeliveryHandler>> = await this.deliver(
      goal,
      text,
      kind,
    ).catch((error) => ({
      delivered: false,
      error: (error as Error).message,
    }));
    await this.store.finalizeDeliveryAttempt(
      goalId,
      claim.contentKey,
      result,
      MAX_DELIVERY_ATTEMPTS,
    );
    if (result.delivered) {
      await this.recordBoxTurn(goal.origin, text, "delivery", goal.id);
    }
  }
}
