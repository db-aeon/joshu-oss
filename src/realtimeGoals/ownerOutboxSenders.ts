/**
 * Production senders for the owner outbox dispatcher: Twilio SMS, Slack,
 * Telegram, browser surface events, and batched PSTN callbacks.
 */
import { randomUUID } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";

import { readAgentProfile, type NylasAgentProfile } from "../nylas/profile.js";
import { resolveOwnerTimezone } from "../ownerLocalTime.js";
import { readProactiveState } from "../proactive/state.js";
import type { ProactivePreferences } from "../proactive/types.js";
import {
  fetchSmsStatus,
  normalizePhone,
  ownerSmsPhone,
  sendSms,
  twilioSmsGatewayEnabled,
} from "../twilioSmsSend.js";
import type { RealtimeGoalBroker } from "./broker.js";
import {
  nextRealtimeGoalCallbackWindow,
  realtimeGoalCallbackWindow,
  withinCivilHours,
} from "./callbackWindow.js";
import { postSlackMessage, sendTelegramMessage } from "./delivery.js";
import type { OwnerOutboxSenders } from "./outboxDispatcher.js";
import type { OwnerOutboxItem, RealtimeGoalDeliveryKind } from "./types.js";
import { ownerCallbackConfigured, startOwnerCallback } from "./voiceCallback.js";

/** Profile + proactive preferences change rarely; one read per dispatch pass is plenty. */
const OWNER_CONTEXT_TTL_MS = 5_000;

export function createOwnerOutboxSenders(
  projectRoot: string,
  broker: RealtimeGoalBroker,
): OwnerOutboxSenders {
  let cached: { at: number; profile: NylasAgentProfile; preferences: ProactivePreferences } | undefined;
  const ownerContext = () => {
    const now = Date.now();
    if (cached && now - cached.at < OWNER_CONTEXT_TTL_MS) return cached;
    const profile = {
      ...(readAgentProfile(projectRoot) ?? {}),
      timezone: resolveOwnerTimezone(projectRoot),
    } as NylasAgentProfile;
    const preferences = readProactiveState(projectRoot, profile.timezone).preferences;
    cached = { at: now, profile, preferences };
    return cached;
  };

  return {
    capabilities: () => ({
      voice: ownerCallbackConfigured(projectRoot),
      sms: twilioSmsGatewayEnabled(projectRoot) && Boolean(ownerSmsPhone(projectRoot)),
    }),

    async callWindow(item: OwnerOutboxItem, now: number) {
      const goal = item.goalId ? await broker.store.get(item.goalId) : undefined;
      const callbackGoal = {
        ownerInteractedAt: goal?.ownerInteractedAt ?? item.createdAt,
        createdAt: goal?.createdAt ?? item.createdAt,
      };
      const { profile, preferences } = ownerContext();
      const instant = Temporal.Instant.fromEpochMilliseconds(now);
      const window = realtimeGoalCallbackWindow(callbackGoal, profile, preferences, instant);
      const next = window.ok
        ? undefined
        : Date.parse(nextRealtimeGoalCallbackWindow(callbackGoal, profile, preferences, now) ?? "");
      return {
        ok: window.ok,
        ownerRequested: window.ownerRequested,
        civilHours: withinCivilHours(profile, instant),
        ...(next !== undefined && Number.isFinite(next) ? { nextAt: next } : {}),
      };
    },

    async sendText(route, address, text, dedupeKey) {
      if (route === "sms") {
        const to =
          address.channel === "sms" && address.replyAddress?.trim()
            ? address.replyAddress.trim()
            : ownerSmsPhone(projectRoot);
        if (!to) return { ok: false, error: "owner mobile not configured" };
        // Twilio accepted the parts; the dispatcher waits for the delivery receipt.
        const sids = await sendSms(to, text);
        return sids.length > 0 ? { ok: true, pendingIds: sids } : { ok: false, error: "empty SMS" };
      }
      const sent =
        route === "slack"
          ? await postSlackMessage(projectRoot, {
              channel: address.replyAddress,
              threadTs: address.threadId,
              text,
              dedupeKey,
            })
          : await sendTelegramMessage(projectRoot, {
              chatId: address.replyAddress,
              threadId: address.threadId,
              text,
            });
      return { ok: sent.delivered, providerId: sent.providerId, error: sent.error };
    },

    smsStatus: (sid) => fetchSmsStatus(sid),

    async enqueueSurface(item) {
      if (!item.goalId) return { ok: false, error: "surface delivery needs a goal session" };
      const kind: RealtimeGoalDeliveryKind =
        item.kind === "blocked" ? "blocked" : item.kind === "failed" ? "failed" : "completed";
      const updated = await broker.store.update(item.goalId, (goal) => {
        const queued = goal.surfaceEvents?.some(
          (event) => event.kind === kind && event.text === item.text && !event.consumedAt,
        );
        if (queued) return;
        goal.surfaceEvents ??= [];
        goal.surfaceEvents.push({ id: randomUUID(), kind, text: item.text, createdAt: new Date().toISOString() });
      });
      return updated ? { ok: true } : { ok: false, error: "goal not found" };
    },

    placeCallback: (batch) => startOwnerCallback(projectRoot, batch),

    onTextDelivered: (item, route, address, text) => {
      // The SMS gateway keys the owner's thread as sms:<E.164>; use the same key so
      // a reply to a texted question binds to its goal.
      if (route === "sms") {
        const to = address.replyAddress?.trim() || ownerSmsPhone(projectRoot);
        const smsOrigin = { channel: "sms" as const, sessionKey: `sms:${normalizePhone(to)}`, replyAddress: to };
        return broker.recordOutboxTextDelivered(item, smsOrigin, text);
      }
      return broker.recordOutboxTextDelivered(item, address, text);
    },
  };
}
