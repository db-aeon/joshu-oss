/**
 * Owner outbox delivery policy — pure, so it can be tested as a table.
 *
 * One owner, one set of results they have not heard yet. Each tick decides,
 * per item, how it reaches the owner right now:
 *
 * 1. Owner is on an unlocked call → no dialing; the live call offers it.
 * 2. Owner said how (item or owner-wide override) → that route.
 * 3. Owner is texting right now (SMS/Slack/Telegram in the last 10 min) → there.
 * 4. Text / surface origins → their own channel.
 * 5. Phone origin → one batched callback (60 s settle, no call in flight,
 *    inside the callback window, no backoff).
 * 6. A callback that did not reach the owner → text the full result (owner
 *    decision 2026-09-26), back off 10 min → 30 min → stop calling until contact.
 * 7. Outside call hours (civil hours) → text instead of waiting to call.
 * 8. Owner asked to be called → dial now, whatever the backoff or window.
 * 9. An SMS counts as heard only with a delivery receipt; until then nothing
 *    else goes out for the item. After an undelivered SMS the item is never
 *    texted again: it takes the next route (fleet audit 2026-10-10: carriers
 *    rejected SMS with 30034/30003/30007 and the owner never saw them).
 *
 * Nothing waits on a timer while the owner is reachable (canary box
 * 2026-09-26: one voicemail verdict held every result for an hour).
 */
import type {
  OwnerDeliveryPrefs,
  OwnerOutboxAttemptOutcome,
  OwnerOutboxItem,
  OwnerPresence,
  OwnerRoute,
  RealtimeGoalChannel,
  RealtimeGoalOrigin,
} from "./types.js";

/** The owner counts as "on" a text channel this long after their last message there. */
export const TEXT_ACTIVE_WINDOW_MS = 10 * 60_000;
/** Near-simultaneous completions share one callback. */
export const CALLBACK_SETTLE_MS = 60_000;
/** Backoff after the 1st and 2nd missed callback. */
export const MISS_BACKOFF_MS = [10 * 60_000, 30 * 60_000] as const;
/** After this many missed callbacks, stop calling until the owner makes contact. */
export const MAX_CONSECUTIVE_MISSES = 2;
/** A "call me back" stays actionable this long. */
export const CALL_REQUEST_TTL_MS = 15 * 60_000;
/** Lease on an item while one delivery is in flight. */
export const TEXT_LEASE_MS = 2 * 60_000;
/** Lease on a callback batch while the call rings / runs (ended early by Twilio status). */
export const CALL_LEASE_MS = 30 * 60_000;
/** Lease on the owner's live call; the voice service renews it while the call is up. */
export const ACTIVE_CALL_LEASE_MS = 2 * 60_000;
/** Read the Twilio status of a pending SMS at most this often. */
export const SMS_STATUS_POLL_MS = 15_000;
/** A pending SMS without a delivery receipt is settled from its last status after this. */
export const SMS_RECEIPT_TIMEOUT_MS = 10 * 60_000;

/** Voice attempt outcomes that mean the owner did not hear it. */
export const MISSED_CALL_OUTCOMES: ReadonlySet<OwnerOutboxAttemptOutcome> = new Set([
  "no_answer",
  "busy",
  "voicemail_left",
  "hung_up_locked",
  "gate_failed",
  "not_heard",
  "failed",
]);

/** Twilio message statuses that mean the SMS will not reach the owner. */
const SMS_REJECTED = new Set(["undelivered", "failed", "canceled"]);
/** Twilio message statuses with a delivery receipt. */
const SMS_RECEIVED = new Set(["delivered", "read"]);

export type SmsDeliveryVerdict =
  | { kind: "delivered" | "sent" | "pending" | "unconfirmed" }
  | { kind: "undelivered"; detail: string };

/**
 * Settle a pending SMS from the Twilio status of each part (undefined = the
 * status read failed). Before the timeout only a receipt settles it; after
 * it, `sent` counts as heard (carrier took it, no receipt) and anything else
 * as a failed send.
 */
export function smsDeliveryVerdict(
  statuses: Array<{ status: string; errorCode?: number } | undefined>,
  sentAt: number,
  now: number,
): SmsDeliveryVerdict {
  const rejected = statuses.find((entry) => entry && SMS_REJECTED.has(entry.status));
  if (rejected) {
    return {
      kind: "undelivered",
      detail: `twilio ${rejected.status}${rejected.errorCode ? ` ${rejected.errorCode}` : ""}`,
    };
  }
  if (statuses.length > 0 && statuses.every((entry) => entry && SMS_RECEIVED.has(entry.status))) {
    return { kind: "delivered" };
  }
  if (now - sentAt < SMS_RECEIPT_TIMEOUT_MS) return { kind: "pending" };
  const sent = statuses.every((entry) => entry && (entry.status === "sent" || SMS_RECEIVED.has(entry.status)));
  return { kind: statuses.length > 0 && sent ? "sent" : "unconfirmed" };
}

export const DEFAULT_OWNER_PREFS: OwnerDeliveryPrefs = {
  textResultAfterMissedCall: true,
  textOutsideCallHours: true,
};

export type CallWindowVerdict = {
  /** A callback may ring now. */
  ok: boolean;
  /** Allowed only because the owner asked recently. */
  ownerRequested?: boolean;
  /** Owner-local 07:00–22:00: texting is fine even if calling is not. */
  civilHours: boolean;
  /** Next time a callback may ring (epoch ms), when not ok. */
  nextAt?: number;
};

export type DeliveryCapabilities = {
  /** Outbound PSTN callbacks are configured. */
  voice: boolean;
  /** The owner's mobile is known and SMS can be sent. */
  sms: boolean;
};

export type OwnerDeliveryPlanInput = {
  now: number;
  /** Items still to deliver (ready / offered). */
  items: OwnerOutboxItem[];
  presence: OwnerPresence;
  prefs: OwnerDeliveryPrefs;
  capabilities: DeliveryCapabilities;
  callWindow: (item: OwnerOutboxItem) => CallWindowVerdict;
};

export type OwnerDeliveryAction =
  | {
      type: "text";
      route: "sms" | "slack" | "telegram";
      itemId: string;
      /** Where to send: the origin (Slack/Telegram thread) or the owner's latest there. */
      address: RealtimeGoalOrigin;
      reason: string;
    }
  | { type: "surface"; itemId: string; reason: string }
  | { type: "call"; itemIds: string[]; reason: "due" | "owner_requested" }
  | { type: "wait"; itemId: string; reason: string; until?: number };

const TEXT_ROUTES = new Set<OwnerRoute>(["sms", "slack", "telegram"]);

function ms(iso: string | undefined): number {
  const parsed = Date.parse(iso ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function isTextRoute(route: OwnerRoute): route is "sms" | "slack" | "telegram" {
  return TEXT_ROUTES.has(route);
}

/** Natural route for an origin channel. */
export function routeForChannel(channel: RealtimeGoalChannel): OwnerRoute {
  switch (channel) {
    case "sms":
      return "sms";
    case "slack":
      return "slack";
    case "telegram":
      return "telegram";
    case "pstn_voice":
      return "voice";
    default:
      return "surface";
  }
}

export function ownerOnCall(presence: OwnerPresence, now: number): boolean {
  return Boolean(presence.activeCall && ms(presence.activeCall.leaseUntil) > now);
}

export function callInFlight(presence: OwnerPresence, now: number): boolean {
  return Boolean(presence.callInFlight && ms(presence.callInFlight.leaseUntil) > now);
}

export function callRequested(presence: OwnerPresence, now: number): boolean {
  const at = ms(presence.callRequestedAt);
  return Number.isFinite(at) && now - at < CALL_REQUEST_TTL_MS;
}

/** The owner's latest activity on a text channel, if it is recent. */
export function activeTextChannel(
  presence: OwnerPresence,
  now: number,
): { route: "sms" | "slack" | "telegram"; address: RealtimeGoalOrigin } | undefined {
  const last = presence.lastActivity;
  if (!last) return undefined;
  const route = routeForChannel(last.channel);
  if (!isTextRoute(route)) return undefined;
  if (now - ms(last.at) > TEXT_ACTIVE_WINDOW_MS) return undefined;
  return { route, address: last.origin };
}

/** The item missed at least one callback. */
export function missedByPhone(item: OwnerOutboxItem): boolean {
  return item.attempts.some(
    (attempt) => attempt.route === "voice" && MISSED_CALL_OUTCOMES.has(attempt.outcome),
  );
}

/** A carrier rejected an SMS of this item: it is not texted again. */
export function smsUndelivered(item: OwnerOutboxItem): boolean {
  return item.attempts.some((attempt) => attempt.route === "sms" && attempt.outcome === "undelivered");
}

/** The item can go by SMS: the box can text the owner and no SMS of it was rejected. */
export function smsUsable(item: OwnerOutboxItem, capabilities: DeliveryCapabilities): boolean {
  return capabilities.sms && !smsUndelivered(item);
}

/** Backoff after `misses` consecutive undelivered callbacks (0 = none). */
export function missBackoffMs(misses: number): number {
  if (misses <= 0) return 0;
  return MISS_BACKOFF_MS[Math.min(misses, MISS_BACKOFF_MS.length) - 1]!;
}

type Resolved =
  | { route: "sms" | "slack" | "telegram"; address: RealtimeGoalOrigin; reason: string }
  | { route: "surface"; reason: string }
  | { route: "voice"; reason: string };

/** Where the owner's owner-level SMS goes when the item did not come from SMS. */
function smsAddress(item: OwnerOutboxItem, presence: OwnerPresence): RealtimeGoalOrigin {
  if (item.origin.channel === "sms") return item.origin;
  const recentSms = presence.lastByChannel?.sms;
  return recentSms?.origin ?? { channel: "sms", sessionKey: "sms:owner" };
}

function resolveRoute(
  item: OwnerOutboxItem,
  input: OwnerDeliveryPlanInput,
): Resolved {
  const { presence, prefs, now, capabilities } = input;
  const natural = routeForChannel(item.origin.channel);
  const textAddress = (route: "sms" | "slack" | "telegram"): RealtimeGoalOrigin => {
    if (route === "sms") return smsAddress(item, presence);
    if (item.origin.channel === route) return item.origin;
    return presence.lastByChannel?.[route]?.origin ?? item.origin;
  };

  // 2. Owner said how.
  const override = item.routeOverride?.route;
  if (override) {
    if (isTextRoute(override)) return { route: override, address: textAddress(override), reason: "owner_route" };
    if (override === "surface") return { route: "surface", reason: "owner_route" };
    return { route: "voice", reason: "owner_route" };
  }
  const ownerDefault = prefs.defaultRoute && ms(prefs.defaultRoute.until) > now ? prefs.defaultRoute.route : undefined;

  // 8. "Call me back" by text must still call — texting it is exactly what they did not ask for.
  if (natural === "voice" && capabilities.voice && callRequested(presence, now)) {
    return { route: "voice", reason: "owner_requested_call" };
  }
  // 1. On a live call right now: the call offers it (even if they texted a minute ago).
  if (natural === "voice" && ownerOnCall(presence, now)) {
    return { route: "voice", reason: "owner_on_call" };
  }

  // 3. Owner is texting right now — answer where they are.
  const texting = activeTextChannel(presence, now);
  const smsRejected = texting?.route === "sms" && smsUndelivered(item);
  if (texting && !smsRejected && (natural === "voice" || natural === texting.route)) {
    return { route: texting.route, address: texting.address, reason: "owner_texting_now" };
  }

  // 4. Text and surface origins deliver on their own channel.
  if (isTextRoute(natural)) return { route: natural, address: textAddress(natural), reason: "origin_channel" };
  if (natural === "surface") return { route: "surface", reason: "origin_channel" };

  // Phone origin from here on.
  if (ownerDefault && ownerDefault !== "voice") {
    if (isTextRoute(ownerDefault)) {
      return { route: ownerDefault, address: textAddress(ownerDefault), reason: "owner_default_route" };
    }
    return { route: "surface", reason: "owner_default_route" };
  }
  if (!capabilities.voice) {
    return { route: "sms", address: textAddress("sms"), reason: "voice_unavailable" };
  }
  // 6. Missed by phone → text it (owner preference).
  // After an undelivered SMS, a missed item goes back to the callback rules.
  if (
    prefs.textResultAfterMissedCall &&
    missedByPhone(item) &&
    !callRequested(presence, now) &&
    !smsUndelivered(item)
  ) {
    return { route: "sms", address: textAddress("sms"), reason: "missed_call" };
  }
  return { route: "voice", reason: "origin_channel" };
}

/** Decide what happens to every undelivered item now. */
export function planOwnerDeliveries(input: OwnerDeliveryPlanInput): OwnerDeliveryAction[] {
  const { now, presence, prefs, capabilities } = input;
  const actions: OwnerDeliveryAction[] = [];
  const onCall = ownerOnCall(presence, now);
  const ringing = callInFlight(presence, now);
  const requested = callRequested(presence, now);
  const exhausted = presence.consecutiveMisses >= MAX_CONSECUTIVE_MISSES;
  const backoffUntil = ms(presence.backoffUntil);
  const inBackoff = Number.isFinite(backoffUntil) && backoffUntil > now;

  const callNow: string[] = [];
  const settling: Array<{ id: string; until: number }> = [];

  for (const item of input.items) {
    if (item.state !== "ready" && item.state !== "offered") continue;
    // 9. An SMS is out: wait for its delivery receipt (the dispatcher reads it).
    if (item.smsPending) {
      actions.push({ type: "wait", itemId: item.id, reason: "sms_pending", until: ms(item.smsPending.checkAt) });
      continue;
    }
    const leaseUntil = ms(item.lease?.until);
    if (Number.isFinite(leaseUntil) && leaseUntil > now) {
      actions.push({ type: "wait", itemId: item.id, reason: "in_flight", until: leaseUntil });
      continue;
    }
    const retryAt = ms(item.retryAt);
    if (Number.isFinite(retryAt) && retryAt > now) {
      actions.push({ type: "wait", itemId: item.id, reason: "retry_backoff", until: retryAt });
      continue;
    }

    const resolved = resolveRoute(item, input);
    const canText = smsUsable(item, capabilities);

    if (resolved.route === "sms" && !canText) {
      actions.push({ type: "wait", itemId: item.id, reason: capabilities.sms ? "sms_undelivered" : "sms_unavailable" });
      continue;
    }
    if (resolved.route !== "voice") {
      if (resolved.route === "surface") {
        actions.push({ type: "surface", itemId: item.id, reason: resolved.reason });
      } else {
        actions.push({
          type: "text",
          route: resolved.route,
          itemId: item.id,
          address: resolved.address,
          reason: resolved.reason,
        });
      }
      continue;
    }

    // 1. The live call offers it (the voice service pulls pending items).
    if (onCall) {
      actions.push({ type: "wait", itemId: item.id, reason: "owner_on_call" });
      continue;
    }
    if (ringing) {
      actions.push({ type: "wait", itemId: item.id, reason: "call_in_flight" });
      continue;
    }
    // 8. The owner asked to be called.
    if (requested) {
      callNow.push(item.id);
      continue;
    }
    // Phone is not reaching the owner right now: text instead when allowed.
    if (exhausted || inBackoff) {
      if (prefs.textResultAfterMissedCall && canText) {
        actions.push({
          type: "text",
          route: "sms",
          itemId: item.id,
          address: smsAddress(item, presence),
          reason: exhausted ? "phone_unreachable" : "call_backoff",
        });
      } else {
        actions.push({
          type: "wait",
          itemId: item.id,
          reason: exhausted ? "phone_unreachable" : "call_backoff",
          ...(inBackoff ? { until: backoffUntil } : {}),
        });
      }
      continue;
    }
    const window = input.callWindow(item);
    if (!window.ok) {
      // 7. Outside call hours: text during civil hours instead of calling tomorrow.
      if (prefs.textOutsideCallHours && window.civilHours && canText) {
        actions.push({
          type: "text",
          route: "sms",
          itemId: item.id,
          address: smsAddress(item, presence),
          reason: "outside_call_hours",
        });
      } else {
        actions.push({ type: "wait", itemId: item.id, reason: "quiet_hours", until: window.nextAt });
      }
      continue;
    }
    // 5. Batched callback after a short settle.
    const readyAt = ms(item.createdAt);
    const settleUntil = readyAt + CALLBACK_SETTLE_MS;
    if (Number.isFinite(readyAt) && settleUntil > now) {
      settling.push({ id: item.id, until: settleUntil });
      continue;
    }
    callNow.push(item.id);
  }

  if (callNow.length > 0 || (requested && !onCall && !ringing && capabilities.voice)) {
    // A call is going out anyway: settling items ride along.
    const itemIds = [...callNow, ...settling.map((entry) => entry.id)];
    actions.push({ type: "call", itemIds, reason: requested ? "owner_requested" : "due" });
  } else {
    for (const entry of settling) {
      actions.push({ type: "wait", itemId: entry.id, reason: "settling", until: entry.until });
    }
  }
  return actions;
}
