/**
 * Executes the owner delivery plan (outboxPolicy.ts): texts, surface events, and
 * batched callbacks. Each pass first reads the Twilio status of pending SMS. One dispatch runs at a time; `kick()` coalesces bursts
 * (broker tick, owner message, call ended) into one more pass.
 */
import type { OwnerCallBatch, OwnerOutbox } from "./outbox.js";
import {
  callRequested,
  planOwnerDeliveries,
  smsDeliveryVerdict,
  TEXT_LEASE_MS,
  type CallWindowVerdict,
  type DeliveryCapabilities,
  type OwnerDeliveryAction,
} from "./outboxPolicy.js";
import type { OwnerOutboxItem, RealtimeGoalOrigin } from "./types.js";

export type OutboxSendResult = {
  ok: boolean;
  providerId?: string;
  error?: string;
  /** SMS accepted, not delivered yet: the Twilio message SID of each part. */
  pendingIds?: string[];
};

export type OwnerOutboxSenders = {
  capabilities(): DeliveryCapabilities;
  callWindow(item: OwnerOutboxItem, now: number): Promise<CallWindowVerdict>;
  sendText(
    route: "sms" | "slack" | "telegram",
    address: RealtimeGoalOrigin,
    text: string,
    dedupeKey: string,
  ): Promise<OutboxSendResult>;
  /** Twilio status of one SMS that sendText returned in `pendingIds`. */
  smsStatus(sid: string): Promise<{ status: string; errorCode?: number }>;
  enqueueSurface(item: OwnerOutboxItem): Promise<OutboxSendResult>;
  placeCallback(batch: OwnerCallBatch): Promise<OutboxSendResult & { callSid?: string }>;
  /** A text reached the owner: record it on that channel's thread; bind a question so a reply answers it. */
  onTextDelivered?(
    item: OwnerOutboxItem,
    route: "sms" | "slack" | "telegram",
    address: RealtimeGoalOrigin,
    text: string,
  ): Promise<void>;
};

/**
 * Text for an item delivered on a text channel. Results that come back on the
 * channel they were asked on read exactly as before; anything else says what
 * it is about (and why it arrives by text).
 */
export function ownerTextForItem(item: OwnerOutboxItem, route: string, reason: string): string {
  const sameChannel = item.origin.channel === route;
  if (sameChannel && reason === "origin_channel") return item.text;
  const title = item.title.trim() || "your request";
  if (item.kind === "blocked") {
    return `Question about “${title}”:\n${item.text}\n\nReply here with your answer.`;
  }
  if (reason === "missed_call") {
    return `I tried calling about “${title}.” Here it is by text:\n\n${item.text}`;
  }
  if (reason === "outside_call_hours") {
    return `Your update on “${title}” — texting since it's outside your call hours:\n\n${item.text}`;
  }
  return `Update on “${title}”:\n\n${item.text}`;
}

function errorResult(error: unknown): OutboxSendResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export class OwnerOutboxDispatcher {
  private current: Promise<void> | undefined;
  private again = false;

  constructor(
    private readonly outbox: OwnerOutbox,
    private readonly senders: OwnerOutboxSenders,
  ) {}

  /** Fire-and-forget pass (owner activity, call ended, new result). */
  kick(): void {
    void this.dispatch().catch((error) => {
      console.warn(`[owner-outbox] dispatch failed: ${(error as Error).message}`);
    });
  }

  /** Resolves when this pass — and any pass requested while it ran — is done. */
  dispatch(): Promise<void> {
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = (async () => {
      try {
        do {
          this.again = false;
          await this.dispatchOnce();
        } while (this.again);
      } finally {
        this.current = undefined;
      }
    })();
    return this.current;
  }

  /** Read the Twilio status of each pending SMS that is due. True when one settled. */
  private async settlePendingSms(items: OwnerOutboxItem[], now: number): Promise<boolean> {
    let settled = false;
    for (const item of items) {
      const pending = item.smsPending;
      if (!pending || Date.parse(pending.checkAt) > now) continue;
      const statuses = await Promise.all(
        pending.sids.map((sid) => this.senders.smsStatus(sid).catch(() => undefined)),
      );
      const verdict = smsDeliveryVerdict(statuses, Date.parse(pending.sentAt), now);
      const heard = await this.outbox.settleSms(item.id, verdict);
      if (verdict.kind === "pending") continue;
      settled = true;
      console.info(
        `[owner-outbox] sms ${verdict.kind} item=${item.id} goal=${item.goalId ?? "-"} sids=${pending.sids.join(",")}` +
          `${verdict.kind === "undelivered" ? ` ${verdict.detail}` : ""}`,
      );
      if (heard) {
        await this.senders.onTextDelivered?.(heard.item, "sms", heard.address, heard.text).catch((error) => {
          console.warn(`[owner-outbox] post-delivery bookkeeping failed: ${(error as Error).message}`);
        });
      }
    }
    return settled;
  }

  private async dispatchOnce(): Promise<void> {
    let snapshot = await this.outbox.snapshot();
    const now = Date.now();
    if (await this.settlePendingSms(snapshot.items, now)) snapshot = await this.outbox.snapshot();
    if (snapshot.items.length === 0 && !callRequested(snapshot.presence, now)) return;
    const windows = new Map<string, CallWindowVerdict>();
    for (const item of snapshot.items) {
      windows.set(item.id, await this.senders.callWindow(item, now));
    }
    const actions = planOwnerDeliveries({
      now,
      items: snapshot.items,
      presence: snapshot.presence,
      prefs: snapshot.prefs,
      capabilities: this.senders.capabilities(),
      callWindow: (item) => windows.get(item.id) ?? { ok: false, civilHours: false },
    });
    for (const action of actions) {
      await this.execute(action).catch((error) => {
        console.warn(`[owner-outbox] ${action.type} failed: ${(error as Error).message}`);
      });
    }
  }

  private async execute(action: OwnerDeliveryAction): Promise<void> {
    if (action.type === "wait") return;

    if (action.type === "text") {
      const [item] = await this.outbox.claim([action.itemId], action.route, TEXT_LEASE_MS);
      if (!item) return;
      const text = ownerTextForItem(item, action.route, action.reason);
      const result = await this.senders
        .sendText(action.route, action.address, text, `${item.id}:${action.route}`)
        .catch(errorResult);
      await this.outbox.recordSend(item.id, action.route, result, { address: action.address, text });
      const pending = Boolean(result.pendingIds?.length);
      console.info(
        `[owner-outbox] ${result.ok ? (pending ? "texted, waiting for delivery receipt" : "texted") : "text failed"} ` +
          `item=${item.id} goal=${item.goalId ?? "-"} route=${action.route} reason=${action.reason}` +
          `${result.error ? ` error=${result.error}` : ""}`,
      );
      if (result.ok && !pending) {
        await this.senders.onTextDelivered?.(item, action.route, action.address, text).catch((error) => {
          console.warn(`[owner-outbox] post-delivery bookkeeping failed: ${(error as Error).message}`);
        });
      }
      return;
    }

    if (action.type === "surface") {
      const [item] = await this.outbox.claim([action.itemId], "surface", TEXT_LEASE_MS);
      if (!item) return;
      const result = await this.senders.enqueueSurface(item).catch(errorResult);
      await this.outbox.recordSend(item.id, "surface", result);
      return;
    }

    const batch = await this.outbox.startCallBatch(action.itemIds, action.reason === "owner_requested");
    if (!batch) return;
    const placed = await this.senders.placeCallback(batch).catch(errorResult);
    if (placed.ok && "callSid" in placed && placed.callSid) {
      await this.outbox.callPlaced(batch.id, placed.callSid);
      console.info(
        `[owner-outbox] callback placed batch=${batch.id} call=${placed.callSid} items=${batch.items.length} reason=${action.reason}`,
      );
      return;
    }
    await this.outbox.callPlacementFailed(batch.id, placed.error ?? "callback not placed");
    console.warn(`[owner-outbox] callback not placed batch=${batch.id}: ${placed.error ?? "unknown"}`);
  }
}
