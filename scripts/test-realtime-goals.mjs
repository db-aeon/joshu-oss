#!/usr/bin/env npx tsx
/**
 * Focused unit/contract tests for durable realtime goal intake.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyRealtimeGoalMessage,
  isExplicitCancelPhrase,
  routeRealtimeGoalMessage,
} from "../src/realtimeGoals/router.ts";
import { RealtimeGoalBroker } from "../src/realtimeGoals/broker.ts";
import {
  isDeferCapableChannel,
  isQueueCapableChannel,
} from "../src/realtimeGoals/channelPolicy.ts";
import {
  isRepeatOfAnsweredQuestion,
  normalizeOwnerAnswer,
  ownerAnswerKanbanAppend,
} from "../src/realtimeGoals/blockedAnswer.ts";
import {
  autoRecoveryKanbanAppend,
  classifyBlockCause,
} from "../src/realtimeGoals/blockCause.ts";
import {
  describeCallbackTime,
  nextRealtimeGoalCallbackWindow,
  realtimeGoalCallbackWindow,
} from "../src/realtimeGoals/callbackWindow.ts";
import { Temporal } from "@js-temporal/polyfill";
import {
  MAX_VOICE_CALLBACK_ATTEMPTS,
  answeredByOutcome,
  settleUndeliveredCallback,
} from "../src/realtimeGoals/voiceDeliveryPolicy.ts";
import { buildHermesBrokerContextMessage } from "../src/realtimeGoals/brokerContext.ts";
import {
  RealtimeGoalStore,
  realtimeGoalDeliveryContentKey,
} from "../src/realtimeGoals/store.ts";
import { SessionThreadStore } from "../src/realtimeGoals/sessionThread.ts";
import {
  realtimeGoalSessionKey,
} from "../src/realtimeGoals/types.ts";
import {
  realtimeGoalVoiceToken,
  verifyRealtimeGoalVoiceToken,
} from "../src/realtimeGoals/voiceCallback.ts";
import { formatOwnerCompletion } from "../src/realtimeGoals/ownerDelivery.ts";
import {
  extractLinks,
  linkDeliveryNote,
  speakableWithoutLinks,
} from "../src/realtimeGoals/voiceLinks.ts";
import {
  EA_KANBAN_BOARDS,
  REALTIME_GOALS_KANBAN_BOARD,
  eaKanbanCreateDefaults,
} from "../src/hermesKanbanBridge.ts";
import { verifyArozosDesktopSession } from "../src/httpLocalhost.ts";

const temp = await mkdtemp(path.join(tmpdir(), "joshu-realtime-goals-"));
process.env.JOSHU_REALTIME_GOALS_STATE_DIR = temp;
process.env.JOSHU_REALTIME_GOALS_CALLBACK_SECRET = "unit-test-secret";
delete process.env.JOSHU_DAY0_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const now = new Date().toISOString();
const goal = {
  id: "goal-1",
  version: 1,
  title: "Research Fareed Zakaria AI article",
  objective: "Research Fareed Zakaria AI article from Washington Post",
  status: "queued",
  origin: {
    channel: "sms",
    sessionKey: "sms:+15555550123",
    messageId: "SM123",
    replyAddress: "+15555550123",
  },
  sourceMessageId: "SM123",
  idempotencyKey: "realtime-goal:v1:test",
  createdAt: now,
  updatedAt: now,
  releaseAt: new Date(Date.now() + 60_000).toISOString(),
  messages: [{ at: now, role: "owner", text: "Research Fareed Zakaria AI article from Washington Post" }],
  intakeReply: "Queued.",
  delivery: { state: "pending", attempts: 0 },
};

try {
  const store = new RealtimeGoalStore(process.cwd());
  const threads = new SessionThreadStore(process.cwd());
  assert.equal((await store.insert(goal)).id, goal.id);
  assert.equal((await store.insert({ ...goal, id: "duplicate" })).id, goal.id);
  assert.equal((await store.read()).goals.length, 1, "source event must be idempotent");

  const session = realtimeGoalSessionKey(goal.origin);
  assert.equal((await store.listActiveForSession(session)).length, 1);
  await store.update(goal.id, (item) => {
    item.kanbanTaskId = "t_goal";
    item.status = "ready";
    item.delivery.state = "delivered";
  });
  assert.equal(
    (await store.listOutstanding()).length,
    1,
    "nonterminal tasks must reconcile even after a blocked event was delivered",
  );

  await threads.recordOwnerTurn("sms:+15555550123", "Research article", "SM-owner-1");
  await threads.recordBoxTurn(
    "sms:+15555550123",
    "This will take a little longer, so I queued it. I'll reply here when it's done. Anything else?",
    "broker",
    goal.id,
  );
  assert.equal((await threads.getTurns("sms:+15555550123")).length, 2);
  assert.equal(
    await threads.recordOwnerTurn("sms:+15555550123", "Research article", "SM-owner-1"),
    false,
    "messageId idempotency must skip duplicate owner turns",
  );

  await store.reserveInbound({
    id: "sms:SM-INBOX",
    origin: {
      channel: "sms",
      sessionKey: "sms:+15555550123",
      messageId: "SM-INBOX",
      replyAddress: "+15555550123",
    },
    text: "Durably reserve me before Twilio ACK",
    receivedAt: new Date(Date.now() - 1_000).toISOString(),
  });
  assert.equal((await store.listStaleInbound(0)).length, 1);
  await store.completeInbound("sms:SM-INBOX");
  assert.equal((await store.listStaleInbound(0)).length, 0);

  await store.update(goal.id, (item) => {
    item.delivery.state = "pending";
    item.delivery.attempts = 0;
    item.delivery.lastDeliveredKey = undefined;
  });
  const contentKey = realtimeGoalDeliveryContentKey("completed", "Hotel shortlist ready.");
  const firstClaim = await store.claimDeliveryAttempt(goal.id, "completed", "Hotel shortlist ready.", 5);
  assert.equal(firstClaim.claimed, true, "first delivery claim must win");
  await store.finalizeDeliveryAttempt(goal.id, contentKey, { delivered: true }, 5);
  const duplicateClaim = await store.claimDeliveryAttempt(goal.id, "completed", "Hotel shortlist ready.", 5);
  assert.equal(duplicateClaim.claimed, false, "duplicate completion SMS must be suppressed");
  const concurrentClaim = await store.claimDeliveryAttempt(goal.id, "completed", "Hotel shortlist ready.", 5);
  assert.equal(duplicateClaim.claimed, false, "delivered content key must block re-send");
  assert.equal(concurrentClaim.claimed, false, "delivered content key must block re-send");

  const hotelMenu =
    "No Loop-area hotel is under $250/night. Holiday Inn ($646), Ohio House ($638). Which one do you want me to hold?";
  const answeredGoal = {
    blockedAnsweredAt: now,
    lastBlockedPrompt: hotelMenu,
  };
  assert.equal(
    isRepeatOfAnsweredQuestion(answeredGoal, hotelMenu),
    true,
    "exact repeat of an answered question is detected",
  );
  assert.equal(
    isRepeatOfAnsweredQuestion(answeredGoal, `${hotelMenu} `),
    true,
    "trimmed repeat of an answered question is detected",
  );
  assert.equal(
    isRepeatOfAnsweredQuestion(answeredGoal, "Which one do you want me to hold — confirm 2 nights?"),
    false,
    "a different question is not a repeat (no task-specific phrase lists)",
  );
  assert.equal(
    isRepeatOfAnsweredQuestion({}, hotelMenu),
    false,
    "blocked prompt without prior answer is not a repeat",
  );
  assert.equal(normalizeOwnerAnswer("  lets   do  holiday inn  "), "lets do holiday inn");

  // Canary box 2026-09-24: a flight status question was appended as
  // "Owner selection — BOOK THIS". Answers are now task-neutral.
  const answerAppend = ownerAnswerKanbanAppend({
    text: "Tuesday the 29th, back Friday",
    at: now,
    sourceId: "CA1:3",
    question: "Which dates do you want to fly?",
  });
  assert.match(answerAppend, /## Owner answer/);
  assert.match(answerAppend, /You asked: Which dates do you want to fly\?/);
  assert.match(answerAppend, /Owner replied: Tuesday the 29th, back Friday/);
  assert.doesNotMatch(answerAppend, /BOOK THIS|checkout|re-search/i, "answer append must not assume booking");

  // Block cause: only a real worker question reaches the owner.
  assert.deepEqual(
    classifyBlockCause({
      status: "blocked",
      block_reason: "Aisle or window?",
      block_cause: { source: "worker", event: "blocked", reason: "Aisle or window seat?" },
    }),
    { kind: "owner_question", question: "Aisle or window seat?" },
  );
  const gaveUp = classifyBlockCause({
    status: "blocked",
    // Stale reason from an earlier block must not be re-asked.
    block_reason: "Which hotel do you want?",
    block_cause: {
      source: "system",
      event: "gave_up",
      trigger: "crashed",
      protocol_violations: 3,
      error: "worker exited cleanly without kanban_complete",
    },
  });
  assert.equal(gaveUp.kind, "system", "Hermes circuit breaker is a system stall, not a question");
  assert.match(gaveUp.detail, /exits_without_complete_or_block=3/);
  assert.equal(
    classifyBlockCause({ status: "blocked", block_reason: null }).kind,
    "system",
    "reasonless block on an older bridge is a system stall",
  );
  assert.equal(
    classifyBlockCause({ status: "blocked", block_cause: { source: "worker", reason: "blocked" } }).kind,
    "system",
    "placeholder reason is not a question",
  );
  // Callback window: a callback the owner just asked for rings in the evening
  // (canary box 2026-09-24: 8:08 PM request, result ready 8:11 PM, deferred to 9 AM).
  {
    const profile = { timezone: "America/Los_Angeles" };
    const prefs = { allowEvenings: false, allowWeekends: false, offHoursAskedAt: null, notes: [] };
    const at = (iso) => Temporal.Instant.from(iso);
    const evening = at("2026-09-25T03:11:00Z"); // Thu 8:11 PM PDT
    const requested = { createdAt: "2026-09-25T03:08:11Z", ownerInteractedAt: "2026-09-25T03:08:11Z" };
    const stale = { createdAt: "2026-09-24T15:00:00Z", ownerInteractedAt: "2026-09-24T15:00:00Z" };
    assert.deepEqual(realtimeGoalCallbackWindow(requested, profile, prefs, evening), { ok: true, ownerRequested: true });
    assert.equal(realtimeGoalCallbackWindow(stale, profile, prefs, evening).reason, "after_working_hours");
    assert.equal(
      realtimeGoalCallbackWindow(requested, profile, prefs, at("2026-09-25T05:30:00Z")).reason, // 10:30 PM
      "owner_quiet_hours",
    );
    assert.equal(
      realtimeGoalCallbackWindow(stale, profile, prefs, at("2026-09-24T18:00:00Z")).ok, // 11 AM weekday
      true,
      "working hours still apply to every callback",
    );
    // Requested at 10:30 PM: by 7 AM the request is >6h old, so plain working hours (8 AM) apply.
    const late = { createdAt: "2026-09-25T05:30:00Z", ownerInteractedAt: "2026-09-25T05:30:00Z" };
    const next = nextRealtimeGoalCallbackWindow(late, profile, prefs, Date.parse("2026-09-25T05:30:00Z"));
    assert.equal(next, "2026-09-25T15:00:00.000Z", "8:00 AM PDT once the request is stale");
    assert.equal(
      describeCallbackTime(next, "America/Los_Angeles", Date.parse("2026-09-25T05:30:00Z")),
      "8:00 AM tomorrow",
    );
  }

  const browserDown = classifyBlockCause({
    status: "blocked",
    block_cause: { source: "worker", event: "blocked", reason: "system: browser unavailable" },
  });
  assert.equal(browserDown.kind, "system", "worker-flagged infrastructure is not an owner question");
  assert.match(browserDown.detail, /system: browser unavailable/);
  assert.equal(
    classifyBlockCause({ status: "blocked", block_reason: "System: browser unavailable" }).kind,
    "system",
    "legacy bridge: system: reasons are not owner questions either",
  );
  const recoveryNote = autoRecoveryKanbanAppend({
    at: now,
    attempt: 1,
    maxAttempts: 2,
    why: "the previous worker run stopped without kanban_complete or kanban_block",
  });
  assert.match(recoveryNote, /Joshu recovery/);
  assert.match(recoveryNote, /kanban_complete/);
  assert.match(recoveryNote, /never a generic/);

  // Voice redial policy.
  assert.equal(answeredByOutcome("machine_start"), "voicemail");
  assert.equal(answeredByOutcome("fax"), "voicemail");
  assert.equal(answeredByOutcome("human"), undefined);
  assert.equal(answeredByOutcome("unknown"), undefined);
  assert.equal(settleUndeliveredCallback({ attempts: 1, outcome: "voicemail" }).action, "park");
  assert.equal(settleUndeliveredCallback({ attempts: 1, outcome: "auth_failed" }).action, "park");
  const firstRetry = settleUndeliveredCallback({ attempts: 1, twilioStatus: "no-answer", nowMs: 0 });
  assert.equal(firstRetry.action, "retry");
  assert.equal(firstRetry.action === "retry" && Date.parse(firstRetry.retryAt), 15 * 60_000);
  const secondRetry = settleUndeliveredCallback({ attempts: 2, outcome: "no_unlock", nowMs: 0 });
  assert.equal(secondRetry.action === "retry" && Date.parse(secondRetry.retryAt), 30 * 60_000);
  assert.equal(
    settleUndeliveredCallback({ attempts: MAX_VOICE_CALLBACK_ATTEMPTS, twilioStatus: "completed" }).action,
    "park",
  );

  assert.equal(isQueueCapableChannel("sms"), true);
  assert.equal(isQueueCapableChannel("jchat"), false);
  assert.equal(isDeferCapableChannel("agui"), false);

  const cancel = await classifyRealtimeGoalMessage("never mind", [goal]);
  assert.equal(cancel.decision, "cancel");
  assert.equal(cancel.goalId, goal.id);

  const status = await classifyRealtimeGoalMessage("how is that going?", [goal]);
  assert.equal(status.decision, "status");

  const syncOnly = await routeRealtimeGoalMessage({
    text: "Book me a flight to Chicago",
    activeGoals: [goal],
    threadTurns: [],
    queueCapable: false,
  });
  assert.equal(syncOnly.decision, "pass");
  assert.equal(syncOnly.reason, "sync_only_channel");

  const threadTurns = await threads.getTurns("sms:+15555550123");
  const ackRoute = await routeRealtimeGoalMessage(
    {
      text: "Nope",
      activeGoals: [goal],
      threadTurns,
      queueCapable: true,
    },
    {
      completionOverride: async () =>
        JSON.stringify({
          decision: "ack",
          confidence: 0.95,
          goal_id: goal.id,
          reply: "Got it — I'll text you when the article research is done.",
          reason: "answering_anything_else",
        }),
    },
  );
  assert.equal(ackRoute.decision, "ack");
  assert.match(ackRoute.reply ?? "", /article research/i);

  const legacyUpdateRoute = await routeRealtimeGoalMessage(
    {
      text: "also include the New York Times",
      activeGoals: [goal],
      threadTurns,
      queueCapable: true,
    },
    {
      completionOverride: async () =>
        JSON.stringify({
          decision: "update",
          confidence: 0.9,
          goal_id: goal.id,
          reason: "scope_addition",
        }),
    },
  );
  assert.equal(legacyUpdateRoute.decision, "pass", "unbound legacy update folds to pass");

  // Canary PSTN flight search (2026-09-24): classifier returned queue @ 0.72 and
  // was downgraded to pass at the old 0.82 threshold — long browser work never
  // reached the realtime-goals Kanban board.
  const voiceFlightText = [
    "Intent: browse",
    "Conversation summary: User wants flights from LAX to Bentonville (XNA) Tue–Fri.",
    "User said: Yeah, I'm wondering if you can research flights on Tuesday from LAX.",
  ].join("\n");
  const voiceFlightRoute = await routeRealtimeGoalMessage(
    {
      text: voiceFlightText,
      activeGoals: [],
      threadTurns: [],
      queueCapable: true,
    },
    {
      completionOverride: async () =>
        JSON.stringify({
          decision: "queue",
          confidence: 0.72,
          title: "LAX to XNA round trip Tue–Fri",
          reason: "flight search needs background browsing",
        }),
    },
  );
  assert.equal(voiceFlightRoute.decision, "queue", "borderline queue confidence must not fail open to pass");

  assert.equal(isExplicitCancelPhrase("cancel that"), true);

  const brokerContext = buildHermesBrokerContextMessage([goal], threadTurns);
  assert.match(brokerContext ?? "", /Active background goals/);
  assert.match(brokerContext ?? "", /Recent owner↔box thread/);

  await store.update(goal.id, (item) => {
    item.status = "queued";
    item.kanbanTaskId = undefined;
    item.delivery.state = "pending";
  });
  const broker = new RealtimeGoalBroker(
    process.cwd(),
    async () => ({ delivered: true }),
    async () => ({
      decision: "ack",
      confidence: 0.95,
      goalId: goal.id,
      reply: "Got it — I'll text you when the article research is done.",
      reason: "answering_anything_else",
    }),
  );
  const ack = await broker.route({
    origin: {
      channel: "sms",
      sessionKey: goal.origin.sessionKey,
      messageId: "SM-nope-ack",
      replyAddress: goal.origin.replyAddress,
    },
    text: "Nope",
  });
  assert.equal(ack.action, "reply");
  assert.match(ack.text, /article research/i);
  const stillQueued = await store.get(goal.id);
  assert.equal(stillQueued?.status, "queued", "ack must not cancel queued goal");

  // Canary replay: active branch binds follow-ups (search → reserve → rate).
  const patrickSession = "sms:+15555550999";
  const hotelSearch = {
    id: "goal-hotel-search",
    version: 1,
    title: "Chicago hotel search Sep 25-27",
    objective: "Search Chicago hotels Sep 25-27 under $250",
    status: "blocked",
    origin: {
      channel: "sms",
      sessionKey: patrickSession,
      messageId: "SM-search",
      replyAddress: "+15555550999",
    },
    sourceMessageId: "SM-search",
    idempotencyKey: "realtime-goal:v1:hotel-search",
    createdAt: now,
    updatedAt: now,
    kanbanTaskId: "t_hotel_search",
    lastKanbanStatus: "blocked",
    lastBlockReason: "The Wade is back ($711 non-ref / $782 ref). Which rate?",
    messages: [{ at: now, role: "owner", text: "Can you do another search for me?" }],
    intakeReply: "Queued.",
    delivery: { state: "delivered", attempts: 1 },
  };
  await store.insert(hotelSearch);
  await threads.setActiveGoal(patrickSession, hotelSearch.id);

  const patrickRouter = async (input) => {
    if (input.activeBranch) {
      return {
        decision: "update",
        confidence: 0.9,
        goalId: input.activeBranch.id,
        reason: "bound_continuation",
      };
    }
    if (/^hey[!,. ]*$/i.test(input.text.trim())) {
      return { decision: "pass", confidence: 1, reason: "greeting" };
    }
    return { decision: "pass", confidence: 0.78, reason: "would_sync_pass" };
  };
  const patrickBroker = new RealtimeGoalBroker(
    process.cwd(),
    async () => ({ delivered: true }),
    patrickRouter,
  );

  const reserve = await patrickBroker.route({
    origin: {
      channel: "sms",
      sessionKey: patrickSession,
      messageId: "SM-reserve",
      replyAddress: "+15555550999",
    },
    text: "Can you reserve for me the wade",
  });
  assert.equal(reserve.action, "reply", "reserve must bind active branch, not pass");
  assert.equal(reserve.outcome, "updated");
  const afterReserve = await store.get(hotelSearch.id);
  assert.match(afterReserve?.objective ?? "", /reserve for me the wade/i);

  const clarifyingGoal = {
    id: "goal-clarifying",
    version: 1,
    title: "Book The Wade",
    objective: "Book The Wade Chicago Sep 25-27",
    status: "clarifying",
    origin: {
      channel: "sms",
      sessionKey: "sms:+15555551000",
      messageId: "SM-clarify",
      replyAddress: "+15555551000",
    },
    sourceMessageId: "SM-clarify",
    idempotencyKey: "realtime-goal:v1:clarifying",
    createdAt: now,
    updatedAt: now,
    clarificationQuestion: "Non-refundable ($711) or refundable ($782)?",
    messages: [{ at: now, role: "owner", text: "Book The Wade" }],
    intakeReply: "Non-refundable ($711) or refundable ($782)?",
    delivery: { state: "pending", attempts: 0 },
  };
  await store.insert(clarifyingGoal);
  await threads.setActiveGoal("sms:+15555551000", clarifyingGoal.id);

  const clarifyingBroker = new RealtimeGoalBroker(
    process.cwd(),
    async () => ({ delivered: true }),
    patrickRouter,
  );
  const rateChoice = await clarifyingBroker.route({
    origin: {
      channel: "sms",
      sessionKey: "sms:+15555551000",
      messageId: "SM-nonref",
      replyAddress: "+15555551000",
    },
    text: "Non refundable",
  });
  assert.equal(rateChoice.action, "reply");
  assert.equal(rateChoice.outcome, "queued");
  const promoted = await store.get(clarifyingGoal.id);
  assert.equal(promoted?.status, "queued", "clarifying answer must promote to queued");
  assert.ok(promoted?.releaseAt, "clarifying answer must set releaseAt");

  await threads.clearActiveGoal(patrickSession);
  const hey = await patrickBroker.route({
    origin: {
      channel: "sms",
      sessionKey: patrickSession,
      messageId: "SM-hey",
      replyAddress: "+15555550999",
    },
    text: "hey",
  });
  assert.equal(hey.action, "pass", "unbound greeting must pass to sync Hermes");

  assert.equal((await threads.getActiveGoal(patrickSession))?.goalId, undefined);
  await threads.setActiveGoal(patrickSession, hotelSearch.id);
  assert.equal((await threads.getActiveGoal(patrickSession))?.goalId, hotelSearch.id);

  const doneHotel = {
    ...hotelSearch,
    id: "goal-hotel-done",
    status: "done",
    kanbanTaskId: "t_hotel_done",
    lastKanbanStatus: "done",
    sourceMessageId: "SM-done",
    idempotencyKey: "realtime-goal:v1:hotel-done",
  };
  await store.insert(doneHotel);
  await threads.setActiveGoal(patrickSession, doneHotel.id);

  const pivotRouter = async (input) => {
    if (input.activeBranch?.id === doneHotel.id) {
      return {
        decision: "queue",
        confidence: 0.92,
        title: "NYC–Chicago flight under $400",
        reason: "bound_pivot_new_work",
      };
    }
    return {
      decision: "queue",
      confidence: 0.9,
      title: "NYC–Chicago flight under $400",
      reason: "new_long_work",
    };
  };
  const pivotBroker = new RealtimeGoalBroker(
    process.cwd(),
    async () => ({ delivered: true }),
    pivotRouter,
  );
  const pivot = await pivotBroker.route({
    origin: {
      channel: "sms",
      sessionKey: patrickSession,
      messageId: "SM-flight-new",
      replyAddress: "+15555550999",
    },
    text: "Sorry, lets do something new: Book me a round-trip flight from New York to Chicago, leaving Friday morning and back Sunday evening, aisle seat, under $400.",
  });
  assert.equal(pivot.action, "reply", "bound pivot must queue new branch, not update hotel");
  assert.equal(pivot.outcome, "queued");
  assert.notEqual(pivot.goalId, doneHotel.id);
  const doneAfterPivot = await store.get(doneHotel.id);
  assert.equal(doneAfterPivot?.status, "done", "done hotel goal must stay untouched");
  assert.doesNotMatch(doneAfterPivot?.objective ?? "", /round-trip flight/i);

  const boundPivotRoute = await routeRealtimeGoalMessage(
    {
      text: "Sorry, lets do something new: Book me a round-trip flight from New York to Chicago.",
      activeGoals: [doneHotel],
      threadTurns: [],
      queueCapable: true,
      activeBranch: doneHotel,
    },
    {
      completionOverride: async () =>
        JSON.stringify({
          decision: "queue",
          confidence: 0.92,
          title: "NYC–Chicago flight",
          reason: "pivot_from_hotel_to_flight",
        }),
    },
  );
  assert.equal(boundPivotRoute.decision, "queue");

  const failOpen = await classifyRealtimeGoalMessage("Please investigate this", []);
  assert.equal(failOpen.decision, "pass");
  assert.equal(failOpen.reason, "router_unconfigured_fail_open");

  assert.ok(EA_KANBAN_BOARDS.includes(REALTIME_GOALS_KANBAN_BOARD));
  assert.equal(
    eaKanbanCreateDefaults(REALTIME_GOALS_KANBAN_BOARD).max_runtime_seconds,
    28_800,
  );

  const token = realtimeGoalVoiceToken(goal.id);
  assert.equal(verifyRealtimeGoalVoiceToken(goal.id, token), true);
  assert.equal(verifyRealtimeGoalVoiceToken("other-goal", token), false);

  assert.equal(
    await verifyArozosDesktopSession({
      headers: { host: "127.0.0.1:8788" },
      socket: { remoteAddress: "127.0.0.1" },
      ip: "127.0.0.1",
    }),
    true,
  );
  process.env.CUSTOMER_DOMAIN = "box.example.test";
  process.env.PUBLIC_AROZ_PORT = "1";
  assert.equal(
    await verifyArozosDesktopSession({
      headers: {
        host: "box.example.test",
        cookie: "forged-cookie",
        "sec-fetch-site": "same-origin",
        "x-forwarded-for": "203.0.113.1",
      },
      socket: { remoteAddress: "127.0.0.1" },
      ip: "127.0.0.1",
    }),
    false,
    "forged cookie/header shape must fail authoritative ArozOS validation",
  );

  const bridge = await readFile(
    path.join(process.cwd(), "scripts", "hermes-kanban-bridge.py"),
    "utf8",
  );
  assert.match(bridge, /if action == "reopen":/);
  assert.match(bridge, /if action == "cancel":/);
  assert.match(bridge, /include_run/);
  assert.match(bridge, /strict_idempotency/);
  assert.match(bridge, /"realtime-goals"/);
  assert.match(bridge, /idx_joshu_realtime_goal_idempotency/);
  assert.match(bridge, /HERMES_KANBAN_TASK=/);
  assert.match(bridge, /os\.killpg/);

  const noDecomposePatch = await readFile(
    path.join(
      process.cwd(),
      "scripts",
      "patch-hermes-ea-kanban-no-autodecompose.py",
    ),
    "utf8",
  );
  assert.match(noDecomposePatch, /"realtime-goals"/);

  const voiceCallback = await readFile(
    path.join(process.cwd(), "src", "realtimeGoals", "voiceCallback.ts"),
    "utf8",
  );
  assert.match(voiceCallback, /purpose: "result" \| "status"/);
  assert.match(voiceCallback, /voiceServiceAuthorized/);
  assert.match(voiceCallback, /x-joshu-voice-call-sid/);

  const phoneSession = await readFile(
    path.join(
      process.cwd(),
      "packages",
      "voice-realtime",
      "src",
      "twilioRealtimeSession.ts",
    ),
    "utf8",
  );
  assert.match(phoneSession, /realtimeGoalAckPending/);
  assert.match(phoneSession, /trailing mark/);

  const routerSource = await readFile(
    path.join(process.cwd(), "src", "realtimeGoals", "router.ts"),
    "utf8",
  );
  assert.match(routerSource, /decision.*ack/);
  assert.doesNotMatch(routerSource, /SHORT_ACK_PATTERN/);

  const raw =
    "Alaska LAX\u2194SFO same-day round trip for Mon 2026-09-28 is staged at checkout and handed to the owner. " +
    "Out AS 1501 LAX 7:16 AM \u2192 SFO 8:40 AM; back AS 520 SFO 3:41 PM \u2192 LAX 5:12 PM; Main cabin, $442.80 all-in. " +
    "Contact fields prefilled (db@project-aeon.com, +1, US); owner enters name and pays at the handoff link. " +
    "An image CAPTCHA on alaskaair.com's cart\u2192checkout step was cleared this run.";
  const link = "https://box.example.com/joshu/handoff/ddc5d6eb-8a75-4d1a-9fee-2670383dec00?exp=1";
  const friendly = formatOwnerCompletion(raw, [link]);
  assert.match(friendly, /LAX-SFO/);
  assert.match(friendly, /7:16 AM to SFO/);
  assert.match(friendly, /^Out /m);
  assert.match(friendly, /ready for you to finish/);
  assert.match(friendly, /Please enter/);
  assert.match(friendly, /Finish and pay here/);
  assert.match(friendly, new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(friendly, /handed to the owner/);
  assert.doesNotMatch(friendly, /CAPTCHA/);
  assert.doesNotMatch(friendly, /cart to checkout/);
  assert.match(friendly, /^Back /m);
  assert.equal(formatOwnerCompletion(`Done.\n\nFinish and pay here:\n${link}`, [link]).split(link).length, 2);

  // ---- PSTN callbacks: per-owner serialization, voicemail park, pickup ----
  const pstnOrigin = { channel: "pstn_voice", sessionKey: "pstn:owner-test" };
  const pstnGoal = (id, extra = {}) => ({
    id,
    version: 1,
    title: id,
    objective: id,
    status: "blocked",
    origin: { ...pstnOrigin, messageId: `src-${id}` },
    sourceMessageId: `src-${id}`,
    idempotencyKey: `realtime-goal:v1:${id}`,
    createdAt: now,
    updatedAt: now,
    lastKanbanStatus: "blocked",
    lastBlockReason: `Question for ${id}?`,
    messages: [{ at: now, role: "owner", text: id }],
    intakeReply: "Queued.",
    delivery: { state: "pending", attempts: 0 },
    ...extra,
  });
  await store.insert(pstnGoal("pstn-a"));
  await store.insert(pstnGoal("pstn-b"));
  const claimA = await store.claimDeliveryAttempt("pstn-a", "blocked", "Question for pstn-a?", 5);
  assert.equal(claimA.claimed, true);
  const claimB = await store.claimDeliveryAttempt("pstn-b", "blocked", "Question for pstn-b?", 5);
  assert.equal(claimB.claimed, false, "second callback to the same owner must wait (no burst)");
  assert.equal((await store.get("pstn-b"))?.delivery.attempts, 0, "deferred claim must not spend an attempt");
  await store.finalizeDeliveryAttempt(
    "pstn-a",
    claimA.contentKey,
    { delivered: false, pending: true, providerId: "CA-a" },
    5,
  );

  const parkedNotices = [];
  const pstnBroker = new RealtimeGoalBroker(
    process.cwd(),
    async () => ({ delivered: false, pending: true, providerId: "CA-x" }),
    undefined,
    { onCallbacksParked: async (goals, reason) => parkedNotices.push({ goals, reason }) },
  );
  // AMD verdict arrives mid-call, then Twilio reports completed.
  await pstnBroker.recordVoiceCallbackStatus("pstn-a", "", "CA-a", "machine_start");
  assert.equal((await store.get("pstn-a"))?.delivery.state, "attempting", "outcome alone waits for call end");
  await pstnBroker.recordVoiceCallbackStatus("pstn-a", "completed", "CA-a");
  assert.equal((await store.get("pstn-a"))?.delivery.state, "parked", "voicemail must park, not redial");
  assert.equal((await store.get("pstn-b"))?.delivery.state, "parked", "park is session-wide");
  assert.equal(parkedNotices.length, 1, "one nudge for the whole session");
  assert.equal(parkedNotices[0].goals.length, 2);
  await pstnBroker.recordVoiceCallbackStatus("pstn-a", "completed", "CA-a");
  assert.equal(parkedNotices.length, 1, "duplicate status webhook must not re-notify");
  const heldState = await store.read();
  assert.ok(
    Date.parse(heldState.callbackCooldowns?.["pstn_voice:pstn:owner-test"] ?? "") > Date.now() + 30 * 60_000,
    "session callbacks hold after a park",
  );

  // Hung up before unlock (no voicemail): retry with backoff, and a late
  // voicemail report upgrades that retry to a park.
  await store.insert(pstnGoal("pstn-c", { origin: { channel: "pstn_voice", sessionKey: "pstn:owner-c", messageId: "src-c" } }));
  const claimC = await store.claimDeliveryAttempt("pstn-c", "blocked", "Question for pstn-c?", 5);
  await store.finalizeDeliveryAttempt("pstn-c", claimC.contentKey, { delivered: false, pending: true, providerId: "CA-c" }, 5);
  await pstnBroker.recordVoiceCallbackStatus("pstn-c", "completed", "CA-c");
  const retried = await store.get("pstn-c");
  assert.equal(retried?.delivery.state, "pending");
  assert.ok(Date.parse(retried?.delivery.nextAttemptAt ?? "") > Date.now() + 10 * 60_000, "backoff, not 15s");
  await pstnBroker.recordVoiceCallbackOutcome("pstn-c", "CA-c", "voicemail");
  assert.equal((await store.get("pstn-c"))?.delivery.state, "parked", "late voicemail outcome parks");

  // Quiet hours: a deferred (not attempted) delivery gives the attempt back.
  await store.insert(pstnGoal("pstn-d", { origin: { channel: "pstn_voice", sessionKey: "pstn:owner-d", messageId: "src-d" } }));
  const claimD = await store.claimDeliveryAttempt("pstn-d", "blocked", "Question for pstn-d?", 5);
  await store.finalizeDeliveryAttempt(
    "pstn-d",
    claimD.contentKey,
    { delivered: false, pending: true, retryAt: new Date(Date.now() + 3_600_000).toISOString() },
    5,
  );
  assert.equal((await store.get("pstn-d"))?.delivery.attempts, 0);
  assert.equal(
    (await store.read()).callbackCooldowns?.["pstn_voice:pstn:owner-d"],
    undefined,
    "no call placed → session hold released",
  );

  // Owner calls in and asks for an update: a parked finished result is picked up.
  await store.insert(
    pstnGoal("pstn-done", {
      status: "done",
      lastKanbanStatus: "done",
      lastBlockReason: undefined,
      resultSummary: "Flights: AA 1234 LAX to XNA Tue 8:05 AM, $412.",
      delivery: { state: "parked", attempts: 3 },
    }),
  );
  const pickupBroker = new RealtimeGoalBroker(
    process.cwd(),
    async () => ({ delivered: true }),
    async (input) => {
      assert.ok(
        input.activeGoals.some((g) => g.id === "pstn-done"),
        "router must see parked results",
      );
      return { decision: "status", confidence: 0.95, goalId: "pstn-done", reason: "asks_for_update" };
    },
  );
  const pickup = await pickupBroker.route({
    origin: { ...pstnOrigin, messageId: "job-pickup" },
    text: "Any updates for me?",
  });
  assert.equal(pickup.action, "reply");
  assert.match(pickup.text, /AA 1234/);
  assert.equal((await store.get("pstn-done"))?.delivery.state, "delivered");

  // ---- Callback replies are routed, not blindly appended ----
  const flightGoal = pstnGoal("flight-blocked", {
    origin: { channel: "pstn_voice", sessionKey: "pstn:owner-flight", messageId: "src-flight" },
    lastBlockReason: "Nonstop at 6 AM for $389, or one stop at 9 AM for $301?",
    delivery: { state: "attempting", attempts: 1, providerId: "CA-f" },
  });
  await store.insert(flightGoal);
  const routedReply = (decision) =>
    new RealtimeGoalBroker(process.cwd(), async () => ({ delivered: true }), async (input) => {
      assert.equal(input.activeBranch?.id, "flight-blocked", "callback reply is bound to its goal");
      return decision;
    });
  const statusAnswer = await routedReply({
    decision: "status",
    confidence: 0.9,
    goalId: "flight-blocked",
    reason: "progress_question",
  }).answerFromCallback("flight-blocked", "Were you able to find those flights?", "CA-f:4");
  assert.equal(statusAnswer.handled, true);
  assert.equal(statusAnswer.awaitingReply, true);
  const afterStatus = await store.get("flight-blocked");
  assert.equal(afterStatus?.status, "blocked", "a status question must not unblock the worker");
  assert.equal(afterStatus?.lastOwnerAnswer, undefined, "a status question is not an answer");

  const unrelated = await routedReply({
    decision: "queue",
    confidence: 0.9,
    reason: "new_unrelated_work",
  }).answerFromCallback("flight-blocked", "Also cancel my RapidAPI subscriptions", "CA-f:5");
  assert.equal(unrelated.handled, false, "unrelated request falls through to a normal voice turn");

  const realAnswer = await routedReply({
    decision: "update",
    confidence: 0.9,
    goalId: "flight-blocked",
    reason: "answers_blocked_question",
  }).answerFromCallback("flight-blocked", "The nonstop", "CA-f:6");
  assert.equal(realAnswer.handled, true);
  const answered = await store.get("flight-blocked");
  assert.equal(answered?.lastOwnerAnswer, "The nonstop");
  assert.equal(answered?.lastBlockedPrompt, flightGoal.lastBlockReason);
  assert.equal(answered?.delivery.state, "delivered", "answering the question counts as delivery (no redial)");
  assert.doesNotMatch(realAnswer.reply ?? "", /booking/i, "reply must not assume a booking");

  // Voice links: a handoff URL is texted, never spoken (canary box 2026-09-24: the
  // RapidAPI link was only ever read into a phone call).
  const handoffUrl = "https://box.example.com/joshu/handoff/2d71?t=abc&exp=1790295605376";
  const handoffResult = `RapidAPI cancellations are staged.\nLink expires 5:20pm PT:\n${handoffUrl}\n\nFinish and pay here:\n${handoffUrl}`;
  assert.deepEqual(extractLinks(handoffResult), [handoffUrl], "duplicate links collapse to one");
  assert.deepEqual(
    extractLinks(`Https://${handoffUrl.slice("https://".length)}\n${handoffUrl}`),
    [handoffUrl],
    "capitalized scheme is the same link",
  );
  const spokenHandoff = speakableWithoutLinks(handoffResult, linkDeliveryNote({ texted: true }, 1));
  assert.doesNotMatch(spokenHandoff, /https?:/);
  assert.doesNotMatch(spokenHandoff, /pay here/i, "label lines for removed links are dropped");
  assert.match(spokenHandoff, /Link expires 5:20pm PT/);
  assert.match(spokenHandoff, /I just texted you the link\./);
  assert.match(linkDeliveryNote({ texted: false }, 2), /couldn't text you the links/);
  assert.equal(speakableWithoutLinks("No links here.", "note"), "No links here.");

  // Hermes voice context carries what goals are asking / found, recent results,
  // and whether a phone-call link ever reached the owner.
  const blockedFlight = {
    ...goal,
    id: "ctx-flight",
    title: "Search round-trip flights (LAX ↔ Bentonville)",
    status: "blocked",
    origin: { ...goal.origin, channel: "pstn_voice", sessionKey: "pstn:owner" },
    lastBlockReason: "Which round trip should I book? United $447 (1 stop); American nonstop $1,000.",
  };
  const doneRapid = {
    ...goal,
    id: "ctx-rapid",
    title: "Cancel RapidAPI paid subscriptions",
    status: "done",
    origin: { ...goal.origin, channel: "pstn_voice", sessionKey: "pstn:owner" },
    resultSummary: `Log in and unsubscribe here:\n${handoffUrl}`,
    delivery: { state: "delivered", attempts: 1 },
  };
  const voiceContext = buildHermesBrokerContextMessage([blockedFlight], [], undefined, [doneRapid]) ?? "";
  assert.match(voiceContext, /Waiting on owner: Which round trip should I book\? United \$447/);
  assert.match(voiceContext, /Recently finished/);
  assert.match(voiceContext, /NOT texted to the owner yet/);
  const textedContext =
    buildHermesBrokerContextMessage([], [], undefined, [
      { ...doneRapid, linksTextedAt: "2026-09-24T23:38:00.000Z" },
    ]) ?? "";
  assert.match(textedContext, /Texted to the owner's phone at 2026-09-24T23:38:00.000Z/);
  const smsContext =
    buildHermesBrokerContextMessage([], [], undefined, [{ ...doneRapid, origin: goal.origin }]) ?? "";
  assert.doesNotMatch(smsContext, /NOT texted/, "text channels deliver links in the result itself");
  // Long results put the handoff URL last; the excerpt truncates, the link list must not.
  const longRapid = {
    ...doneRapid,
    resultSummary: `${"Steps to unsubscribe from each paid plan. ".repeat(25)}\n${handoffUrl}`,
  };
  const longContext = buildHermesBrokerContextMessage([], [], undefined, [longRapid]) ?? "";
  assert.ok(longRapid.resultSummary.indexOf(handoffUrl) > 600, "fixture puts the link past the excerpt");
  assert.ok(longContext.includes(`Links: ${handoffUrl}`), "full link survives excerpt truncation");

  // Router sees the blocked question, so a detail follow-up is recognizably
  // about this goal (not a new "Get United takeoff time" goal).
  let routerMessages = [];
  await routeRealtimeGoalMessage(
    {
      text: "When does the United flight take off?",
      activeGoals: [blockedFlight],
      threadTurns: [],
      queueCapable: true,
      activeBranch: blockedFlight,
    },
    {
      completionOverride: async (messages) => {
        routerMessages = messages;
        return JSON.stringify({ decision: "update", confidence: 0.9, reason: "detail_of_branch" });
      },
    },
  );
  assert.match(routerMessages[0]?.content ?? "", /NEVER queue a new goal to look up details/);
  assert.match(routerMessages[1]?.content ?? "", /waiting_on_owner=".*United \$447/);

  console.log("test-realtime-goals: ok");
} finally {
  await rm(temp, { recursive: true, force: true });
}
