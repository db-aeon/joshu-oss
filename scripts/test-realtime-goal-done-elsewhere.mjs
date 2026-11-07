#!/usr/bin/env npx tsx
/**
 * Realtime goals that another channel made unnecessary (issue #172).
 *
 * Replays box clara, 2026-10-22: a Slack realtime goal blocked with "which
 * meeting?", then the owner emailed the same request and mail ingress booked it.
 * Checks the open realtime goals on the mail ingress card of the owner, closing
 * a realtime goal from mail ingress, and the expiry of a blocked realtime goal
 * without an owner answer.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(tmpdir(), "joshu-goal-done-elsewhere-"));
process.env.JOSHU_REALTIME_GOALS_STATE_DIR = temp;
process.env.JOSHU_OWNER_EMAIL = "maya@work.example";
delete process.env.JOSHU_REALTIME_GOALS_BLOCKED_EXPIRY_HOURS;

const { RealtimeGoalBroker } = await import("../src/realtimeGoals/broker.ts");
const { RealtimeGoalStore } = await import("../src/realtimeGoals/store.ts");
const { blockedGoalExpired, mailIngressOpenGoalLines } = await import("../src/realtimeGoals/doneElsewhere.ts");
const { buildMailIngressTaskBody } = await import("../src/ea/mailCron.ts");

const HOUR = 3_600_000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
const slackOrigin = {
  channel: "slack",
  sessionKey: "agent:main:slack:group:C0GROUP",
  replyAddress: "C0GROUP",
  messageId: "1761102300.000100",
};

function blockedGoal(id, overrides = {}) {
  return {
    id,
    version: 1,
    title: "Book the meeting",
    objective: "please book this meeting",
    status: "blocked",
    origin: { ...slackOrigin, messageId: `msg-${id}` },
    sourceMessageId: `msg-${id}`,
    idempotencyKey: `realtime-goal:v1:${id}`,
    createdAt: ago(3),
    updatedAt: ago(2),
    ownerInteractedAt: ago(3),
    kanbanTaskId: `t_${id}`,
    lastKanbanStatus: "blocked",
    lastBlockReason: "Which meeting do you mean?",
    blockedAskedAt: ago(2),
    messages: [{ at: ago(3), role: "owner", text: "please book this meeting" }],
    intakeReply: "Queued.",
    delivery: { state: "outbox", attempts: 0 },
    ...overrides,
  };
}

try {
  const store = new RealtimeGoalStore(process.cwd());
  const kanbanCalls = [];
  let cancelResult = { success: true };
  const kanbanBridge = async (payload) => {
    kanbanCalls.push(payload);
    if (payload.action === "cancel") return cancelResult;
    if (payload.action === "show") {
      // The closed goal's task is archived; other workers are still running.
      const status = payload.task_id === "t_goal-meeting" ? "archived" : "running";
      return { success: true, task: { task_id: payload.task_id, status } };
    }
    return { success: true };
  };
  const broker = new RealtimeGoalBroker(process.cwd(), undefined, { kanbanBridge });

  const meeting = await store.insert(blockedGoal("goal-meeting"));
  const { item: question } = await broker.ownerOutbox.upsertForGoal(meeting.id, "blocked", meeting.lastBlockReason);

  // 1. The mail ingress card of an owner email lists the open realtime goals.
  const ingressInput = (from) => ({
    filesRoot: temp,
    provider: "nylas",
    threadId: "thread-same-meeting",
    sourcePath: "connectors/mail/nylas/threads/thread-same-meeting.md",
    subject: "Zoom with Sam",
    from,
    to: ["companion@agent.example"],
    messageId: "msg-email",
    classification: {
      category: "scheduling",
      project_slug: "other",
      is_new_track: true,
      reason: "test",
      scheduling_hint: true,
      authorization: { agent_authorized: true, scheduling_eligible: true, reason: "agent_on_recipients" },
    },
  });
  const ownerCard = await buildMailIngressTaskBody(ingressInput("Maya <maya@work.example>"), null, "companion@agent.example");
  assert.match(ownerCard, /open_realtime_goal: id=goal-meeting channel=slack status=blocked /);
  assert.match(ownerCard, /waiting_on_owner="Which meeting do you mean\?"/);
  assert.match(ownerCard, /realtime_goal_close_done_elsewhere\(goalId, taskId=/);
  const otherCard = await buildMailIngressTaskBody(ingressInput("Sam <sam@client.example>"), null, "companion@agent.example");
  assert.doesNotMatch(otherCard, /open_realtime_goal/, "only an email of the owner sees the realtime goals");
  assert.deepEqual(mailIngressOpenGoalLines([]), []);
  assert.equal(
    mailIngressOpenGoalLines(Array.from({ length: 8 }, (_, i) => blockedGoal(`g${i}`))).filter((line) =>
      line.startsWith("open_realtime_goal:"),
    ).length,
    5,
  );

  // 2. Mail ingress closes the Slack realtime goal; the owner gets one line on Slack.
  const note = "Booked from your email: Zoom with Sam, Tuesday 3 PM PT.";
  const closed = await broker.closeDoneElsewhere(meeting.id, { taskId: "t_b1a8ffde", note });
  assert.equal(closed.ok, true);
  const after = await store.get(meeting.id);
  assert.equal(after.status, "done");
  assert.equal(after.resultSummary, note);
  assert.equal(after.doneElsewhere.taskId, "t_b1a8ffde");
  const cancel = kanbanCalls.find((call) => call.action === "cancel");
  assert.equal(cancel.task_id, "t_goal-meeting");
  assert.equal(cancel.board, "realtime-goals");
  const outbox = await broker.ownerOutbox.list();
  assert.equal(outbox.find((item) => item.id === question.id).state, "cancelled", "the old question is dropped");
  const result = outbox.find((item) => item.goalId === meeting.id && item.kind === "completed");
  assert.equal(result.text, note);
  assert.equal(result.state, "ready");
  assert.equal(result.origin.channel, "slack");
  assert.equal(result.origin.replyAddress, "C0GROUP");
  const again = await broker.closeDoneElsewhere(meeting.id, { taskId: "t_b1a8ffde", note });
  assert.deepEqual(again, { ok: false, error: "goal is done; nothing to close" });
  assert.equal((await broker.closeDoneElsewhere("nope", { taskId: "t1", note })).error, "goal not found");
  assert.equal((await broker.closeDoneElsewhere(meeting.id, { taskId: " ", note })).ok, false);

  // The lifecycle tick sees the archived task and keeps the realtime goal done (no failure text).
  await store.update(meeting.id, (item) => {
    item.delivery.state = "pending";
  });
  await broker.tick();
  assert.equal((await store.get(meeting.id)).status, "done");
  assert.equal(
    (await broker.ownerOutbox.list()).filter((item) => item.goalId === meeting.id && item.kind === "failed").length,
    0,
  );

  // A Kanban task that cannot be stopped leaves the realtime goal as it was.
  const busy = await store.insert(blockedGoal("goal-busy"));
  cancelResult = { success: false, error: "worker pid 42 does not belong to task" };
  const refused = await broker.closeDoneElsewhere(busy.id, { taskId: "t_x", note });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /could not stop task t_goal-busy/);
  const busyAfter = await store.get(busy.id);
  assert.equal(busyAfter.status, "blocked");
  assert.equal(busyAfter.doneElsewhere, undefined);
  cancelResult = { success: true };
  await store.update(busy.id, (item) => {
    item.status = "cancelled";
  });

  // 3. A blocked question without an owner answer for 48 hours expires quietly.
  assert.equal(blockedGoalExpired(blockedGoal("a", { blockedAskedAt: ago(49), ownerInteractedAt: ago(50) }), []), true);
  assert.equal(blockedGoalExpired(blockedGoal("b", { blockedAskedAt: ago(47), ownerInteractedAt: ago(50) }), []), false);
  assert.equal(
    blockedGoalExpired(blockedGoal("c", { blockedAskedAt: ago(60), blockedAnsweredAt: ago(1), ownerInteractedAt: ago(60) }), []),
    false,
    "an owner answer restarts the wait",
  );
  assert.equal(blockedGoalExpired(blockedGoal("d", { status: "running", blockedAskedAt: ago(60), ownerInteractedAt: ago(60) }), []), false);
  // A realtime goal blocked before blockedAskedAt existed uses its blocked outbox item.
  const legacy = blockedGoal("e", { blockedAskedAt: undefined, ownerInteractedAt: ago(80), updatedAt: ago(1) });
  assert.equal(blockedGoalExpired(legacy, [{ goalId: "e", kind: "blocked", createdAt: ago(72) }]), true);
  assert.equal(blockedGoalExpired(legacy, []), false, "without an outbox item, the last update counts");
  process.env.JOSHU_REALTIME_GOALS_BLOCKED_EXPIRY_HOURS = "100";
  assert.equal(blockedGoalExpired(blockedGoal("f", { blockedAskedAt: ago(72), ownerInteractedAt: ago(80) }), []), false);
  delete process.env.JOSHU_REALTIME_GOALS_BLOCKED_EXPIRY_HOURS;

  const stale = await store.insert(blockedGoal("goal-stale", { blockedAskedAt: ago(49), ownerInteractedAt: ago(50), createdAt: ago(50) }));
  const { item: staleQuestion } = await broker.ownerOutbox.upsertForGoal(stale.id, "blocked", stale.lastBlockReason);
  const fresh = await store.insert(blockedGoal("goal-fresh"));
  kanbanCalls.length = 0;
  const outboxBefore = (await broker.ownerOutbox.list()).length;
  await broker.tick();
  const staleAfter = await store.get(stale.id);
  assert.equal(staleAfter.status, "cancelled");
  assert.ok(staleAfter.expiredAt);
  assert.match(staleAfter.cancelReason, /Expired: no owner answer to the blocked question in 48 hours/);
  assert.equal(staleAfter.delivery.state, "suppressed");
  assert.ok(kanbanCalls.some((call) => call.action === "cancel" && call.task_id === "t_goal-stale"));
  const outboxAfter = await broker.ownerOutbox.list();
  assert.equal(outboxAfter.find((item) => item.id === staleQuestion.id).state, "cancelled");
  assert.equal(outboxAfter.length, outboxBefore, "no message to the owner");
  assert.notEqual((await store.get(fresh.id)).status, "cancelled", "a recent question stays open");

  console.log("test-realtime-goal-done-elsewhere: ok");
} finally {
  await rm(temp, { recursive: true, force: true });
}
