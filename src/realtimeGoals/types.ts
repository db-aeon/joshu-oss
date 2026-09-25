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
   */
  state: "pending" | "attempting" | "delivered" | "suppressed" | "parked";
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
  /** When the owner was texted that this callback waits for their call hours (sent once). */
  deferNoticeAt?: string;
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
    outcome: "clarify" | "queued" | "updated" | "cancelled" | "status" | "ack";
    at: string;
  }>;
  delivery: RealtimeGoalDelivery;
  surfaceEvents?: RealtimeGoalSurfaceEvent[];
};

export type RealtimeGoalState = {
  version: 1;
  goals: RealtimeGoalRecord[];
  inbox?: RealtimeGoalInboxRecord[];
  /**
   * Per-session hold on outbound callbacks (key: realtimeGoalSessionKey). Set
   * after an unanswered/voicemail callback so other goals do not dial in a burst.
   */
  callbackCooldowns?: Record<string, string>;
};

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
        | "ack";
    };

export type RealtimeGoalDeliveryKind = "blocked" | "completed" | "failed";

export type RealtimeGoalDeliveryHandler = (
  goal: RealtimeGoalRecord,
  text: string,
  kind: RealtimeGoalDeliveryKind,
) => Promise<{
  delivered: boolean;
  pending?: boolean;
  providerId?: string;
  retryAt?: string;
  error?: string;
  /** Deferred callback: the owner was texted when it will ring. */
  deferNoticeSent?: boolean;
}>;

export function realtimeGoalSessionKey(origin: RealtimeGoalOrigin): string {
  return `${origin.channel}:${origin.sessionKey}`;
}

export function isRealtimeGoalActive(goal: RealtimeGoalRecord): boolean {
  return !["done", "failed", "cancelled"].includes(goal.status);
}
