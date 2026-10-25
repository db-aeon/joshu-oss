export type RealtimeGoalChannel =
  | "sms"
  | "jchat"
  | "agui"
  | "browser_voice"
  | "pstn_voice"
  | "slack"
  | "telegram";

export type RealtimeGoalOrigin = {
  channel: RealtimeGoalChannel;
  /** Stable conversation identity used for clarification and delivery. */
  sessionKey: string;
  /** Raw Hermes session id when it differs from sessionKey. */
  sessionId?: string;
  /** Provider event id. Used only for transport-level idempotency. */
  messageId?: string;
  /** SMS E.164, Slack channel id, or Telegram chat id. */
  replyAddress?: string;
  /** Slack thread_ts / Telegram message-thread id. */
  threadId?: string;
  appId?: string;
};

export type RealtimeGoalStatus =
  | "clarifying"
  | "queued"
  | "releasing"
  | "cancelling"
  | "ready"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export type RealtimeGoalMessage = {
  at: string;
  role: "owner" | "broker";
  text: string;
};

/** Bounded owner↔box transcript for session-scoped routing (not Hermes history). */
export type SessionThreadTurnSource =
  | "inbound"
  | "broker"
  | "delivery"
  | "hermes";

export type SessionThreadTurn = {
  at: string;
  role: "owner" | "box";
  text: string;
  source: SessionThreadTurnSource;
  messageId?: string;
  goalId?: string;
};

export type SessionThread = {
  sessionKey: string;
  turns: SessionThreadTurn[];
  updatedAt: string;
  /** Routing hint: the open branch on this trunk (authoritative status lives on the goal). */
  activeGoalId?: string;
  activeGoalSetAt?: string;
};

export type SessionThreadState = {
  version: 1;
  threads: Record<string, SessionThread>;
};

/**
 * How an outbound PSTN goal callback ended, as reported by voice-realtime or
 * Twilio answering-machine detection. Drives redial vs. park.
 */
export type RealtimeGoalVoiceCallbackOutcome =
  /** Answering machine / voicemail greeting (AMD or greeting transcript). */
  | "voicemail"
  /** Passphrase attempts exhausted — not the owner, or a greeting misheard as attempts. */
  | "auth_failed"
  /** Someone picked up but the call ended before unlock (hang-up or time limit). */
  | "no_unlock";

export type RealtimeGoalDelivery = {
  /**
   * `parked` — channel delivery stopped (e.g. owner unreachable by phone). The
   * result waits for the owner to ask for it; no automatic retries.
   * `outbox` — handed to the owner outbox, which owns delivery from here.
   */
  state: "pending" | "attempting" | "delivered" | "suppressed" | "parked" | "outbox";
  attempts: number;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  attemptLeaseUntil?: string;
  deliveredAt?: string;
  /** Hash of kind+text for the last successful owner-channel delivery. */
  lastDeliveredKey?: string;
  lastError?: string;
  providerId?: string;
  /** Outcome reported for the in-flight callback `providerId` (PSTN only). */
  callbackOutcome?: RealtimeGoalVoiceCallbackOutcome;
  parkedAt?: string;
  parkedReason?: string;
};

export type RealtimeGoalSurfaceEvent = {
  id: string;
  kind: RealtimeGoalDeliveryKind;
  text: string;
  createdAt: string;
  consumedAt?: string;
};

export type RealtimeGoalRecord = {
  id: string;
  version: 1;
  title: string;
  objective: string;
  status: RealtimeGoalStatus;
  origin: RealtimeGoalOrigin;
  sourceMessageId: string;
  /** Every provider event already applied to this goal (initial + updates/cancel/status). */
  handledSourceIds?: string[];
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  ownerInteractedAt?: string;
  releaseAt?: string;
  clarificationQuestion?: string;
  messages: RealtimeGoalMessage[];
  pendingOwnerUpdates?: Array<{
    sourceId: string;
    text: string;
    at: string;
    /** Set when the owner answered the worker's blocked question. */
    fromBlockedAnswer?: boolean;
    /** The blocked question this update answers (echoed onto the card). */
    answeredQuestion?: string;
  }>;
  kanbanTaskId?: string;
  lastKanbanStatus?: string;
  lastBlockReason?: string;
  /** When the owner replied while the goal was blocked waiting on input. */
  blockedAnsweredAt?: string;
  /** Block question text the owner already answered (for repeat-block detection). */
  lastBlockedPrompt?: string;
  /** Normalized owner reply to the last blocked question. */
  lastOwnerAnswer?: string;
  /**
   * Automatic worker restarts since the owner last spoke (system blocks and
   * repeats of an answered question). Bounded; reset on each owner answer.
   */
  autoRecoveries?: number;
  resultSummary?: string;
  /**
   * Content key of the result/question whose links were texted to the owner
   * during a voice callback (links cannot be spoken; SMS carries them).
   */
  linksTextedKey?: string;
  /** When those links were texted. */
  linksTextedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  cancellationReconciledAt?: string;
  intakeReply: string;
  sourceReceipts?: Array<{
    sourceId: string;
    reply: string;
    outcome: "clarify" | "queued" | "updated" | "cancelled" | "status" | "ack" | "delivery";
    at: string;
  }>;
  delivery: RealtimeGoalDelivery;
  surfaceEvents?: RealtimeGoalSurfaceEvent[];
  /** Owner told us how to deliver this goal ("don't call me back, just text"). */
  deliveryRouteOverride?: { route: OwnerRoute; reason: string; at: string };
};

export type RealtimeGoalState = {
  version: 1;
  goals: RealtimeGoalRecord[];
  inbox?: RealtimeGoalInboxRecord[];
  /** Owner outbox: every result or question the owner still has to hear. */
  outbox?: OwnerOutboxItem[];
  /** Where the owner is reachable and how they want results (owner outbox path). */
  owner?: OwnerDeliveryState;
};

/**
 * Where an outbox item is delivered. `surface` is the per-session event queue
 * that jChat, AG-UI, and browser voice poll.
 */
export type OwnerRoute = "voice" | "sms" | "slack" | "telegram" | "surface";

export type OwnerOutboxItemKind = "completed" | "blocked" | "failed" | "answer";

/**
 * `ready` — waiting to be delivered. `offered` — handed to a live phone call
 * (spoken or about to be). `heard` — the owner got it. `superseded` — replaced
 * by newer content for the same goal. `cancelled` — the goal was cancelled.
 */
export type OwnerOutboxItemState = "ready" | "offered" | "heard" | "superseded" | "cancelled";

export type OwnerOutboxAttemptOutcome =
  | "delivered"
  | "pending"
  /** The carrier rejected the SMS (Twilio `undelivered` / `failed`); detail has the error code. */
  | "undelivered"
  | "no_answer"
  | "busy"
  | "voicemail_left"
  | "hung_up_locked"
  | "gate_failed"
  | "not_heard"
  | "failed";

export type OwnerHeardEvidence =
  | "channel_delivered"
  /** SMS stayed `sent` (carrier took it, no delivery receipt) for the receipt timeout. */
  | "sms_sent"
  | "transcript_coverage"
  | "owner_reply"
  | "playback_complete"
  | "status_request"
  | "surface_consumed";

export type OwnerOutboxAttempt = {
  at: string;
  route: OwnerRoute;
  outcome: OwnerOutboxAttemptOutcome;
  providerId?: string;
  batchId?: string;
  detail?: string;
};

export type OwnerOutboxItem = {
  id: string;
  ownerKey: string;
  goalId?: string;
  jobId?: string;
  kind: OwnerOutboxItemKind;
  title: string;
  /** Owner-facing text (already formatted for the owner). */
  text: string;
  /** Hash of kind+text; the same content is never enqueued twice for a goal. */
  contentKey: string;
  /** Where the request came from — the default reply route and address. */
  origin: RealtimeGoalOrigin;
  createdAt: string;
  updatedAt: string;
  state: OwnerOutboxItemState;
  /** Owner said how they want this one ("don't call, text me"). */
  routeOverride?: { route: OwnerRoute; reason: string; at: string };
  attempts: OwnerOutboxAttempt[];
  /** After a failed send: do not retry before this. */
  retryAt?: string;
  /** Consecutive failed sends (drives retryAt backoff). */
  failures?: number;
  /** In-flight delivery claim; expires so a crash cannot strand the item. */
  lease?: { route: OwnerRoute; until: string; batchId?: string; providerId?: string };
  offered?: { at: string; via: OwnerRoute; callSid?: string };
  heard?: { at: string; via: OwnerRoute; evidence: OwnerHeardEvidence; callSid?: string };
  /** SMS accepted by Twilio, waiting for the delivery receipt (no other send meanwhile). */
  smsPending?: OwnerOutboxSmsPending;
};

export type OwnerOutboxSmsPending = {
  /** Twilio message SID of each SMS part. */
  sids: string[];
  sentAt: string;
  /** Next Twilio status read. */
  checkAt: string;
  /** Where and what was texted (for the thread record once the SMS is heard). */
  address: RealtimeGoalOrigin;
  text: string;
};

/** Channel origin the owner last used, kept so a reply can go back to the same place. */
export type OwnerActivity = {
  channel: RealtimeGoalChannel;
  at: string;
  origin: RealtimeGoalOrigin;
};

export type OwnerPresence = {
  lastActivity?: OwnerActivity;
  /** Per text-capable channel: the owner's most recent activity there. */
  lastByChannel?: Partial<Record<RealtimeGoalChannel, OwnerActivity>>;
  /** Owner is on an unlocked phone call right now (lease renewed by the voice service). */
  activeCall?: { callSid: string; unlockedAt: string; leaseUntil: string };
  /** An outbound callback is ringing or live; no second one until it ends. */
  callInFlight?: {
    callSid: string;
    batchId: string;
    since: string;
    leaseUntil: string;
    itemIds: string[];
    ownerRequested?: boolean;
    /** How the call went, reported before Twilio's terminal status (voicemail, lockout). */
    outcome?: RealtimeGoalVoiceCallbackOutcome;
    /** The owner passed the passphrase on this call. */
    unlockedAt?: string;
  };
  /** Undelivered callbacks since the owner last made contact. */
  consecutiveMisses: number;
  backoffUntil?: string;
  lastMissAt?: string;
  /** Owner asked to be called ("call me back"); dial as soon as possible. */
  callRequestedAt?: string;
};

export type OwnerDeliveryPrefs = {
  /** After a missed callback, text the full result (owner decision 2026-09-26). */
  textResultAfterMissedCall: boolean;
  /** Outside call hours (but within civil hours), text instead of waiting to call. */
  textOutsideCallHours: boolean;
  /** Owner-wide override ("don't call me, text me") with an expiry. */
  defaultRoute?: { route: OwnerRoute; reason: string; at: string; until: string };
};

export type OwnerDeliveryState = {
  presence: OwnerPresence;
  prefs?: Partial<OwnerDeliveryPrefs>;
  /** When per-goal legacy deliveries were moved into the outbox. */
  migratedAt?: string;
};

/** Every realtime channel on a box belongs to its one owner. */
export const OWNER_KEY = "owner";

export function realtimeGoalOwnerKey(_origin?: RealtimeGoalOrigin): string {
  return OWNER_KEY;
}

export type RealtimeGoalInboxRecord = {
  id: string;
  origin: RealtimeGoalOrigin;
  text: string;
  receivedAt: string;
  processedAt?: string;
  recoveryNotifiedAt?: string;
};

export type RealtimeGoalRouteInput = {
  origin: RealtimeGoalOrigin;
  text: string;
};

export type RealtimeGoalRouteResult =
  | { action: "pass" }
  | {
      action: "reply";
      text: string;
      goalId?: string;
      outcome:
        | "clarify"
        | "queued"
        | "updated"
        | "cancelled"
        | "status"
        | "ack"
        | "delivery";
    };

export type RealtimeGoalDeliveryKind = "blocked" | "completed" | "failed";

export function realtimeGoalSessionKey(origin: RealtimeGoalOrigin): string {
  return `${origin.channel}:${origin.sessionKey}`;
}

export function isRealtimeGoalActive(goal: RealtimeGoalRecord): boolean {
  return !["done", "failed", "cancelled"].includes(goal.status);
}
