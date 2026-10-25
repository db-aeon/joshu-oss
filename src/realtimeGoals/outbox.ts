/**
 * Owner outbox: every result or question the owner still has to hear, plus where
 * the owner is reachable right now. Lives in the realtime-goals state file and
 * uses the same serialized transactions as goals.
 *
 * Delivery decisions are in outboxPolicy.ts; OwnerOutboxDispatcher executes them.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  ACTIVE_CALL_LEASE_MS,
  CALL_LEASE_MS,
  DEFAULT_OWNER_PREFS,
  missBackoffMs,
  routeForChannel,
  SMS_STATUS_POLL_MS,
  type SmsDeliveryVerdict,
} from "./outboxPolicy.js";
import type { RealtimeGoalStore } from "./store.js";
import {
  OWNER_KEY,
  type OwnerDeliveryPrefs,
  type OwnerDeliveryState,
  type OwnerHeardEvidence,
  type OwnerOutboxAttemptOutcome,
  type OwnerOutboxItem,
  type OwnerOutboxItemKind,
  type OwnerPresence,
  type OwnerRoute,
  type RealtimeGoalOrigin,
  type RealtimeGoalRecord,
  type RealtimeGoalState,
  type RealtimeGoalVoiceCallbackOutcome,
} from "./types.js";

/** Heard / superseded / cancelled items are kept this long for context and audit. */
const FINISHED_ITEM_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A callback that could not be placed is retried after this. */
const CALL_PLACEMENT_RETRY_MS = 2 * 60_000;
/** Text sends back off from 15 s up to 15 min. */
const TEXT_RETRY_BASE_MS = 15_000;
const TEXT_RETRY_MAX_MS = 15 * 60_000;

const OPEN_STATES = new Set<OwnerOutboxItem["state"]>(["ready", "offered"]);

function isoNow(): string {
  return new Date().toISOString();
}

function ms(iso: string | undefined): number {
  const parsed = Date.parse(iso ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function outboxContentKey(kind: OwnerOutboxItemKind, text: string): string {
  return createHash("sha256").update(`${kind}\n${text}`).digest("hex").slice(0, 32);
}

function ownerState(state: RealtimeGoalState): OwnerDeliveryState {
  state.owner ??= { presence: { consecutiveMisses: 0 } };
  state.owner.presence ??= { consecutiveMisses: 0 };
  state.owner.presence.consecutiveMisses ??= 0;
  return state.owner;
}

function items(state: RealtimeGoalState): OwnerOutboxItem[] {
  state.outbox ??= [];
  return state.outbox;
}

function isOpen(item: OwnerOutboxItem): boolean {
  return OPEN_STATES.has(item.state);
}

/** A send failed: back off 15 s doubling up to 15 min. */
function backOffAfterFailure(item: OwnerOutboxItem): void {
  item.failures = (item.failures ?? 0) + 1;
  const wait = Math.min(TEXT_RETRY_MAX_MS, TEXT_RETRY_BASE_MS * 2 ** (item.failures - 1));
  item.retryAt = new Date(Date.now() + wait).toISOString();
}

function markItemHeard(item: OwnerOutboxItem, via: OwnerRoute, evidence: OwnerHeardEvidence, at: string): void {
  if (isOpen(item)) {
    item.state = "heard";
    item.heard = { at, via, evidence };
  }
  item.failures = 0;
  item.retryAt = undefined;
}

/** Origin fields safe to keep in presence (no message ids). */
function replyOrigin(origin: RealtimeGoalOrigin): RealtimeGoalOrigin {
  return {
    channel: origin.channel,
    sessionKey: origin.sessionKey,
    ...(origin.sessionId ? { sessionId: origin.sessionId } : {}),
    ...(origin.replyAddress ? { replyAddress: origin.replyAddress } : {}),
    ...(origin.threadId ? { threadId: origin.threadId } : {}),
    ...(origin.appId ? { appId: origin.appId } : {}),
  };
}

/** Undelivered call outcome from Twilio status + what the voice service reported. */
function callOutcome(
  twilioStatus: string,
  reported: RealtimeGoalVoiceCallbackOutcome | undefined,
  unlocked: boolean,
): OwnerOutboxAttemptOutcome {
  if (reported === "voicemail") return "voicemail_left";
  if (reported === "auth_failed") return "gate_failed";
  if (unlocked) return "not_heard";
  if (reported === "no_unlock") return "hung_up_locked";
  switch (twilioStatus) {
    case "busy":
      return "busy";
    case "no-answer":
      return "no_answer";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return "hung_up_locked";
  }
}

export type OwnerOutboxSnapshot = {
  items: OwnerOutboxItem[];
  presence: OwnerPresence;
  prefs: OwnerDeliveryPrefs;
};

export type OwnerCallBatch = {
  id: string;
  items: OwnerOutboxItem[];
  ownerRequested: boolean;
};

export class OwnerOutbox {
  constructor(private readonly store: RealtimeGoalStore) {}

  /**
   * Move per-goal deliveries that were still waiting (pending, attempting,
   * parked) into the outbox, once. state.json is copied aside first.
   */
  async ensureMigrated(): Promise<void> {
    const state = await this.store.read();
    if (state.owner?.migratedAt) return;
    const backup = await this.store.backupOnce("owner-outbox");
    if (backup) console.info(`[owner-outbox] backed up state before migration: ${backup}`);
    const migrated = await this.store.transaction((draft) => {
      const owner = ownerState(draft);
      if (owner.migratedAt) return { result: 0, changed: false };
      owner.migratedAt = isoNow();
      let count = 0;
      for (const goal of draft.goals) {
        if (goal.status === "cancelled" || goal.status === "cancelling") continue;
        if (!["pending", "attempting", "parked"].includes(goal.delivery.state)) continue;
        const kind: OwnerOutboxItemKind | undefined =
          goal.status === "blocked"
            ? "blocked"
            : goal.status === "done"
              ? "completed"
              : goal.status === "failed"
                ? "failed"
                : undefined;
        const text = kind === "blocked" ? goal.lastBlockReason : goal.resultSummary;
        if (!kind || !text) continue;
        this.pushItem(draft, goal, kind, text);
        count += 1;
      }
      return { result: count, changed: true };
    });
    if (migrated > 0) console.info(`[owner-outbox] migrated ${migrated} undelivered result(s) into the outbox`);
  }

  /** Items still to deliver, owner presence, and preferences (defaults applied). */
  async snapshot(): Promise<OwnerOutboxSnapshot> {
    const state = await this.store.read();
    const owner = state.owner ?? { presence: { consecutiveMisses: 0 } };
    return {
      items: (state.outbox ?? []).filter(isOpen),
      presence: { ...owner.presence, consecutiveMisses: owner.presence.consecutiveMisses ?? 0 },
      prefs: { ...DEFAULT_OWNER_PREFS, ...(owner.prefs ?? {}) },
    };
  }

  async get(itemId: string): Promise<OwnerOutboxItem | undefined> {
    const state = await this.store.read();
    return state.outbox?.find((item) => item.id === itemId);
  }

  /** Every item (any state), newest first. */
  async list(): Promise<OwnerOutboxItem[]> {
    const state = await this.store.read();
    return [...(state.outbox ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Open items per goal id (for context snapshots). */
  async openItemsByGoal(): Promise<Map<string, OwnerOutboxItem[]>> {
    const state = await this.store.read();
    const byGoal = new Map<string, OwnerOutboxItem[]>();
    for (const item of state.outbox ?? []) {
      if (!item.goalId || !isOpen(item)) continue;
      const list = byGoal.get(item.goalId) ?? [];
      list.push(item);
      byGoal.set(item.goalId, list);
    }
    return byGoal;
  }

  private pushItem(
    state: RealtimeGoalState,
    goal: RealtimeGoalRecord,
    kind: OwnerOutboxItemKind,
    text: string,
  ): OwnerOutboxItem {
    const now = isoNow();
    const item: OwnerOutboxItem = {
      id: randomUUID(),
      ownerKey: OWNER_KEY,
      goalId: goal.id,
      kind,
      title: goal.title,
      text,
      contentKey: outboxContentKey(kind, text),
      origin: replyOrigin(goal.origin),
      createdAt: now,
      updatedAt: now,
      state: "ready",
      attempts: [],
      ...(goal.deliveryRouteOverride ? { routeOverride: goal.deliveryRouteOverride } : {}),
    };
    items(state).push(item);
    goal.delivery.state = "outbox";
    goal.delivery.nextAttemptAt = undefined;
    goal.delivery.attemptLeaseUntil = undefined;
    return item;
  }

  /**
   * Publish a goal's result or question. The same content is never enqueued
   * twice; new content for a goal supersedes anything of it not yet heard.
   */
  async upsertForGoal(
    goalId: string,
    kind: OwnerOutboxItemKind,
    text: string,
  ): Promise<{ item?: OwnerOutboxItem; created: boolean }> {
    return this.store.transaction<{ item?: OwnerOutboxItem; created: boolean }>((state) => {
      const goal = state.goals.find((candidate) => candidate.id === goalId);
      if (!goal || goal.status === "cancelled" || goal.status === "cancelling") {
        return { result: { created: false }, changed: false };
      }
      const key = outboxContentKey(kind, text);
      const existing = items(state).find(
        (item) =>
          item.goalId === goalId &&
          item.contentKey === key &&
          item.state !== "superseded" &&
          item.state !== "cancelled",
      );
      if (existing) {
        // The broker re-publishes a blocked goal's question on every tick; only
        // write when the delivery state actually moves.
        const changed = goal.delivery.state !== "outbox";
        goal.delivery.state = "outbox";
        return { result: { item: structuredClone(existing), created: false }, changed };
      }
      const now = isoNow();
      for (const item of items(state)) {
        if (item.goalId === goalId && isOpen(item)) {
          item.state = "superseded";
          item.lease = undefined;
          item.updatedAt = now;
        }
      }
      const item = this.pushItem(state, goal, kind, text);
      goal.updatedAt = now;
      this.prune(state);
      return { result: { item: structuredClone(item), created: true }, changed: true };
    });
  }

  /** Answers to a promoted (long) inline turn — Phase 3 jobs. */
  async addAnswer(input: {
    jobId: string;
    origin: RealtimeGoalOrigin;
    title: string;
    text: string;
    /** How it must reach the owner (e.g. SMS after the caller hung up mid-answer). */
    routeOverride?: OwnerRoute;
  }): Promise<OwnerOutboxItem> {
    return this.store.transaction((state) => {
      const key = outboxContentKey("answer", input.text);
      const existing = items(state).find((item) => item.jobId === input.jobId && item.contentKey === key);
      if (existing) return { result: structuredClone(existing), changed: false };
      const now = isoNow();
      const item: OwnerOutboxItem = {
        id: randomUUID(),
        ownerKey: OWNER_KEY,
        jobId: input.jobId,
        kind: "answer",
        title: input.title,
        text: input.text,
        contentKey: key,
        origin: replyOrigin(input.origin),
        createdAt: now,
        updatedAt: now,
        state: "ready",
        attempts: [],
        ...(input.routeOverride
          ? { routeOverride: { route: input.routeOverride, reason: "answer finished after the call ended", at: now } }
          : {}),
      };
      items(state).push(item);
      this.prune(state);
      return { result: structuredClone(item), changed: true };
    });
  }

  async cancelForGoal(goalId: string): Promise<void> {
    await this.store.transaction((state) => {
      let changed = false;
      for (const item of items(state)) {
        if (item.goalId === goalId && isOpen(item)) {
          item.state = "cancelled";
          item.lease = undefined;
          item.updatedAt = isoNow();
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }

  /** Mark open items heard. Returns the ids that changed. */
  async markHeard(
    itemIds: string[],
    via: OwnerRoute,
    evidence: OwnerHeardEvidence,
    callSid?: string,
  ): Promise<string[]> {
    const wanted = new Set(itemIds);
    return this.store.transaction((state) => {
      const changed: string[] = [];
      const now = isoNow();
      for (const item of items(state)) {
        if (!wanted.has(item.id) || !isOpen(item)) continue;
        item.state = "heard";
        item.heard = { at: now, via, evidence, ...(callSid ? { callSid } : {}) };
        item.lease = undefined;
        item.updatedAt = now;
        changed.push(item.id);
      }
      return { result: changed, changed: changed.length > 0 };
    });
  }

  /** The owner heard everything open for this goal (status reply, answered question). */
  async markHeardForGoal(
    goalId: string,
    via: OwnerRoute,
    evidence: OwnerHeardEvidence,
    kinds?: OwnerOutboxItemKind[],
  ): Promise<string[]> {
    const state = await this.store.read();
    const ids = (state.outbox ?? [])
      .filter((item) => item.goalId === goalId && isOpen(item))
      .filter((item) => !kinds || kinds.includes(item.kind))
      .map((item) => item.id);
    return ids.length > 0 ? this.markHeard(ids, via, evidence) : [];
  }

  /** Items handed to a live call (spoken or about to be). */
  async markOffered(itemIds: string[], callSid: string): Promise<void> {
    const wanted = new Set(itemIds);
    await this.store.transaction((state) => {
      let changed = false;
      const now = isoNow();
      for (const item of items(state)) {
        if (!wanted.has(item.id) || !isOpen(item)) continue;
        item.state = "offered";
        item.offered = { at: now, via: "voice", callSid };
        item.updatedAt = now;
        changed = true;
      }
      return { result: undefined, changed };
    });
  }

  /** Claim open, unleased items for one delivery. Returns what was claimed. */
  async claim(
    itemIds: string[],
    route: OwnerRoute,
    leaseMs: number,
    batchId?: string,
  ): Promise<OwnerOutboxItem[]> {
    const wanted = new Set(itemIds);
    return this.store.transaction((state) => {
      const now = Date.now();
      const claimed: OwnerOutboxItem[] = [];
      for (const item of items(state)) {
        if (!wanted.has(item.id) || !isOpen(item)) continue;
        if (ms(item.lease?.until) > now) continue;
        item.lease = {
          route,
          until: new Date(now + leaseMs).toISOString(),
          ...(batchId ? { batchId } : {}),
        };
        item.updatedAt = new Date(now).toISOString();
        claimed.push(structuredClone(item));
      }
      return { result: claimed, changed: claimed.length > 0 };
    });
  }

  /**
   * Result of a text / surface delivery claimed with `claim`. A send with
   * `pendingIds` (SMS accepted by Twilio) is not heard yet: the item waits
   * for the delivery receipt (`settleSms`).
   */
  async recordSend(
    itemId: string,
    route: OwnerRoute,
    result: { ok: boolean; providerId?: string; error?: string; pendingIds?: string[] },
    sent?: { address: RealtimeGoalOrigin; text: string },
  ): Promise<void> {
    await this.store.transaction((state) => {
      const item = items(state).find((candidate) => candidate.id === itemId);
      if (!item) return { result: undefined, changed: false };
      const now = isoNow();
      const pending = result.ok && Boolean(result.pendingIds?.length) && sent !== undefined;
      const providerId = result.providerId ?? result.pendingIds?.join(",");
      item.attempts.push({
        at: now,
        route,
        outcome: pending ? "pending" : result.ok ? "delivered" : "failed",
        ...(providerId ? { providerId } : {}),
        ...(result.error ? { detail: result.error.slice(0, 300) } : {}),
      });
      item.lease = undefined;
      item.updatedAt = now;
      if (pending) {
        item.smsPending = {
          sids: result.pendingIds!,
          sentAt: now,
          checkAt: new Date(Date.now() + SMS_STATUS_POLL_MS).toISOString(),
          address: replyOrigin(sent!.address),
          text: sent!.text,
        };
      } else if (result.ok) {
        markItemHeard(item, route, route === "surface" ? "surface_consumed" : "channel_delivered", now);
      } else {
        backOffAfterFailure(item);
      }
      return { result: undefined, changed: true };
    });
  }

  /**
   * Settle the pending SMS of an item from its Twilio status. Returns the item
   * and what was texted when the SMS now counts as heard.
   */
  async settleSms(
    itemId: string,
    verdict: SmsDeliveryVerdict,
  ): Promise<{ item: OwnerOutboxItem; address: RealtimeGoalOrigin; text: string } | undefined> {
    return this.store.transaction<{ item: OwnerOutboxItem; address: RealtimeGoalOrigin; text: string } | undefined>(
      (state) => {
        const item = items(state).find((candidate) => candidate.id === itemId);
        const pending = item?.smsPending;
        if (!item || !pending) return { result: undefined, changed: false };
        const now = isoNow();
        if (verdict.kind === "pending") {
          pending.checkAt = new Date(Date.now() + SMS_STATUS_POLL_MS).toISOString();
          return { result: undefined, changed: true };
        }
        item.smsPending = undefined;
        item.updatedAt = now;
        const providerId = pending.sids.join(",");
        if (verdict.kind === "delivered" || verdict.kind === "sent") {
          item.attempts.push({
            at: now,
            route: "sms",
            outcome: "delivered",
            providerId,
            ...(verdict.kind === "sent" ? { detail: "no delivery receipt" } : {}),
          });
          const wasOpen = isOpen(item);
          markItemHeard(item, "sms", verdict.kind === "sent" ? "sms_sent" : "channel_delivered", now);
          return {
            result: wasOpen ? { item: structuredClone(item), address: pending.address, text: pending.text } : undefined,
            changed: true,
          };
        }
        item.attempts.push({
          at: now,
          route: "sms",
          outcome: verdict.kind === "undelivered" ? "undelivered" : "failed",
          providerId,
          detail: verdict.kind === "undelivered" ? verdict.detail : "no final SMS status",
        });
        backOffAfterFailure(item);
        return { result: undefined, changed: true };
      },
    );
  }

  /** "Don't call me back, just text me" for one goal (applies to its future results too). */
  async setRouteOverrideForGoal(goalId: string, route: OwnerRoute, reason: string): Promise<void> {
    await this.store.transaction((state) => {
      const goal = state.goals.find((candidate) => candidate.id === goalId);
      const override = { route, reason: reason.slice(0, 200), at: isoNow() };
      if (goal) goal.deliveryRouteOverride = override;
      for (const item of items(state)) {
        if (item.goalId === goalId && isOpen(item)) {
          item.routeOverride = override;
          item.updatedAt = override.at;
        }
      }
      return { result: undefined, changed: true };
    });
  }

  /** Owner-wide route override ("don't call me today") for results from phone requests. */
  async setDefaultRoute(route: OwnerRoute, reason: string, ttlMs: number): Promise<void> {
    await this.store.transaction((state) => {
      const owner = ownerState(state);
      const at = isoNow();
      owner.prefs = {
        ...(owner.prefs ?? {}),
        defaultRoute: {
          route,
          reason: reason.slice(0, 200),
          at,
          until: new Date(Date.now() + ttlMs).toISOString(),
        },
      };
      return { result: undefined, changed: true };
    });
  }

  /** "Call me back": dial as soon as possible; a call request also ends "text me instead". */
  async requestCall(): Promise<void> {
    await this.store.transaction((state) => {
      const owner = ownerState(state);
      owner.presence.callRequestedAt = isoNow();
      owner.presence.consecutiveMisses = 0;
      owner.presence.backoffUntil = undefined;
      if (owner.prefs?.defaultRoute) owner.prefs = { ...owner.prefs, defaultRoute: undefined };
      return { result: undefined, changed: true };
    });
  }

  /** Any owner message on any channel: they are reachable — stop backing off. */
  async noteOwnerActivity(origin: RealtimeGoalOrigin): Promise<void> {
    await this.store.transaction((state) => {
      const owner = ownerState(state);
      const activity = { channel: origin.channel, at: isoNow(), origin: replyOrigin(origin) };
      owner.presence.lastActivity = activity;
      owner.presence.lastByChannel = { ...(owner.presence.lastByChannel ?? {}), [origin.channel]: activity };
      owner.presence.consecutiveMisses = 0;
      owner.presence.backoffUntil = undefined;
      return { result: undefined, changed: true };
    });
  }

  /** The owner unlocked a phone call (inbound or callback). */
  async setActiveCall(callSid: string): Promise<void> {
    await this.store.transaction((state) => {
      const owner = ownerState(state);
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      owner.presence.activeCall = {
        callSid,
        unlockedAt: nowIso,
        leaseUntil: new Date(now + ACTIVE_CALL_LEASE_MS).toISOString(),
      };
      if (owner.presence.callInFlight?.callSid === callSid) owner.presence.callInFlight.unlockedAt = nowIso;
      const origin: RealtimeGoalOrigin = { channel: "pstn_voice", sessionKey: "pstn:owner", sessionId: callSid };
      const activity = { channel: origin.channel, at: nowIso, origin };
      owner.presence.lastActivity = activity;
      owner.presence.lastByChannel = { ...(owner.presence.lastByChannel ?? {}), pstn_voice: activity };
      owner.presence.consecutiveMisses = 0;
      owner.presence.backoffUntil = undefined;
      return { result: undefined, changed: true };
    });
  }

  /**
   * Items to offer on this live call that it has not offered yet (phone-routed,
   * unheard). Also renews the call's presence lease — the voice service polls it.
   */
  async pendingForCall(callSid: string): Promise<OwnerOutboxItem[]> {
    return this.store.transaction((state) => {
      const owner = ownerState(state);
      const now = Date.now();
      const active = owner.presence.activeCall;
      owner.presence.activeCall = {
        callSid,
        unlockedAt: active?.callSid === callSid ? active.unlockedAt : new Date(now).toISOString(),
        leaseUntil: new Date(now + ACTIVE_CALL_LEASE_MS).toISOString(),
      };
      const pending = items(state)
        .filter(isOpen)
        .filter((item) => item.offered?.callSid !== callSid)
        .filter((item) => (item.routeOverride?.route ?? routeForChannel(item.origin.channel)) === "voice")
        // Leased items are already on their way (a text send, or this callback's own batch).
        .filter((item) => !(ms(item.lease?.until) > now))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((item) => structuredClone(item));
      return { result: pending, changed: true };
    });
  }

  /**
   * The owner's call ended. Anything offered on it but not heard goes back to
   * ready with a `not_heard` attempt, so the policy texts it.
   */
  async endActiveCall(callSid: string): Promise<void> {
    await this.store.transaction((state) => {
      const owner = ownerState(state);
      const now = isoNow();
      let changed = false;
      if (owner.presence.activeCall?.callSid === callSid) {
        owner.presence.activeCall = undefined;
        changed = true;
      }
      for (const item of items(state)) {
        if (item.state !== "offered" || item.offered?.callSid !== callSid) continue;
        if (item.lease?.batchId) continue; // callback batches settle on Twilio's status
        item.state = "ready";
        item.offered = undefined;
        item.attempts.push({ at: now, route: "voice", outcome: "not_heard", providerId: callSid });
        item.updatedAt = now;
        changed = true;
      }
      return { result: undefined, changed };
    });
  }

  /** Claim items for one outbound callback. Undefined when a call is already in flight. */
  async startCallBatch(itemIds: string[], ownerRequested: boolean): Promise<OwnerCallBatch | undefined> {
    const wanted = new Set(itemIds);
    return this.store.transaction((state) => {
      const owner = ownerState(state);
      const now = Date.now();
      if (owner.presence.callInFlight && ms(owner.presence.callInFlight.leaseUntil) > now) {
        return { result: undefined, changed: false };
      }
      const batchId = randomUUID();
      const leaseUntil = new Date(now + CALL_LEASE_MS).toISOString();
      const claimed: OwnerOutboxItem[] = [];
      for (const item of items(state)) {
        if (!wanted.has(item.id) || !isOpen(item)) continue;
        if (ms(item.lease?.until) > now) continue;
        item.lease = { route: "voice", until: leaseUntil, batchId };
        item.updatedAt = new Date(now).toISOString();
        claimed.push(structuredClone(item));
      }
      if (claimed.length === 0 && !ownerRequested) return { result: undefined, changed: false };
      owner.presence.callInFlight = {
        callSid: "",
        batchId,
        since: new Date(now).toISOString(),
        leaseUntil,
        itemIds: claimed.map((item) => item.id),
        ...(ownerRequested ? { ownerRequested: true } : {}),
      };
      owner.presence.callRequestedAt = undefined;
      return { result: { id: batchId, items: claimed, ownerRequested }, changed: true };
    });
  }

  async callPlaced(batchId: string, callSid: string): Promise<void> {
    await this.store.transaction((state) => {
      const owner = ownerState(state);
      if (owner.presence.callInFlight?.batchId !== batchId) return { result: undefined, changed: false };
      owner.presence.callInFlight.callSid = callSid;
      for (const item of items(state)) {
        if (item.lease?.batchId === batchId) item.lease.providerId = callSid;
      }
      return { result: undefined, changed: true };
    });
  }

  /** Twilio refused the call (config / API error): release the batch and retry soon. */
  async callPlacementFailed(batchId: string, error: string): Promise<void> {
    await this.store.transaction((state) => {
      const owner = ownerState(state);
      const now = isoNow();
      if (owner.presence.callInFlight?.batchId === batchId) owner.presence.callInFlight = undefined;
      for (const item of items(state)) {
        if (item.lease?.batchId !== batchId) continue;
        item.lease = undefined;
        item.retryAt = new Date(Date.now() + CALL_PLACEMENT_RETRY_MS).toISOString();
        item.attempts.push({ at: now, route: "voice", outcome: "failed", batchId, detail: error.slice(0, 300) });
        item.updatedAt = now;
      }
      return { result: undefined, changed: true };
    });
  }

  /** Items of a callback batch that the owner has not heard yet. */
  async batch(batchId: string): Promise<
    | { items: OwnerOutboxItem[]; callSid: string; ownerRequested: boolean; inFlight: boolean }
    | undefined
  > {
    const state = await this.store.read();
    const call = state.owner?.presence.callInFlight;
    const batchItems = (state.outbox ?? []).filter(
      (item) => isOpen(item) && item.lease?.batchId === batchId,
    );
    if (call?.batchId !== batchId && batchItems.length === 0) return undefined;
    return {
      items: batchItems,
      callSid: call?.batchId === batchId ? call.callSid : batchItems[0]?.lease?.providerId ?? "",
      ownerRequested: call?.batchId === batchId ? Boolean(call.ownerRequested) : false,
      inFlight: call?.batchId === batchId,
    };
  }

  /** How a callback went, reported before Twilio's terminal status. */
  async recordCallOutcome(
    batchId: string,
    callSid: string,
    outcome: RealtimeGoalVoiceCallbackOutcome,
  ): Promise<void> {
    await this.store.transaction((state) => {
      const call = ownerState(state).presence.callInFlight;
      if (!call || call.batchId !== batchId) return { result: undefined, changed: false };
      if (callSid && call.callSid && call.callSid !== callSid) return { result: undefined, changed: false };
      call.outcome = outcome;
      return { result: undefined, changed: true };
    });
  }

  /**
   * Twilio reported the callback ended. Unheard items go back to ready with the
   * call's outcome (the policy then texts them). A call that never reached the
   * owner counts as a miss and backs further calls off.
   */
  async finishCall(
    batchId: string,
    callSid: string,
    twilioStatus: string,
  ): Promise<{ settled: boolean; missed: boolean; notHeard: OwnerOutboxItem[] }> {
    return this.store.transaction<{ settled: boolean; missed: boolean; notHeard: OwnerOutboxItem[] }>((state) => {
      const owner = ownerState(state);
      const call = owner.presence.callInFlight;
      const batchItems = items(state).filter((item) => item.lease?.batchId === batchId);
      if (call?.batchId !== batchId && batchItems.length === 0) {
        return { result: { settled: false, missed: false, notHeard: [] }, changed: false };
      }
      const now = isoNow();
      const unlocked = Boolean(call?.batchId === batchId && call.unlockedAt);
      const outcome = callOutcome(twilioStatus, call?.batchId === batchId ? call.outcome : undefined, unlocked);
      const notHeard: OwnerOutboxItem[] = [];
      for (const item of batchItems) {
        if (item.lease?.batchId === batchId) item.lease = undefined;
        if (!isOpen(item)) continue;
        item.state = "ready";
        item.offered = undefined;
        item.attempts.push({ at: now, route: "voice", outcome, batchId, ...(callSid ? { providerId: callSid } : {}) });
        item.updatedAt = now;
        notHeard.push(structuredClone(item));
      }
      if (call?.batchId === batchId) owner.presence.callInFlight = undefined;
      if (owner.presence.activeCall?.callSid === callSid) owner.presence.activeCall = undefined;
      const missed = !unlocked;
      if (missed) {
        owner.presence.consecutiveMisses = (owner.presence.consecutiveMisses ?? 0) + 1;
        owner.presence.lastMissAt = now;
        owner.presence.backoffUntil = new Date(
          Date.now() + missBackoffMs(owner.presence.consecutiveMisses),
        ).toISOString();
      } else {
        owner.presence.consecutiveMisses = 0;
        owner.presence.backoffUntil = undefined;
      }
      return { result: { settled: true, missed, notHeard }, changed: true };
    });
  }

  /** Drop finished items after the retention window. */
  private prune(state: RealtimeGoalState): void {
    const cutoff = Date.now() - FINISHED_ITEM_RETENTION_MS;
    state.outbox = items(state).filter(
      (item) => isOpen(item) || ms(item.updatedAt) >= cutoff,
    );
  }
}
