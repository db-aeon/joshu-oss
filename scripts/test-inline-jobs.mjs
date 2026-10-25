#!/usr/bin/env npx tsx
/**
 * Inline jobs (voice think with a time budget): answers within the budget are
 * spoken; slower ones report "working" and are claimed when they land; an
 * answer the call cannot take (hang-up, voice service gone, Joshu restart)
 * reaches the owner through the outbox. Links are only called "texted" when a
 * send is recorded. Also: voice queue threshold, explicit commit window, SMS
 * interim timing.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";

const temp = await mkdtemp(path.join(tmpdir(), "joshu-inline-jobs-"));
const stateDir = path.join(temp, "state");
Object.assign(process.env, {
  JOSHU_REALTIME_GOALS_STATE_DIR: stateDir,
  JOSHU_REALTIME_GOALS_CALLBACK_SECRET: "unit-test-secret",
  AROZ_DATA: path.join(temp, "aroz"),
  HERMES_API_KEY: "svc-key",
});
for (const name of ["JOSHU_AROZ_USER", "OPENROUTER_API_KEY", "JOSHU_DAY0_API_KEY", "TWILIO_ACCOUNT_SID"]) {
  delete process.env[name];
}
await mkdir(path.join(temp, "aroz", "files", "users", "owner", "Desktop", "joshu's files"), { recursive: true });

const { InlineJobs, registerInlineJobRoutes } = await import("../src/realtimeGoals/inlineJobs.ts");
const { RealtimeGoalBroker } = await import("../src/realtimeGoals/broker.ts");
const { routeRealtimeGoalMessage, voiceQueueConfidenceThreshold } = await import("../src/realtimeGoals/router.ts");
const { smsInterimAfterMs } = await import("../src/twilioSmsGateway.ts");
const { setSmsTransportForTests } = await import("../src/twilioSmsSend.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hermes stand-in: each turn answers `script.next` after `script.delayMs`. */
const script = { answer: "Your dentist is at 3:15 PM tomorrow.", delayMs: 20, calls: 0 };
const runner = {
  ensureGatewayReady: async () => {},
  streamHermesChat: async (params) => {
    script.calls += 1;
    script.lastMessages = params.messages;
    await sleep(script.delayMs);
    return { finalText: script.answer };
  },
};

const broker = new RealtimeGoalBroker(process.cwd(), undefined, {
  kanbanBridge: async () => ({ success: true, task_id: "t_1", task: { task_id: "t_1", status: "ready" } }),
  outboxSenders: () => ({
    capabilities: () => ({ voice: true, sms: true }),
    callWindow: async () => ({ ok: false, civilHours: false }),
    sendText: async () => ({ ok: false, error: "held for the test" }),
    enqueueSurface: async () => ({ ok: true }),
    placeCallback: async () => ({ ok: false, error: "not in this test" }),
  }),
});
const jobs = new InlineJobs(runner, broker, process.cwd(), stateDir, { unclaimedDeliveryMs: 150 });

const app = express();
const router = express.Router();
registerInlineJobRoutes(router, jobs);
app.use(router);
const server = http.createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}/api/realtime-goals/jobs`;
const auth = { Authorization: "Bearer svc-key", "Content-Type": "application/json" };
const origin = (callSid, messageId) => ({ channel: "pstn_voice", sessionKey: "pstn:owner", sessionId: callSid, messageId });
const post = async (url, body, headers = auth) => {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  return { status: response.status, json: await response.json() };
};
const startBody = (callSid, jobId, budgetMs, quote = "When is my dentist appointment?") => ({
  origin: origin(callSid, jobId),
  text: `Intent: calendar lookup\nConversation summary: dentist\nUser said: ${quote}`,
  systemPrompt: "PHONE THINK PROMPT",
  hermesSessionId: callSid,
  hermesSessionKey: `joshu-hermes-chat:${callSid}`,
  budgetMs,
});
const outboxAnswers = async () => ((await broker.store.read()).outbox ?? []).filter((item) => item.kind === "answer");

try {
  // ---- Auth ----
  assert.equal((await post(base, startBody("CA-1", "j0", 100), { "Content-Type": "application/json" })).status, 403);

  // ---- Within budget: spoken now, nothing else delivers it ----
  script.delayMs = 20;
  let res = await post(base, startBody("CA-1", "j1", 2_000));
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "done");
  assert.equal(res.json.answer, "Your dentist is at 3:15 PM tomorrow.");
  assert.deepEqual(res.json.delivered, []);
  assert.equal(script.lastMessages[0].content, "PHONE THINK PROMPT");
  assert.match(script.lastMessages.at(-1).content, /User said: When is my dentist appointment\?/);
  await sleep(300);
  assert.equal((await outboxAnswers()).length, 0, "a spoken answer is not delivered twice");

  // ---- Past budget: working → wait → claim ----
  script.delayMs = 250;
  res = await post(base, startBody("CA-1", "j2", 30));
  assert.equal(res.json.status, "running");
  const late = res.json.jobId;
  let polled = await (await fetch(`${base}/${late}?waitMs=2000`, { headers: auth })).json();
  assert.equal(polled.status, "done");
  const claimed = await post(`${base}/${late}/claim`);
  assert.equal(claimed.json.claimed, true);
  assert.equal(claimed.json.answer, "Your dentist is at 3:15 PM tomorrow.");
  await sleep(300);
  assert.equal((await outboxAnswers()).length, 0, "claimed late answer is not delivered elsewhere");

  // ---- Caller hangs up while it runs: the outbox texts it ----
  script.delayMs = 150;
  script.answer = "The Delta nonstop is $838, departing 7:40 AM.";
  res = await post(base, startBody("CA-2", "j3", 20, "What's the cheapest Cancun flight?"));
  const hungUp = res.json.jobId;
  await post(`${base}/${hungUp}/detach`);
  await sleep(300);
  let answers = await outboxAnswers();
  assert.equal(answers.length, 1);
  assert.equal(answers[0].jobId, hungUp);
  assert.equal(answers[0].text, "The Delta nonstop is $838, departing 7:40 AM.");
  assert.equal(answers[0].routeOverride?.route, "sms", "the call promised a text");
  assert.equal(answers[0].title, "What's the cheapest Cancun flight?");
  assert.equal((await post(`${base}/${hungUp}/claim`)).json.claimed, false, "no speaking what was texted");

  // ---- Voice service gone (never claims): delivered after the grace period ----
  script.delayMs = 30;
  script.answer = "Your flight lands at 6:05 PM.";
  res = await post(base, startBody("CA-3", "j4", 5));
  await sleep(500);
  answers = await outboxAnswers();
  assert.ok(answers.some((item) => item.jobId === res.json.jobId), "unclaimed answer reaches the outbox");

  // ---- Links: only called "texted" when a send is recorded ----
  script.delayMs = 10;
  script.answer = "Here's the checkout page: https://shop.example.com/cart/123";
  res = await post(base, startBody("CA-4", "j5", 2_000, "Send me the checkout link"));
  assert.equal(res.json.status, "done");
  assert.doesNotMatch(res.json.answer, /https?:\/\//, "URLs are never spoken");
  assert.match(res.json.answer, /couldn't text you the link/, "SMS unavailable → honest note");
  assert.deepEqual(
    res.json.delivered.map(({ what, via, ok, count }) => ({ what, via, ok, count })),
    [{ what: "link", via: "sms", ok: false, count: 1 }],
  );

  // ---- Links: the answer does not wait for the SMS delivery receipt; an undelivered
  // SMS found later turns the "texted" fact to failed (change owner-sms-delivery-receipt) ----
  {
    const twilioEnv = {
      TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
      TWILIO_AUTH_TOKEN: "test",
      TWILIO_PHONE_NUMBER: "+15550009999",
      TWILIO_SMS_WEBHOOK_URL: "https://box.test/sms/inbound",
      TWILIO_OWNER_CALLER: "+15550001111",
    };
    Object.assign(process.env, twilioEnv);
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    let reads = 0;
    setSmsTransportForTests({
      send: async () => ["SM1"],
      status: async (sid) => {
        reads += 1;
        return { sid, status: "undelivered", errorCode: 30007 };
      },
      sleep: () => gate,
    });
    try {
      res = await post(base, startBody("CA-5", "j6", 2_000, "Send me the checkout link"));
      assert.match(res.json.answer, /I just texted you the link/);
      assert.equal(reads, 0, "the spoken answer does not wait for the receipt");
      assert.deepEqual(res.json.delivered.map(({ ok }) => ok), [true]);
      open();
      for (let i = 0; i < 50 && reads === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const job = await (await fetch(`${base}/${res.json.jobId}?waitMs=0`, { headers: auth })).json();
      assert.deepEqual(
        job.delivered.map(({ what, ok, error }) => ({ what, ok, error })),
        [{ what: "link", ok: false, error: "twilio undelivered 30007" }],
      );
    } finally {
      setSmsTransportForTests();
      for (const name of Object.keys(twilioEnv)) delete process.env[name];
    }
  }

  // ---- Joshu restarted mid-job: the owner hears so ----
  const running = {
    id: "lost-1",
    origin: origin("CA-9", "j9"),
    title: "Book the dentist",
    hermesSessionKey: "joshu-hermes-chat:CA-9",
    startedAt: new Date().toISOString(),
    status: "running",
  };
  await writeFile(path.join(stateDir, "inline-jobs.json"), JSON.stringify([running]));
  const restarted = new InlineJobs(runner, broker, process.cwd(), stateDir);
  await restarted.recover();
  answers = await outboxAnswers();
  const lost = answers.find((item) => item.jobId === "lost-1");
  assert.equal(lost?.text, "I restarted before I could finish “Book the dentist.” Ask me again when you're ready.");
  assert.equal(restarted.get("lost-1").status, "lost");

  // ---- Router: phone think queues only when clearly long work ----
  const classify = (confidence, queueThreshold) =>
    routeRealtimeGoalMessage(
      { text: "email me the link", activeGoals: [], threadTurns: [], queueCapable: true, ...(queueThreshold ? { queueThreshold } : {}) },
      { completionOverride: async () => JSON.stringify({ decision: "queue", confidence, reason: "t" }) },
    );
  assert.equal(voiceQueueConfidenceThreshold(), 0.85);
  assert.equal((await classify(0.8)).decision, "queue", "SMS/Slack keep 0.7");
  assert.equal((await classify(0.8, voiceQueueConfidenceThreshold())).decision, "pass", "voice needs 0.85");
  assert.equal((await classify(0.9, voiceQueueConfidenceThreshold())).decision, "queue");

  // ---- Explicit start_task commits in 10 s, not 60 ----
  const goal = await broker.defer(
    { origin: origin("CA-5", "task-1"), text: "Intent: research\nUser said: find flights to Austin" },
    "Austin flights",
  );
  const window = Date.parse(goal.releaseAt) - Date.parse(goal.createdAt);
  assert.ok(window <= 10_100 && window >= 9_900, `commit window ${window}ms`);

  // ---- SMS interim text timing ----
  assert.equal(smsInterimAfterMs(), 25_000);
  process.env.JOSHU_SMS_INTERIM_SECONDS = "0";
  assert.ok(smsInterimAfterMs() > 10 * 24 * 3600_000, "0 turns it off");
  delete process.env.JOSHU_SMS_INTERIM_SECONDS;

  console.log("test-inline-jobs: ok");
} finally {
  server.close();
  // A background state write can land while rm runs (ENOTEMPTY in CI), so retry.
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
