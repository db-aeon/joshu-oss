import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import {
  isRealtimeGoalActive,
  realtimeGoalSessionKey,
  type RealtimeGoalDeliveryKind,
  type RealtimeGoalInboxRecord,
  type RealtimeGoalRecord,
  type RealtimeGoalState,
  type RealtimeGoalVoiceCallbackOutcome,
} from "./types.js";
import {
  CALLBACK_GAP_MS,
  CALLBACK_IN_FLIGHT_HOLD_MS,
  PARKED_SESSION_HOLD_MS,
  settleUndeliveredCallback,
  usesExclusiveCallback,
  type VoiceCallbackSettlement,
} from "./voiceDeliveryPolicy.js";

/** Delivery states that end automatic delivery for the current content. */
function deliveryFinished(goal: RealtimeGoalRecord): boolean {
  const state = goal.delivery.state;
  return state === "delivered" || state === "suppressed" || state === "parked";
}

function setCallbackHold(state: RealtimeGoalState, session: string, untilMs: number): void {
  state.callbackCooldowns ??= {};
  state.callbackCooldowns[session] = new Date(untilMs).toISOString();
}

const DELIVERY_LEASE_MS = 2 * 60_000;

/** Hash kind+text so duplicate completion SMS can be suppressed idempotently. */
export function realtimeGoalDeliveryContentKey(
  kind: RealtimeGoalDeliveryKind,
  text: string,
): string {
  return createHash("sha256").update(`${kind}\n${text}`).digest("hex").slice(0, 32);
}

const EMPTY_STATE: RealtimeGoalState = { version: 1, goals: [] };

function stateDirectory(projectRoot: string): string {
  const explicit = process.env.JOSHU_REALTIME_GOALS_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const filesRoot = resolveJoshuFilesPaths(projectRoot)?.filesRoot;
  return filesRoot
    ? path.join(filesRoot, ".joshu", "realtime-goals")
    : path.join(projectRoot, ".local", "realtime-goals");
}

function normalizeState(value: unknown): RealtimeGoalState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_STATE };
  const parsed = value as Partial<RealtimeGoalState>;
  const cooldowns =
    parsed.callbackCooldowns && typeof parsed.callbackCooldowns === "object"
      ? parsed.callbackCooldowns
      : undefined;
  return {
    version: 1,
    goals: Array.isArray(parsed.goals) ? parsed.goals : [],
    inbox: Array.isArray(parsed.inbox) ? parsed.inbox : [],
    ...(cooldowns ? { callbackCooldowns: cooldowns } : {}),
  };
}

/**
 * Small, process-serialized JSON registry.
 *
 * Kanban owns execution state. This file owns intake, source idempotency, and
 * same-channel delivery cursors, and is persisted on the owner's Files volume.
 */
export class RealtimeGoalStore {
  private readonly dir: string;
  private readonly file: string;
  private transactionTail: Promise<unknown> = Promise.resolve();

  constructor(projectRoot: string) {
    this.dir = stateDirectory(projectRoot);
    this.file = path.join(this.dir, "state.json");
  }

  private async readUnlocked(): Promise<RealtimeGoalState> {
    try {
      return normalizeState(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ...EMPTY_STATE, goals: [] };
      throw new Error(`realtime goal state read failed: ${(error as Error).message}`);
    }
  }

  private async writeUnlocked(state: RealtimeGoalState): Promise<void> {
    const inboxCutoff = Date.now() - 7 * 24 * 60 * 60_000;
    state.inbox = (state.inbox ?? []).filter(
      (item) =>
        (!item.processedAt && !item.recoveryNotifiedAt) ||
        Date.parse(item.receivedAt) >= inboxCutoff,
    );
    await mkdir(this.dir, { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }

  async read(): Promise<RealtimeGoalState> {
    return this.transaction(async (state) => ({ result: structuredClone(state), changed: false }));
  }

  async transaction<T>(
    mutate: (state: RealtimeGoalState) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean },
  ): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.transactionTail = this.transactionTail
      .catch(() => undefined)
      .then(async () => {
        try {
          const state = await this.readUnlocked();
          const next = await mutate(state);
          if (next.changed) await this.writeUnlocked(state);
          resolveResult(next.result);
        } catch (error) {
          rejectResult(error);
        }
      });
    return result;
  }

  async get(goalId: string): Promise<RealtimeGoalRecord | undefined> {
    const state = await this.read();
    return state.goals.find((goal) => goal.id === goalId);
  }

  async findBySource(originKey: string, sourceMessageId: string): Promise<RealtimeGoalRecord | undefined> {
    const state = await this.read();
    return state.goals.find(
      (goal) =>
        realtimeGoalSessionKey(goal.origin) === originKey &&
        (goal.sourceMessageId === sourceMessageId ||
          goal.handledSourceIds?.includes(sourceMessageId)),
    );
  }

  async listActiveForSession(originKey: string): Promise<RealtimeGoalRecord[]> {
    const state = await this.read();
    return state.goals
      .filter(
        (goal) =>
          realtimeGoalSessionKey(goal.origin) === originKey && isRealtimeGoalActive(goal),
      )
      .sort((a, b) =>
        (b.ownerInteractedAt ?? b.createdAt).localeCompare(
          a.ownerInteractedAt ?? a.createdAt,
        ),
      );
  }

  /** Recent done/blocked goals that may reopen when the active pointer is stale. */
  async listContinuableForSession(
    originKey: string,
    ttlMs: number,
  ): Promise<RealtimeGoalRecord[]> {
    const cutoff = Date.now() - ttlMs;
    const state = await this.read();
    return state.goals
      .filter((goal) => realtimeGoalSessionKey(goal.origin) === originKey)
      .filter((goal) => goal.status === "done" || goal.status === "blocked")
      .filter((goal) => Date.parse(goal.updatedAt) >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listOutstanding(): Promise<RealtimeGoalRecord[]> {
    const state = await this.read();
    return state.goals.filter(
      (goal) => {
        if (
          goal.status === "cancelled" &&
          !goal.kanbanTaskId &&
          goal.releaseAt &&
          Date.parse(goal.releaseAt) <= Date.now() &&
          !goal.cancellationReconciledAt
        ) {
          return true;
        }
        if (goal.status === "queued" || goal.status === "releasing" || goal.status === "cancelling") {
          return true;
        }
        if (!goal.kanbanTaskId || goal.status === "cancelled") return false;
        const taskTerminal = goal.status === "done" || goal.status === "failed";
        return !taskTerminal || !deliveryFinished(goal);
      },
    );
  }

  /** Finished goals whose result was parked (owner unreachable) and not yet heard. */
  async listParkedResultsForSession(originKey: string): Promise<RealtimeGoalRecord[]> {
    const state = await this.read();
    return state.goals
      .filter((goal) => realtimeGoalSessionKey(goal.origin) === originKey)
      .filter((goal) => goal.status === "done" || goal.status === "failed")
      .filter((goal) => goal.delivery.state === "parked")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Done/failed goals finished since `sinceMs` (newest first), whatever their delivery state. */
  async listRecentFinishedForSession(
    originKey: string,
    sinceMs: number,
  ): Promise<RealtimeGoalRecord[]> {
    const state = await this.read();
    return state.goals
      .filter((goal) => realtimeGoalSessionKey(goal.origin) === originKey)
      .filter((goal) => goal.status === "done" || goal.status === "failed")
      .filter((goal) => Date.parse(goal.updatedAt) >= sinceMs)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async insert(goal: RealtimeGoalRecord): Promise<RealtimeGoalRecord> {
    return this.transaction((state) => {
      const duplicate = state.goals.find(
        (item) =>
          realtimeGoalSessionKey(item.origin) === realtimeGoalSessionKey(goal.origin) &&
          item.sourceMessageId === goal.sourceMessageId,
      );
      if (duplicate) return { result: duplicate, changed: false };
      state.goals.push(goal);
      return { result: goal, changed: true };
    });
  }

  async update(
    goalId: string,
    mutate: (goal: RealtimeGoalRecord) => void,
  ): Promise<RealtimeGoalRecord | undefined> {
    return this.transaction((state) => {
      const goal = state.goals.find((item) => item.id === goalId);
      if (!goal) return { result: undefined, changed: false };
      mutate(goal);
      goal.updatedAt = new Date().toISOString();
      return { result: structuredClone(goal), changed: true };
    });
  }

  async reserveInbound(record: RealtimeGoalInboxRecord): Promise<void> {
    await this.transaction((state) => {
      state.inbox ??= [];
      if (state.inbox.some((item) => item.id === record.id)) {
        return { result: undefined, changed: false };
      }
      state.inbox.push(record);
      return { result: undefined, changed: true };
    });
  }

  async completeInbound(id: string): Promise<void> {
    await this.transaction((state) => {
      const item = state.inbox?.find((candidate) => candidate.id === id);
      if (!item || item.processedAt) return { result: undefined, changed: false };
      item.processedAt = new Date().toISOString();
      return { result: undefined, changed: true };
    });
  }

  async listStaleInbound(minAgeMs: number): Promise<RealtimeGoalInboxRecord[]> {
    const state = await this.read();
    const cutoff = Date.now() - minAgeMs;
    return (state.inbox ?? []).filter(
      (item) =>
        !item.processedAt &&
        !item.recoveryNotifiedAt &&
        Date.parse(item.receivedAt) <= cutoff,
    );
  }

  async markInboundRecoveryNotified(id: string): Promise<void> {
    await this.transaction((state) => {
      const item = state.inbox?.find((candidate) => candidate.id === id);
      if (!item || item.recoveryNotifiedAt) return { result: undefined, changed: false };
      item.recoveryNotifiedAt = new Date().toISOString();
      return { result: undefined, changed: true };
    });
  }

  /**
   * Atomically claim one delivery attempt. Prevents concurrent duplicate SMS when
   * lifecycle ticks overlap or completion is reconciled twice.
   */
  async claimDeliveryAttempt(
    goalId: string,
    kind: RealtimeGoalDeliveryKind,
    text: string,
    maxAttempts: number,
  ): Promise<{ claimed: boolean; goal?: RealtimeGoalRecord; contentKey: string }> {
    const contentKey = realtimeGoalDeliveryContentKey(kind, text);
    type ClaimResult = { claimed: boolean; goal?: RealtimeGoalRecord; contentKey: string };
    return this.transaction<ClaimResult>((state) => {
      const goal = state.goals.find((item) => item.id === goalId);
      if (
        !goal ||
        goal.status === "cancelled" ||
        goal.delivery.state === "suppressed" ||
        goal.delivery.state === "parked"
      ) {
        return { result: { claimed: false, contentKey }, changed: false };
      }
      if (goal.delivery.attempts >= maxAttempts) {
        return { result: { claimed: false, contentKey }, changed: false };
      }
      if (
        goal.delivery.nextAttemptAt &&
        Date.parse(goal.delivery.nextAttemptAt) > Date.now()
      ) {
        return { result: { claimed: false, contentKey }, changed: false };
      }
      // One outbound callback per owner session at a time, with a gap between
      // calls. Deferring here does not consume an attempt.
      const exclusive = usesExclusiveCallback(goal.origin);
      const session = realtimeGoalSessionKey(goal.origin);
      if (exclusive) {
        const holdUntil = Date.parse(state.callbackCooldowns?.[session] ?? "");
        if (Number.isFinite(holdUntil) && holdUntil > Date.now()) {
          return { result: { claimed: false, contentKey }, changed: false };
        }
      }
      if (kind !== "blocked") {
        if (goal.delivery.state === "delivered") {
          return { result: { claimed: false, contentKey }, changed: false };
        }
        if (goal.delivery.lastDeliveredKey === contentKey) {
          return { result: { claimed: false, contentKey }, changed: false };
        }
      }
      if (goal.delivery.state === "attempting") {
        const leaseUntil = Date.parse(goal.delivery.attemptLeaseUntil ?? "");
        if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) {
          return { result: { claimed: false, contentKey }, changed: false };
        }
        goal.delivery.lastError = "stale delivery attempt recovered after restart";
      }
      goal.delivery.state = "attempting";
      goal.delivery.attempts += 1;
      goal.delivery.lastAttemptAt = new Date().toISOString();
      goal.delivery.attemptLeaseUntil = new Date(Date.now() + DELIVERY_LEASE_MS).toISOString();
      goal.delivery.callbackOutcome = undefined;
      if (exclusive) setCallbackHold(state, session, Date.now() + CALLBACK_IN_FLIGHT_HOLD_MS);
      goal.updatedAt = new Date().toISOString();
      return {
        result: { claimed: true, goal: structuredClone(goal), contentKey },
        changed: true,
      };
    });
  }

  async finalizeDeliveryAttempt(
    goalId: string,
    contentKey: string,
    result: {
      delivered: boolean;
      pending?: boolean;
      providerId?: string;
      error?: string;
      retryAt?: string;
      deferNoticeSent?: boolean;
    },
    maxAttempts: number,
  ): Promise<void> {
    await this.transaction((state) => {
      const goal = state.goals.find((item) => item.id === goalId);
      if (!goal) return { result: undefined, changed: false };
      if (result.delivered) {
        goal.delivery.state = "delivered";
        goal.delivery.deliveredAt = new Date().toISOString();
        goal.delivery.lastDeliveredKey = contentKey;
        goal.delivery.providerId = result.providerId;
        goal.delivery.nextAttemptAt = undefined;
        goal.delivery.attemptLeaseUntil = undefined;
        goal.delivery.lastError = undefined;
      } else if (result.pending && result.providerId) {
        goal.delivery.state = "attempting";
        goal.delivery.providerId = result.providerId;
        goal.delivery.lastError = result.error;
        goal.delivery.nextAttemptAt = undefined;
        goal.delivery.attemptLeaseUntil = new Date(Date.now() + CALLBACK_IN_FLIGHT_HOLD_MS).toISOString();
      } else if (result.pending) {
        // Deferred without trying (e.g. outside owner working hours): wait for
        // retryAt and give the attempt back so quiet hours do not exhaust it.
        goal.delivery.state = "pending";
        goal.delivery.attempts = Math.max(0, goal.delivery.attempts - 1);
        goal.delivery.lastError = result.error;
        goal.delivery.nextAttemptAt =
          result.retryAt ?? new Date(Date.now() + 15 * 60_000).toISOString();
        goal.delivery.attemptLeaseUntil = undefined;
        if (result.deferNoticeSent) goal.delivery.deferNoticeAt = new Date().toISOString();
      } else {
        goal.delivery.state = "pending";
        goal.delivery.lastError = result.error || "delivery failed";
        const waitMs = Math.min(
          15 * 60_000,
          15_000 * 2 ** Math.max(0, goal.delivery.attempts - 1),
        );
        goal.delivery.nextAttemptAt =
          result.retryAt ?? new Date(Date.now() + waitMs).toISOString();
        goal.delivery.attemptLeaseUntil = undefined;
      }
      if (goal.delivery.attempts >= maxAttempts && goal.delivery.state !== "delivered") {
        goal.delivery.lastError ??= "delivery attempts exhausted";
      }
      // No call is ringing unless the handler placed one — release the session hold.
      if (usesExclusiveCallback(goal.origin) && !(result.pending && result.providerId)) {
        delete state.callbackCooldowns?.[realtimeGoalSessionKey(goal.origin)];
      }
      goal.updatedAt = new Date().toISOString();
      return { result: undefined, changed: true };
    });
  }

  /**
   * Settle an outbound callback for `callSid` after Twilio reports the call
   * ended, or after voice-realtime / AMD reports how it went.
   *
   * Idempotent per call: only a goal still `attempting` on this `callSid` is
   * settled. A late outcome (voicemail reported after Twilio's `completed`
   * already scheduled a retry) upgrades that retry to a park.
   *
   * Parking is session-wide: once the owner is unreachable by phone, every other
   * pending callback for that session is parked too, so the phone stops ringing.
   */
  async settleVoiceCallback(input: {
    goalId: string;
    callSid: string;
    twilioStatus?: string;
    outcome?: RealtimeGoalVoiceCallbackOutcome;
  }): Promise<{ settlement?: VoiceCallbackSettlement; parked: RealtimeGoalRecord[] }> {
    type Result = { settlement?: VoiceCallbackSettlement; parked: RealtimeGoalRecord[] };
    return this.transaction<Result>((state) => {
      const none: { result: Result; changed: boolean } = { result: { parked: [] }, changed: false };
      const goal = state.goals.find((item) => item.id === input.goalId);
      if (!goal) return none;
      const delivery = goal.delivery;
      if (input.callSid && delivery.providerId && delivery.providerId !== input.callSid) return none;
      const session = realtimeGoalSessionKey(goal.origin);
      const now = Date.now();
      const nowIso = new Date(now).toISOString();

      if (input.outcome) delivery.callbackOutcome = input.outcome;

      if (delivery.state === "delivered") {
        if (input.twilioStatus) setCallbackHold(state, session, now + CALLBACK_GAP_MS);
        goal.updatedAt = nowIso;
        return { result: { parked: [] }, changed: true };
      }

      const ended = Boolean(input.twilioStatus);
      // providerId keeps the last call's SID until the next attempt is placed.
      const lateOutcome =
        !ended &&
        Boolean(input.outcome) &&
        Boolean(input.callSid) &&
        delivery.state === "pending" &&
        delivery.providerId === input.callSid;
      if (!(ended && delivery.state === "attempting") && !lateOutcome) {
        // Call still live (outcome recorded for when it ends), or already settled.
        goal.updatedAt = nowIso;
        return { result: { parked: [] }, changed: Boolean(input.outcome) };
      }

      const settlement = settleUndeliveredCallback({
        attempts: delivery.attempts,
        outcome: delivery.callbackOutcome,
        twilioStatus: input.twilioStatus,
        nowMs: now,
      });
      delivery.attemptLeaseUntil = undefined;
      delivery.lastError = settlement.reason;

      if (settlement.action === "retry") {
        delivery.state = "pending";
        delivery.nextAttemptAt = settlement.retryAt;
        // Other goals for this owner wait at least as long as this redial.
        setCallbackHold(state, session, Date.parse(settlement.retryAt));
        goal.updatedAt = nowIso;
        return { result: { settlement, parked: [] }, changed: true };
      }

      const parked: RealtimeGoalRecord[] = [];
      for (const item of state.goals) {
        if (realtimeGoalSessionKey(item.origin) !== session) continue;
        if (!usesExclusiveCallback(item.origin)) continue;
        const live =
          item.delivery.state === "attempting" &&
          item.id !== goal.id &&
          Date.parse(item.delivery.attemptLeaseUntil ?? "") > now;
        const waiting = item.delivery.state === "pending" || item.delivery.state === "attempting";
        if (!waiting || live || item.status === "cancelled" || item.status === "cancelling") continue;
        const hasContent =
          item.id === goal.id ||
          (item.status === "blocked" && Boolean(item.lastBlockReason)) ||
          ((item.status === "done" || item.status === "failed") && Boolean(item.resultSummary));
        if (!hasContent) continue;
        item.delivery.state = "parked";
        item.delivery.parkedAt = nowIso;
        item.delivery.parkedReason = settlement.reason;
        item.delivery.nextAttemptAt = undefined;
        item.delivery.attemptLeaseUntil = undefined;
        item.updatedAt = nowIso;
        parked.push(structuredClone(item));
      }
      setCallbackHold(state, session, now + PARKED_SESSION_HOLD_MS);
      return { result: { settlement, parked }, changed: true };
    });
  }

  /** Mark a parked result as heard (owner asked for it on an unlocked channel). */
  async markParkedResultDelivered(goalId: string): Promise<void> {
    await this.transaction((state) => {
      const goal = state.goals.find((item) => item.id === goalId);
      if (!goal || goal.delivery.state !== "parked") return { result: undefined, changed: false };
      goal.delivery.state = "delivered";
      goal.delivery.deliveredAt = new Date().toISOString();
      goal.delivery.parkedAt = undefined;
      goal.delivery.parkedReason = undefined;
      goal.updatedAt = new Date().toISOString();
      return { result: undefined, changed: true };
    });
  }
}
