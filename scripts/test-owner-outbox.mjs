#!/usr/bin/env npx tsx
/**
 * Owner outbox: delivery policy, delivery commands, store lifecycle, and a
 * replay of the 2026-09-26 canary phone session (results must reach the owner
 * within minutes, never twice, and "call me back" must call).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";

import { RealtimeGoalBroker } from "../src/realtimeGoals/broker.ts";
import { OwnerOutbox } from "../src/realtimeGoals/outbox.ts";
import { ownerTextForItem } from "../src/realtimeGoals/outboxDispatcher.ts";
import {
  CALLBACK_SETTLE_MS,
  DEFAULT_OWNER_PREFS,
  MISS_BACKOFF_MS,
  planOwnerDeliveries,
  SMS_RECEIPT_TIMEOUT_MS,
  SMS_STATUS_POLL_MS,
  smsDeliveryVerdict,
} from "../src/realtimeGoals/outboxPolicy.ts";
import {
  deterministicDeliveryCommand,
  routeRealtimeGoalMessage,
} from "../src/realtimeGoals/router.ts";
import { RealtimeGoalStore } from "../src/realtimeGoals/store.ts";

const temp = await mkdtemp(path.join(tmpdir(), "joshu-owner-outbox-"));
process.env.JOSHU_REALTIME_GOALS_STATE_DIR = path.join(temp, "state");
process.env.JOSHU_REALTIME_GOALS_CALLBACK_SECRET = "unit-test-secret";
process.env.JOSHU_REALTIME_GOALS_RELEASE_SECONDS = "60";
process.env.AROZ_DATA = path.join(temp, "aroz");
delete process.env.JOSHU_AROZ_USER;
delete process.env.JOSHU_DAY0_API_KEY;
delete process.env.OPENROUTER_API_KEY;
await mkdir(path.join(temp, "aroz", "files", "users", "owner", "Desktop", "joshu's files"), {
  recursive: true,
});

const iso = (ms) => new Date(ms).toISOString();

try {
  // ---- Policy table ----
  const T0 = Date.parse("2026-09-26T23:00:00Z");
  const phoneOrigin = { channel: "pstn_voice", sessionKey: "pstn:owner" };
  const smsOrigin = {
    channel: "sms",
    sessionKey: "sms:+13105550100",
    replyAddress: "+13105550100",
  };
  const item = (id, extra = {}) => ({
    id,
    ownerKey: "owner",
    goalId: `goal-${id}`,
    kind: "completed",
    title: `Title ${id}`,
    text: `Result ${id}`,
    contentKey: id,
    origin: phoneOrigin,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    state: "ready",
    attempts: [],
    ...extra,
  });
  const windowOk = () => ({ ok: true, civilHours: true });
  const plan = (items, presence = { consecutiveMisses: 0 }, options = {}) =>
    planOwnerDeliveries({
      now: options.now ?? T0 + CALLBACK_SETTLE_MS + 1_000,
      items,
      presence,
      prefs: { ...DEFAULT_OWNER_PREFS, ...(options.prefs ?? {}) },
      capabilities: { voice: true, sms: true, ...(options.caps ?? {}) },
      callWindow: options.window ?? windowOk,
    });
  const only = (actions, type) => actions.filter((action) => action.type === type);

  // Phone result past the settle → one callback.
  assert.deepEqual(plan([item("a")]), [{ type: "call", itemIds: ["a"], reason: "due" }]);
  // Still settling → wait.
  assert.equal(plan([item("a")], undefined, { now: T0 + 5_000 })[0].reason, "settling");
  // One due + one settling ride the same call.
  const batched = plan([item("a"), item("b", { createdAt: iso(T0 + CALLBACK_SETTLE_MS) })]);
  assert.deepEqual(only(batched, "call")[0].itemIds, ["a", "b"]);
  // Owner on an unlocked call: the live call offers it — never dial.
  const onCall = { consecutiveMisses: 0, activeCall: { callSid: "CAx", unlockedAt: iso(T0), leaseUntil: iso(T0 + 10 * 60_000) } };
  assert.equal(plan([item("a")], onCall)[0].reason, "owner_on_call");
  // A callback already ringing.
  const ringing = { consecutiveMisses: 0, callInFlight: { callSid: "CAy", batchId: "b1", since: iso(T0), leaseUntil: iso(T0 + 30 * 60_000), itemIds: [] } };
  assert.equal(plan([item("a")], ringing)[0].reason, "call_in_flight");
  // SMS request → answered by SMS (unchanged behavior).
  const smsAction = plan([item("s", { origin: smsOrigin })])[0];
  assert.equal(smsAction.type, "text");
  assert.equal(smsAction.route, "sms");
  assert.equal(smsAction.reason, "origin_channel");
  assert.equal(smsAction.address.replyAddress, "+13105550100");
  // Owner texting right now → phone result goes to that text thread.
  const texting = {
    consecutiveMisses: 0,
    lastActivity: { channel: "sms", at: iso(T0 + CALLBACK_SETTLE_MS - 60_000), origin: smsOrigin },
  };
  assert.equal(plan([item("a")], texting)[0].reason, "owner_texting_now");
  // Missed callback → full result by text (owner decision 2026-09-26).
  const missed = item("m", { attempts: [{ at: iso(T0), route: "voice", outcome: "voicemail_left" }] });
  const missedAction = plan([missed])[0];
  assert.equal(missedAction.type, "text");
  assert.equal(missedAction.reason, "missed_call");
  assert.match(ownerTextForItem(missed, "sms", "missed_call"), /^I tried calling about “Title m\.”/);
  // Missed-call texting off → back off instead.
  const backoff = { consecutiveMisses: 1, backoffUntil: iso(T0 + 20 * 60_000) };
  assert.equal(plan([missed], backoff, { prefs: { textResultAfterMissedCall: false } })[0].reason, "call_backoff");
  // New result during backoff → text it now.
  assert.equal(plan([item("n")], backoff)[0].reason, "call_backoff");
  assert.equal(plan([item("n")], backoff)[0].type, "text");
  // Two misses in a row → phone is not reaching the owner; text.
  assert.equal(plan([item("n")], { consecutiveMisses: 2 })[0].reason, "phone_unreachable");
  // "Call me back" → dial now, even in backoff, even while they are texting.
  const requested = { ...backoff, ...texting, callRequestedAt: iso(T0 + CALLBACK_SETTLE_MS) };
  assert.deepEqual(only(plan([item("a")], requested), "call"), [
    { type: "call", itemIds: ["a"], reason: "owner_requested" },
  ]);
  // "Call me back" with nothing pending still calls.
  assert.deepEqual(plan([], { consecutiveMisses: 0, callRequestedAt: iso(T0 + CALLBACK_SETTLE_MS) }), [
    { type: "call", itemIds: [], reason: "owner_requested" },
  ]);
  // Outside call hours: text in civil hours, wait overnight.
  const outside = () => ({ ok: false, civilHours: true });
  assert.equal(plan([item("a")], undefined, { window: outside })[0].reason, "outside_call_hours");
  const overnight = () => ({ ok: false, civilHours: false, nextAt: T0 + 8 * 3600_000 });
  assert.deepEqual(plan([item("a")], undefined, { window: overnight })[0], {
    type: "wait",
    itemId: "a",
    reason: "quiet_hours",
    until: T0 + 8 * 3600_000,
  });
  // Per-item and owner-wide route overrides.
  assert.equal(plan([item("o", { routeOverride: { route: "sms", reason: "x", at: iso(T0) } })])[0].reason, "owner_route");
  assert.equal(
    plan([item("a")], undefined, {
      prefs: { defaultRoute: { route: "sms", reason: "x", at: iso(T0), until: iso(T0 + 3600_000) } },
    })[0].reason,
    "owner_default_route",
  );
  // No callbacks configured → text.
  assert.equal(plan([item("a")], undefined, { caps: { voice: false } })[0].reason, "voice_unavailable");
  // SMS route but SMS not configured → wait.
  assert.equal(plan([item("s", { origin: smsOrigin })], undefined, { caps: { sms: false } })[0].reason, "sms_unavailable");
  // Leased / retrying items wait.
  assert.equal(plan([item("l", { lease: { route: "sms", until: iso(T0 + 3600_000) } })])[0].reason, "in_flight");
  assert.equal(plan([item("r", { retryAt: iso(T0 + 3600_000) })])[0].reason, "retry_backoff");
  // Surfaces and Slack keep their channel.
  assert.equal(plan([item("j", { origin: { channel: "jchat", sessionKey: "joshu-hermes-chat:x" } })])[0].type, "surface");
  const slack = plan([item("k", { origin: { channel: "slack", sessionKey: "slack:x", replyAddress: "C1", threadId: "1.2" } })])[0];
  assert.equal(slack.route, "slack");
  assert.equal(slack.address.threadId, "1.2");
  // On a live call beats "texting a few minutes ago".
  assert.equal(plan([item("a")], { ...texting, activeCall: onCall.activeCall })[0].reason, "owner_on_call");
  // Owner texting overrides a jChat surface? No — surfaces stay on their surface.
  assert.equal(plan([item("j", { origin: { channel: "jchat", sessionKey: "joshu-hermes-chat:x" } })], texting)[0].type, "surface");

  // ---- SMS delivery receipt (fleet audit 2026-10-10) ----
  const st = (status, errorCode) => ({ status, ...(errorCode ? { errorCode } : {}) });
  const early = T0 + 30_000;
  const late = T0 + SMS_RECEIPT_TIMEOUT_MS;
  assert.deepEqual(smsDeliveryVerdict([st("delivered"), st("read")], T0, early), { kind: "delivered" });
  assert.deepEqual(smsDeliveryVerdict([st("delivered"), st("undelivered", 30034)], T0, early), {
    kind: "undelivered",
    detail: "twilio undelivered 30034",
  });
  assert.deepEqual(smsDeliveryVerdict([st("failed", 30007)], T0, late), { kind: "undelivered", detail: "twilio failed 30007" });
  assert.deepEqual(smsDeliveryVerdict([st("sent"), st("delivered")], T0, early), { kind: "pending" });
  assert.deepEqual(smsDeliveryVerdict([st("queued")], T0, early), { kind: "pending" });
  assert.deepEqual(smsDeliveryVerdict([undefined], T0, early), { kind: "pending" });
  // No receipt after the timeout: `sent` is heard, anything else is a failed send.
  assert.deepEqual(smsDeliveryVerdict([st("sent"), st("delivered")], T0, late), { kind: "sent" });
  assert.deepEqual(smsDeliveryVerdict([st("sent"), st("sending")], T0, late), { kind: "unconfirmed" });
  assert.deepEqual(smsDeliveryVerdict([st("sent"), undefined], T0, late), { kind: "unconfirmed" });
  // A pending SMS holds the item: no second SMS, no callback.
  const smsPending = {
    sids: ["SM1"],
    sentAt: iso(T0),
    checkAt: iso(T0 + 3600_000),
    address: smsOrigin,
    text: "x",
  };
  assert.deepEqual(plan([item("p", { smsPending })])[0], {
    type: "wait",
    itemId: "p",
    reason: "sms_pending",
    until: T0 + 3600_000,
  });
  // After an undelivered SMS the item is never texted again; it takes the next route.
  const rejected = { at: iso(T0), route: "sms", outcome: "undelivered", detail: "twilio undelivered 30034" };
  const missedRejected = item("mr", {
    attempts: [{ at: iso(T0), route: "voice", outcome: "voicemail_left" }, rejected],
  });
  assert.deepEqual(plan([missedRejected]), [{ type: "call", itemIds: ["mr"], reason: "due" }]);
  assert.equal(plan([missedRejected], backoff)[0].type, "wait");
  assert.equal(plan([missedRejected], backoff)[0].reason, "call_backoff");
  assert.equal(plan([missedRejected], { consecutiveMisses: 2 })[0].type, "wait");
  assert.equal(plan([missedRejected], { consecutiveMisses: 2 })[0].reason, "phone_unreachable");
  assert.equal(plan([missedRejected], undefined, { window: outside })[0].reason, "quiet_hours");
  assert.equal(plan([missedRejected], texting)[0].type, "call", "owner texting by SMS does not bring SMS back");
  assert.equal(plan([missedRejected], undefined, { caps: { voice: false } })[0].reason, "sms_undelivered");
  assert.equal(plan([item("sr", { origin: smsOrigin, attempts: [rejected] })])[0].reason, "sms_undelivered");
  // A failed send (not a carrier rejection) is texted again after the backoff.
  const apiFailed = item("af", {
    attempts: [{ at: iso(T0), route: "voice", outcome: "voicemail_left" }, { at: iso(T0), route: "sms", outcome: "failed" }],
  });
  assert.equal(plan([apiFailed])[0].reason, "missed_call");

  // ---- Delivery commands ----
  const delivery = (text) => {
    const decision = deterministicDeliveryCommand(text);
    return decision ? { action: decision.deliveryAction, route: decision.deliveryRoute } : undefined;
  };
  // Dan's actual texts after the voicemail park (2026-09-26).
  assert.deepEqual(delivery("No please call back"), { action: "call_now", route: undefined });
  assert.deepEqual(delivery("No I am asking for you to call back"), { action: "call_now", route: undefined });
  // And on the RapidAPI call.
  assert.deepEqual(delivery("Okay, you don't need to call me back. Just email me the link."), {
    action: "set_route",
    route: "sms",
  });
  assert.deepEqual(delivery("Can you call me?"), { action: "call_now", route: undefined });
  assert.deepEqual(delivery("give me a call"), { action: "call_now", route: undefined });
  assert.deepEqual(delivery("call me when it's done"), { action: "set_route", route: "voice" });
  assert.equal(delivery("I'll call you back later"), undefined);
  assert.equal(delivery("call me an uber to the airport"), undefined);
  assert.equal(delivery("Hey are you still working on the Cancun flights?"), undefined);
  // Only when the outbox is on.
  const legacyRoute = await routeRealtimeGoalMessage({
    text: "No please call back",
    activeGoals: [],
    threadTurns: [],
    queueCapable: true,
  });
  assert.notEqual(legacyRoute.decision, "delivery");
  // Model-classified delivery (subtler wording) is normalized.
  const modelDelivery = await routeRealtimeGoalMessage(
    {
      text: "ugh just ring me whenever you have it",
      activeGoals: [],
      threadTurns: [],
      queueCapable: true,
      deliveryCommands: true,
    },
    {
      completionOverride: async () =>
        JSON.stringify({ decision: "delivery", confidence: 0.9, delivery_action: "call_now", reason: "wants call" }),
    },
  );
  assert.equal(modelDelivery.decision, "delivery");
  assert.equal(modelDelivery.deliveryAction, "call_now");

  // ---- Outbox store lifecycle ----
  const store = new RealtimeGoalStore(process.cwd());
  const outbox = new OwnerOutbox(store);
  const goalRecord = (id, extra = {}) => ({
    id,
    version: 1,
    title: `Goal ${id}`,
    objective: id,
    status: "done",
    origin: { ...phoneOrigin, messageId: `src-${id}` },
    sourceMessageId: `src-${id}`,
    idempotencyKey: `realtime-goal:v1:${id}`,
    createdAt: iso(Date.now()),
    updatedAt: iso(Date.now()),
    messages: [{ at: iso(Date.now()), role: "owner", text: id }],
    intakeReply: "Queued.",
    delivery: { state: "pending", attempts: 0 },
    ...extra,
  });

  // Migration first: legacy pending/parked deliveries move into the outbox once.
  await store.insert(goalRecord("legacy-parked", { resultSummary: "Parked result", delivery: { state: "parked", attempts: 1 } }));
  await store.insert(goalRecord("legacy-delivered", { resultSummary: "Heard", delivery: { state: "delivered", attempts: 1 } }));
  await store.transaction((state) => {
    state.callbackCooldowns = { "pstn_voice:pstn:owner": iso(Date.now() + 3600_000) };
    return { result: undefined, changed: true };
  });
  await outbox.ensureMigrated();
  await outbox.ensureMigrated();
  const migrated = await outbox.list();
  assert.equal(migrated.length, 1, "only the undelivered result migrates, once");
  assert.equal(migrated[0].goalId, "legacy-parked");
  assert.equal(migrated[0].state, "ready");
  assert.equal((await store.read()).callbackCooldowns, undefined, "the session-wide hold is retired");
  assert.equal((await store.get("legacy-parked")).delivery.state, "outbox");
  assert.ok(existsSync(path.join(temp, "state", "state.json.bak-owner-outbox")), "state backed up before migration");
  await outbox.markHeard([migrated[0].id], "sms", "channel_delivered");

  await store.insert(goalRecord("g1"));
  const first = await outbox.upsertForGoal("g1", "completed", "Result v1");
  assert.equal(first.created, true);
  assert.equal((await outbox.upsertForGoal("g1", "completed", "Result v1")).created, false, "same content is not re-enqueued");
  // The broker re-publishes a blocked goal's question every tick (2026-10-24):
  // the repeat must not rewrite state.json, or File Brain reindexes nonstop.
  const stateFile = path.join(temp, "state", "state.json");
  const beforeRepeat = { text: await readFile(stateFile, "utf8"), mtimeMs: (await stat(stateFile)).mtimeMs };
  await new Promise((resolve) => setTimeout(resolve, 20));
  await outbox.upsertForGoal("g1", "completed", "Result v1");
  await store.transaction(() => ({ result: undefined, changed: true }));
  assert.equal(await readFile(stateFile, "utf8"), beforeRepeat.text, "a repeat publish leaves state.json as it was");
  assert.equal((await stat(stateFile)).mtimeMs, beforeRepeat.mtimeMs, "an unchanged state is not written again");
  const second = await outbox.upsertForGoal("g1", "completed", "Result v2");
  assert.equal(second.created, true);
  assert.equal((await outbox.get(first.item.id)).state, "superseded", "new content supersedes unheard old content");

  const [claimed] = await outbox.claim([second.item.id], "sms", 60_000);
  assert.ok(claimed);
  assert.equal((await outbox.claim([second.item.id], "sms", 60_000)).length, 0, "a leased item cannot be claimed twice");
  await outbox.recordSend(second.item.id, "sms", { ok: false, error: "twilio 500" });
  const failedSend = await outbox.get(second.item.id);
  assert.equal(failedSend.state, "ready");
  assert.ok(Date.parse(failedSend.retryAt) > Date.now(), "failed sends back off");
  await outbox.recordSend(second.item.id, "sms", { ok: true });
  assert.equal((await outbox.get(second.item.id)).state, "heard");
  assert.equal((await outbox.get(second.item.id)).heard.evidence, "channel_delivered");

  // SMS accepted by Twilio: the item waits for the delivery receipt.
  const sent = { address: smsOrigin, text: "Question about it" };
  const smsItem = async (id) => {
    await store.insert(goalRecord(id));
    const created = (await outbox.upsertForGoal(id, "blocked", `Question ${id}`)).item;
    await outbox.claim([created.id], "sms", 60_000);
    await outbox.recordSend(created.id, "sms", { ok: true, pendingIds: ["SMa", "SMb"] }, sent);
    return created.id;
  };
  const deliveredId = await smsItem("sms-delivered");
  let pendingItem = await outbox.get(deliveredId);
  assert.equal(pendingItem.state, "ready");
  assert.equal(pendingItem.lease, undefined);
  assert.deepEqual(pendingItem.smsPending.sids, ["SMa", "SMb"]);
  assert.equal(pendingItem.attempts.at(-1).outcome, "pending");
  assert.equal(pendingItem.attempts.at(-1).providerId, "SMa,SMb");
  assert.equal(await outbox.settleSms(deliveredId, { kind: "pending" }), undefined);
  pendingItem = await outbox.get(deliveredId);
  assert.ok(Date.parse(pendingItem.smsPending.checkAt) > Date.now() + SMS_STATUS_POLL_MS - 5_000, "next status read later");
  const heardSms = await outbox.settleSms(deliveredId, { kind: "delivered" });
  assert.equal(heardSms.text, sent.text);
  assert.equal(heardSms.address.replyAddress, smsOrigin.replyAddress);
  pendingItem = await outbox.get(deliveredId);
  assert.equal(pendingItem.state, "heard");
  assert.deepEqual(pendingItem.heard.via, "sms");
  assert.equal(pendingItem.heard.evidence, "channel_delivered");
  assert.equal(pendingItem.smsPending, undefined);

  const undeliveredId = await smsItem("sms-undelivered");
  assert.equal(await outbox.settleSms(undeliveredId, { kind: "undelivered", detail: "twilio undelivered 30034" }), undefined);
  const undeliveredItem = await outbox.get(undeliveredId);
  assert.equal(undeliveredItem.state, "ready", "an undelivered SMS leaves the item open");
  assert.equal(undeliveredItem.heard, undefined);
  assert.equal(undeliveredItem.smsPending, undefined);
  assert.deepEqual(
    { route: undeliveredItem.attempts.at(-1).route, outcome: undeliveredItem.attempts.at(-1).outcome, detail: undeliveredItem.attempts.at(-1).detail },
    { route: "sms", outcome: "undelivered", detail: "twilio undelivered 30034" },
  );

  const sentId = await smsItem("sms-sent");
  assert.ok(await outbox.settleSms(sentId, { kind: "sent" }));
  assert.equal((await outbox.get(sentId)).heard.evidence, "sms_sent");
  assert.equal((await outbox.get(sentId)).attempts.at(-1).detail, "no delivery receipt");

  const unconfirmedId = await smsItem("sms-unconfirmed");
  assert.equal(await outbox.settleSms(unconfirmedId, { kind: "unconfirmed" }), undefined);
  const unconfirmed = await outbox.get(unconfirmedId);
  assert.equal(unconfirmed.state, "ready");
  assert.equal(unconfirmed.attempts.at(-1).outcome, "failed");
  assert.ok(Date.parse(unconfirmed.retryAt) > Date.now(), "an SMS without a final status is sent again after the backoff");
  for (const id of [undeliveredId, unconfirmedId]) await outbox.markHeard([id], "voice", "transcript_coverage");

  // Callback batch → voicemail → missed, backoff, items back to ready.
  await store.insert(goalRecord("g2"));
  await store.insert(goalRecord("g3"));
  const i2 = (await outbox.upsertForGoal("g2", "completed", "Result g2")).item;
  const i3 = (await outbox.upsertForGoal("g3", "completed", "Result g3")).item;
  const batch = await outbox.startCallBatch([i2.id, i3.id], false);
  assert.equal(batch.items.length, 2);
  assert.equal(await outbox.startCallBatch([i2.id], false), undefined, "one callback at a time");
  await outbox.callPlaced(batch.id, "CA-batch");
  await outbox.recordCallOutcome(batch.id, "CA-batch", "voicemail");
  const settled = await outbox.finishCall(batch.id, "CA-batch", "completed");
  assert.equal(settled.missed, true);
  assert.equal(settled.notHeard.length, 2);
  const afterMiss = await outbox.snapshot();
  assert.equal(afterMiss.presence.consecutiveMisses, 1);
  assert.ok(Date.parse(afterMiss.presence.backoffUntil) >= Date.now() + MISS_BACKOFF_MS[0] - 5_000);
  assert.equal(afterMiss.presence.callInFlight, undefined);
  assert.equal((await outbox.get(i2.id)).attempts.at(-1).outcome, "voicemail_left");
  // Any owner message ends the backoff.
  await outbox.noteOwnerActivity(smsOrigin);
  const afterContact = await outbox.snapshot();
  assert.equal(afterContact.presence.consecutiveMisses, 0);
  assert.equal(afterContact.presence.backoffUntil, undefined);
  assert.equal(afterContact.presence.lastByChannel.sms.origin.replyAddress, "+13105550100");

  // Live call: pending offers, not-heard on hang-up.
  await outbox.setActiveCall("CA-live");
  const pending = await outbox.pendingForCall("CA-live");
  assert.deepEqual(pending.map((entry) => entry.id).sort(), [i2.id, i3.id].sort());
  await outbox.markOffered([i2.id, i3.id], "CA-live");
  assert.equal((await outbox.pendingForCall("CA-live")).length, 0, "an item is offered once per call");
  await outbox.markHeard([i2.id], "voice", "transcript_coverage", "CA-live");
  await outbox.endActiveCall("CA-live");
  assert.equal((await outbox.get(i2.id)).state, "heard");
  assert.equal((await outbox.get(i3.id)).state, "ready");
  assert.equal((await outbox.get(i3.id)).attempts.at(-1).outcome, "not_heard");
  assert.equal((await outbox.snapshot()).presence.activeCall, undefined);
  await outbox.markHeard([i3.id], "sms", "channel_delivered");

  // ---- Replay: 2026-09-26 canary session ----
  await rm(path.join(temp, "state"), { recursive: true, force: true });
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-26T23:44:00Z") });

  const script = {
    "Flights from LAX to JFK on October 20th": { doneAt: "2026-09-26T23:46:53Z", summary: "Oct 20: cheapest nonstop $204 on Delta 7:40 AM." },
    "Flights from LAX to Cancun around Christmas": { doneAt: "2026-09-27T00:03:14Z", summary: "Cancun Dec 20-27: cheapest nonstop $838 on Delta." },
    "Flights from LAX to JFK on October 25th": { doneAt: "2026-09-27T00:16:56Z", summary: "Oct 25 LAX-JFK: $264 American, nonstop $349 Delta." },
    "Flights from JFK to LAX on October 25th": { doneAt: "2026-09-27T00:18:36Z", summary: "Oct 25 JFK-LAX: nonstop $294 Delta 8:00 AM." },
  };
  const tasks = new Map();
  let taskSeq = 0;
  const kanbanBridge = async (payload) => {
    if (payload.action === "create") {
      const taskId = `t_${++taskSeq}`;
      tasks.set(taskId, script[payload.title]);
      return { success: true, task_id: taskId, task: { task_id: taskId, status: "ready" } };
    }
    if (payload.action === "show") {
      const plan = tasks.get(payload.task_id);
      const done = plan && Date.now() >= Date.parse(plan.doneAt);
      return {
        success: true,
        task: done
          ? { task_id: payload.task_id, status: "done", latest_run: { summary: plan.summary } }
          : { task_id: payload.task_id, status: "running" },
      };
    }
    return { success: true };
  };

  const texts = [];
  const calls = [];
  let broker;
  const senders = {
    capabilities: () => ({ voice: true, sms: true }),
    callWindow: async () => ({ ok: true, civilHours: true }),
    sendText: async (route, address, text) => {
      texts.push({ at: iso(Date.now()), route, text });
      return { ok: true };
    },
    enqueueSurface: async () => ({ ok: true }),
    placeCallback: async (callBatch) => {
      const callSid = `CA-cb-${calls.length + 1}`;
      calls.push({
        at: iso(Date.now()),
        batchId: callBatch.id,
        callSid,
        ownerRequested: callBatch.ownerRequested,
        titles: callBatch.items.map((entry) => entry.title),
      });
      return { ok: true, callSid };
    },
    onTextDelivered: (entry, _route, address, text) => broker.recordOutboxTextDelivered(entry, address, text),
  };
  broker = new RealtimeGoalBroker(process.cwd(), undefined, {
    outboxSenders: () => senders,
    kanbanBridge,
  });

  const advanceTo = async (target, stepMs = 15_000) => {
    const end = Date.parse(target);
    while (Date.now() < end) {
      mock.timers.setTime(Math.min(end, Date.now() + stepMs));
      await broker.tick();
    }
  };
  const at = async (target) => {
    await advanceTo(target);
    await broker.dispatchOutbox();
  };
  const phone = (callSid, jobId) => ({ channel: "pstn_voice", sessionKey: "pstn:owner", sessionId: callSid, messageId: jobId });
  const sms = (sid) => ({ ...smsOrigin, sessionId: smsOrigin.sessionKey, messageId: sid });
  const startTask = (callSid, jobId, title) =>
    broker.defer({ origin: phone(callSid, jobId), text: `Intent: ${title}\nUser said: ${title}` }, title);
  const inboundCall = async (callSid, unlockAt) => {
    await at(unlockAt);
    await broker.recordVoicePresence(callSid, "unlocked");
  };
  const hangUp = async (callSid, when) => {
    await at(when);
    await broker.recordVoicePresence(callSid, "ended");
    await broker.dispatchOutbox();
  };
  const answerCallback = async (call, { heard = true } = {}) => {
    await broker.recordVoicePresence(call.callSid, "unlocked");
    const content = await broker.ownerOutbox.batch(call.batchId);
    const ids = content.items.map((entry) => entry.id);
    if (ids.length > 0) {
      await broker.ownerOutbox.markOffered(ids, call.callSid);
      if (heard) await broker.ownerOutbox.markHeard(ids, "voice", "transcript_coverage", call.callSid);
    }
  };
  const endCallback = async (call) => {
    await broker.recordVoicePresence(call.callSid, "ended");
    await broker.recordBatchCallStatus(call.batchId, "completed", call.callSid);
    await broker.dispatchOutbox();
  };
  const heardAt = async (title) => {
    const state = await broker.store.read();
    const goal = state.goals.find((candidate) => candidate.title === title);
    const heard = (state.outbox ?? []).find((entry) => entry.goalId === goal?.id && entry.state === "heard");
    return heard ? Date.parse(heard.heard.at) : undefined;
  };

  // 16:43 PT — inbound call, "research LAX→JFK Oct 20" (start_task).
  await inboundCall("CA-in-1", "2026-09-26T23:43:44Z");
  await at("2026-09-26T23:44:13Z");
  await startTask("CA-in-1", "job-oct20", "Flights from LAX to JFK on October 20th");
  await hangUp("CA-in-1", "2026-09-26T23:44:25Z");

  // Worker finishes 16:46:53; one callback after the settle. It reaches voicemail.
  await at("2026-09-26T23:48:00Z");
  assert.equal(calls.length, 1, "a callback for the Oct 20 result");
  assert.deepEqual(calls[0].titles, ["Flights from LAX to JFK on October 20th"]);
  await broker.recordBatchCallStatus(calls[0].batchId, "", calls[0].callSid, "machine_start");
  await broker.recordBatchCallStatus(calls[0].batchId, "completed", calls[0].callSid);
  await broker.dispatchOutbox();
  assert.equal(texts.length, 1, "missed callback → the full result by text, right away");
  assert.match(texts[0].text, /I tried calling about “Flights from LAX to JFK on October 20th\.”/);
  assert.match(texts[0].text, /\$204/);

  // 16:49 PT — "No please call back" → a call, not "I'll stop the call request".
  await at("2026-09-26T23:49:27Z");
  const callBack = await broker.route({ origin: sms("SM-1"), text: "No please call back" });
  assert.equal(callBack.action, "reply");
  assert.equal(callBack.text, "Calling you now.");
  await broker.dispatchOutbox();
  assert.equal(calls.length, 2, "owner-requested callback placed");
  assert.equal(calls[1].ownerRequested, true);
  await at("2026-09-26T23:49:45Z");
  await answerCallback(calls[1]);
  await at("2026-09-26T23:50:40Z");
  await endCallback(calls[1]);

  // 16:57 PT — inbound call, Cancun (start_task). Done 17:03:14.
  await inboundCall("CA-in-2", "2026-09-26T23:56:39Z");
  await at("2026-09-26T23:57:04Z");
  await startTask("CA-in-2", "job-cancun", "Flights from LAX to Cancun around Christmas");
  await hangUp("CA-in-2", "2026-09-26T23:57:19Z");
  await at("2026-09-27T00:04:30Z");
  assert.equal(calls.length, 3, "Cancun callback shortly after the worker finished");
  assert.deepEqual(calls[2].titles, ["Flights from LAX to Cancun around Christmas"]);
  await at("2026-09-27T00:04:45Z");
  await answerCallback(calls[2]);
  await at("2026-09-27T00:05:30Z");
  await endCallback(calls[2]);

  // 17:08 PT — "still working on the Cancun flights?" — SMS Hermes must see the phone goal.
  await at("2026-09-27T00:08:43Z");
  const status = await broker.route({ origin: sms("SM-3"), text: "Hey are you still working on the Cancun flights?" });
  assert.equal(status.action, "pass");
  const snapshot = await broker.buildHermesContextSnapshot(sms("SM-3"));
  assert.match(snapshot, /Flights from LAX to Cancun around Christmas/);
  assert.match(snapshot, /\$838/);
  assert.match(snapshot, /asked by phone/);
  assert.match(snapshot, /owner heard it by phone/);
  assert.match(snapshot, /Joshu CAN call the owner/);

  // 17:14 PT — two inbound calls; Oct 25 out and back queued. Out finishes 00:16:56
  // while the owner is still on the second call; back finishes 00:18:36.
  await inboundCall("CA-in-3", "2026-09-27T00:14:00Z");
  await at("2026-09-27T00:14:37Z");
  await startTask("CA-in-3", "job-oct25-out", "Flights from LAX to JFK on October 25th");
  await hangUp("CA-in-3", "2026-09-27T00:14:50Z");
  await inboundCall("CA-in-4", "2026-09-27T00:15:22Z");
  await at("2026-09-27T00:16:39Z");
  await startTask("CA-in-4", "job-oct25-back", "Flights from JFK to LAX on October 25th");
  await at("2026-09-27T00:16:56Z");
  assert.equal(calls.length, 3, "no dialing while the owner is on a call");
  await hangUp("CA-in-4", "2026-09-27T00:16:57Z");
  await at("2026-09-27T00:18:00Z");
  assert.equal(calls.length, 4, "Oct 25 out: callback right after the owner hung up + settle");
  assert.deepEqual(calls[3].titles, ["Flights from LAX to JFK on October 25th"]);
  await at("2026-09-27T00:18:10Z");
  await answerCallback(calls[3]);
  // Oct 25 back finishes mid-call: offered on this call, not a second call.
  await at("2026-09-27T00:18:45Z");
  const midCall = await broker.ownerOutbox.pendingForCall(calls[3].callSid);
  assert.deepEqual(midCall.map((entry) => entry.title), ["Flights from JFK to LAX on October 25th"]);
  await broker.ownerOutbox.markOffered(midCall.map((entry) => entry.id), calls[3].callSid);
  await broker.ownerOutbox.markHeard(midCall.map((entry) => entry.id), "voice", "transcript_coverage", calls[3].callSid);
  await at("2026-09-27T00:19:40Z");
  await endCallback(calls[3]);
  await at("2026-09-27T01:30:00Z", 60_000);

  // Every result heard within 5 min of the worker finishing — or texted after the miss.
  for (const [title, { doneAt }] of Object.entries(script)) {
    const heard = await heardAt(title);
    assert.ok(heard, `${title} was heard`);
    const lagMs = heard - Date.parse(doneAt);
    assert.ok(lagMs <= 5 * 60_000, `${title} heard ${Math.round(lagMs / 1000)}s after done (was 44-52 min)`);
  }
  assert.equal(calls.length, 4, "no duplicate or late callbacks");
  assert.equal(texts.length, 1, "only the missed result was texted");
  const spokenTitles = calls.flatMap((call) => call.titles);
  assert.equal(new Set(spokenTitles).size, spokenTitles.length, "no result offered on two callbacks");

  mock.timers.reset();

  // ---- Replay: box darien 2026-10-09 — two voicemails, SMS undelivered (30034) ----
  await rm(path.join(temp, "state"), { recursive: true, force: true });
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T17:40:00Z") });
  const smsSends = [];
  const darienCalls = [];
  const delivered = [];
  const smsStatuses = new Map();
  const darienSenders = {
    capabilities: () => ({ voice: true, sms: true }),
    callWindow: async () => ({ ok: true, civilHours: true }),
    sendText: async (route, _address, text) => {
      const sids = [1, 2].map((part) => `SM-${smsSends.length + 1}-${part}`);
      smsSends.push({ route, text, sids });
      return { ok: true, pendingIds: sids };
    },
    smsStatus: async (sid) => smsStatuses.get(sid) ?? { status: "sent" },
    enqueueSurface: async () => ({ ok: true }),
    placeCallback: async (callBatch) => {
      const callSid = `CA-d-${darienCalls.length + 1}`;
      darienCalls.push({ batchId: callBatch.id, callSid, items: callBatch.items.length });
      return { ok: true, callSid };
    },
    onTextDelivered: async (entry, route) => {
      delivered.push({ id: entry.id, route });
    },
  };
  const darien = new RealtimeGoalBroker(process.cwd(), undefined, {
    outboxSenders: () => darienSenders,
    kanbanBridge: async () => ({ success: true }),
  });
  const pass = async (target) => {
    mock.timers.setTime(Date.parse(target));
    await darien.dispatchOutbox();
  };
  const voicemail = async (call) => {
    await darien.recordBatchCallOutcome(call.batchId, call.callSid, "voicemail");
    await darien.recordBatchCallStatus(call.batchId, "completed", call.callSid);
  };
  await darien.store.insert(goalRecord("darien-phone", { status: "blocked", lastBlockReason: "Which number?" }));
  const question = (await darien.ownerOutbox.upsertForGoal("darien-phone", "blocked", "Which number should I use?")).item;
  await pass("2026-10-09T17:43:00Z");
  assert.equal(darienCalls.length, 1, "first callback");
  await voicemail(darienCalls[0]);
  // Missed callback → the question by SMS; Twilio accepted it.
  await pass("2026-10-09T17:44:00Z");
  assert.equal(smsSends.length, 1);
  assert.equal((await darien.ownerOutbox.get(question.id)).state, "ready", "accepted is not heard");
  // While the SMS is pending: no second SMS and no callback, even after the miss backoff.
  await pass("2026-10-09T17:44:10Z");
  await pass("2026-10-09T17:50:00Z");
  assert.equal(smsSends.length, 1);
  assert.equal(darienCalls.length, 1);
  // Carrier rejects both parts (unregistered A2P number).
  for (const sid of smsSends[0].sids) smsStatuses.set(sid, { status: "undelivered", errorCode: 30034 });
  await pass("2026-10-09T17:50:20Z");
  let open = await darien.ownerOutbox.get(question.id);
  assert.equal(open.state, "ready", "the owner never saw the question: the item stays open");
  assert.equal(open.attempts.at(-1).outcome, "undelivered");
  assert.equal(open.attempts.at(-1).detail, "twilio undelivered 30034");
  assert.equal(delivered.length, 0, "no thread record for an undelivered SMS");
  // Next route: the callback rules — not during the 10 min backoff after the first miss.
  await pass("2026-10-09T17:51:00Z");
  assert.equal(darienCalls.length, 1);
  assert.equal(smsSends.length, 1);
  await pass("2026-10-09T17:56:00Z");
  assert.equal(darienCalls.length, 2, "second callback instead of a second SMS");
  await voicemail(darienCalls[1]);
  // Two misses: phone unreachable, SMS rejected → the item waits; no SMS ever again.
  await pass("2026-10-09T18:30:00Z");
  await pass("2026-10-09T19:30:00Z");
  assert.equal(smsSends.length, 1, "an item with an undelivered SMS is not texted again");
  assert.equal(darienCalls.length, 2);
  open = await darien.ownerOutbox.get(question.id);
  assert.equal(open.state, "ready");
  // The owner writes in web chat: misses reset, and the callback rules call again.
  await darien.ownerOutbox.noteOwnerActivity({ channel: "jchat", sessionKey: "joshu-hermes-chat:owner" });
  await pass("2026-10-09T19:31:00Z");
  assert.equal(darienCalls.length, 3, "owner contact brings the callback back");
  // The next unlocked call offers the question.
  await darien.recordBatchCallStatus(darienCalls[2].batchId, "completed", darienCalls[2].callSid);
  await darien.ownerOutbox.setActiveCall("CA-in-darien");
  assert.deepEqual((await darien.ownerOutbox.pendingForCall("CA-in-darien")).map((entry) => entry.id), [question.id]);
  await darien.ownerOutbox.endActiveCall("CA-in-darien");

  // Delivered SMS → heard, recorded on the thread once.
  await darien.store.insert(goalRecord("darien-sms", { origin: { ...smsOrigin, messageId: "src-darien-sms" } }));
  const answer = (await darien.ownerOutbox.upsertForGoal("darien-sms", "completed", "Done.")).item;
  await pass("2026-10-09T19:40:00Z");
  assert.equal(smsSends.length, 2);
  for (const sid of smsSends[1].sids) smsStatuses.set(sid, { status: "delivered" });
  await pass("2026-10-09T19:40:20Z");
  assert.equal((await darien.ownerOutbox.get(answer.id)).heard.evidence, "channel_delivered");
  assert.deepEqual(delivered, [{ id: answer.id, route: "sms" }]);

  // No receipt: status `sent` for 10 minutes → heard as `sms_sent`.
  await darien.store.insert(goalRecord("darien-noreceipt", { origin: { ...smsOrigin, messageId: "src-darien-nr" } }));
  const quiet = (await darien.ownerOutbox.upsertForGoal("darien-noreceipt", "completed", "Done too.")).item;
  await pass("2026-10-09T20:00:00Z");
  assert.equal(smsSends.length, 3);
  await pass("2026-10-09T20:05:00Z");
  assert.equal((await darien.ownerOutbox.get(quiet.id)).state, "ready", "still waiting for a receipt");
  await pass("2026-10-09T20:10:30Z");
  assert.equal((await darien.ownerOutbox.get(quiet.id)).heard.evidence, "sms_sent");
  assert.equal(smsSends.length, 3, "no resend");
  assert.equal(delivered.length, 2);

  mock.timers.reset();
  console.log("test-owner-outbox: ok");
} finally {
  mock.timers.reset();
  await rm(temp, { recursive: true, force: true });
}
