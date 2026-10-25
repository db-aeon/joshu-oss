#!/usr/bin/env npx tsx
/**
 * Unit tests: owner reminders (openspec change owner-reminder-delivery, spec owner-reminders).
 * Fake cron bridge, Kanban bridge, and owner text channel; real store, routes, and script.
 *
 * Usage: npm run test:owner-reminders
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";

import { registerOwnerReminderRoutes } from "../src/ownerReminders/routes.js";
import { checkReminderSchedule, resolveEndsAt } from "../src/ownerReminders/schedule.js";
import {
  OwnerReminderService,
  ownerReminderSms,
  pickReminderForOwnerDone,
} from "../src/ownerReminders/service.js";
import { sendOwnerText } from "../src/ownerTextChannel.js";
import { textOwner } from "../src/realtimeGoals/voiceLinks.js";
import { notifyOwnerForApproval } from "../src/ownerChannel/notify.js";
import { notifyOwnerAppEvent } from "../src/appOwnerDelivery.js";
import { sendSmsWithReceipt, setSmsTransportForTests } from "../src/twilioSmsSend.js";
import { OwnerReminderStore } from "../src/ownerReminders/store.js";

const root = await mkdtemp(path.join(tmpdir(), "joshu-owner-reminders-"));
const scriptsDir = path.join(root, "scripts");
let clock = new Date("2026-10-06T16:00:00.000Z");

function harness(overrides = {}) {
  const cronCalls = [];
  const sent = [];
  let nextJob = 1;
  const state = {
    taskStatus: undefined,
    taskError: undefined,
    sendResult: { delivered: true, channel: "sms" },
    cronCreateResult: undefined,
  };
  const service = new OwnerReminderService({
    projectRoot: root,
    store: new OwnerReminderStore(path.join(root, `state-${Math.random().toString(16).slice(2)}`)),
    scriptsDir,
    cron: async (payload) => {
      cronCalls.push(payload);
      if (payload.action === "create") return state.cronCreateResult ?? { success: true, job_id: `job${nextJob++}` };
      return { success: true };
    },
    taskStatus: async () => {
      if (state.taskError) throw new Error(state.taskError);
      return state.taskStatus;
    },
    sendText: async (input) => {
      sent.push(input);
      return state.sendResult;
    },
    now: () => clock,
    ...overrides,
  });
  return { service, cronCalls, sent, state };
}

/** Run a script without blocking the event loop (the test server answers in this process). */
function runScript(scriptPath, env) {
  return new Promise((resolve) => {
    execFile("bash", [scriptPath], { env, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

const base = {
  title: "Joseph at Wescom",
  text: "Write Joseph at Wescom today.",
  schedule: "0 9 * * *",
};

try {
  // --- Schedule rules ---
  assert.deepEqual(checkReminderSchedule("0 9 * * *"), { ok: true, kind: "recurring", schedule: "0 9 * * *" });
  assert.equal(checkReminderSchedule("every 1d").ok && checkReminderSchedule("every 1d").kind, "recurring");
  assert.equal(checkReminderSchedule("2026-10-08T09:00").ok && checkReminderSchedule("2026-10-08T09:00").kind, "one_time");
  assert.equal(checkReminderSchedule("2h").ok && checkReminderSchedule("2h").kind, "one_time");
  assert.equal(checkReminderSchedule("every 30m").ok, false);
  assert.equal(checkReminderSchedule("*/15 9 * * *").ok, false);
  assert.equal(checkReminderSchedule("tomorrow").ok, false);
  {
    const ends = resolveEndsAt(undefined, "recurring", clock);
    assert.equal(ends.ok && ends.endsAt, "2026-11-05T16:00:00.000Z");
    assert.equal(resolveEndsAt("2027-06-01T00:00:00Z", "recurring", clock).ok, false);
    const oneTime = resolveEndsAt(undefined, "one_time", clock);
    assert.equal(oneTime.ok && oneTime.endsAt, undefined);
  }

  // --- Create: one no_agent Hermes cron job with deliver local and a script ---
  {
    const { service, cronCalls } = harness();
    const out = await service.create({ ...base, linkedTaskId: "t_a3abceed", linkedBoard: "ea-owner-reply" });
    assert.equal(out.status, 201);
    const reminder = out.body.reminder;
    assert.match(reminder.id, /^r_[0-9a-f]{8}$/);
    assert.equal(reminder.cronJobId, "job1");
    assert.equal(reminder.kind, "recurring");
    assert.equal(reminder.endsAt, "2026-11-05T16:00:00.000Z");
    assert.deepEqual(reminder.linkedTask, { board: "ea-owner-reply", taskId: "t_a3abceed" });
    const create = cronCalls[0];
    assert.equal(create.action, "create");
    assert.equal(create.name, "Owner reminder: Joseph at Wescom");
    assert.equal(create.no_agent, true);
    assert.equal(create.deliver, "local");
    assert.equal(create.script, `owner-reminder-${reminder.id}.sh`);
    const script = await readFile(path.join(scriptsDir, create.script), "utf8");
    assert.match(script, new RegExp(`/api/owner-reminders/${reminder.id}/fire`));
  }

  // --- Create errors: schedule, text length, limit, cron failure ---
  {
    const { service, cronCalls, state } = harness();
    assert.equal((await service.create({ ...base, schedule: "every 30m" })).status, 400);
    assert.equal((await service.create({ ...base, text: "x".repeat(321) })).status, 400);
    assert.equal((await service.create({ ...base, linkedTaskId: "t_1" })).status, 400);
    assert.equal(cronCalls.length, 0);
    state.cronCreateResult = { success: false, error: "croniter missing" };
    const failed = await service.create(base);
    assert.equal(failed.status, 502);
    assert.equal((await service.list()).length, 0, "record removed when the Hermes cron job is not created");
    state.cronCreateResult = undefined;
    for (let i = 0; i < 20; i++) assert.equal((await service.create(base)).status, 201);
    assert.equal((await service.create(base)).status, 409, "at most 20 active owner reminders");
  }

  // --- Fire: delivered by SMS, then failed → 502 with no_delivery_channel ---
  {
    const { service, sent, state } = harness();
    const { body } = await service.create(base);
    const id = body.reminder.id;
    const ok = await service.fire(id);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.channel, "sms");
    assert.equal(sent[0].sms, "Reminder: Write Joseph at Wescom today. Reply DONE when it is done.");
    assert.equal(sent[0].emailSubject, "Reminder: Joseph at Wescom");
    assert.match(sent[0].emailBody, new RegExp(`Reminder id: ${id}`));

    state.sendResult = { delivered: false, error: "no_delivery_channel" };
    const bad = await service.fire(id);
    assert.equal(bad.status, 502);
    assert.equal(bad.body.error, "no_delivery_channel");
    const [stored] = await service.list();
    assert.equal(stored.status, "active");
    assert.deepEqual(
      stored.runs.map((r) => [r.result, r.channel ?? r.error]),
      [
        ["delivered", "sms"],
        ["failed", "no_delivery_channel"],
      ],
    );
    assert.equal((await service.fire("r_unknown")).status, 404);
  }

  // --- Retire: linked task closed, end time, one-time, stop ---
  {
    const { service, sent, cronCalls, state } = harness();
    const linked = (await service.create({ ...base, linkedTaskId: "t_a3abceed", linkedBoard: "b" })).body.reminder;
    state.taskError = "kanban bridge down";
    assert.equal((await service.fire(linked.id)).body.delivered, true, "bridge failure still sends");
    state.taskError = undefined;
    state.taskStatus = "done";
    const closed = await service.fire(linked.id);
    assert.equal(closed.body.skipped, "task_closed");
    assert.equal(sent.length, 1, "a run after the task closed sends nothing");
    const after = (await service.list()).find((r) => r.id === linked.id);
    assert.equal(after.status, "retired");
    assert.equal(after.retiredReason, "task_closed");
    assert.ok(cronCalls.some((c) => c.action === "remove" && c.job_id === linked.cronJobId));
    assert.equal(existsSync(path.join(scriptsDir, linked.scriptName)), false, "script deleted");
    const again = await service.fire(linked.id);
    assert.equal(again.body.skipped, "retired");

    state.taskStatus = undefined;
    const ending = (await service.create({ ...base, endsAt: "2026-10-07T00:00:00Z" })).body.reminder;
    clock = new Date("2026-10-08T16:00:00.000Z");
    assert.equal((await service.fire(ending.id)).body.skipped, "ended");
    assert.equal((await service.list()).find((r) => r.id === ending.id).retiredReason, "ended");

    const once = (await service.create({ ...base, schedule: "2026-10-09T09:00" })).body.reminder;
    assert.equal(once.kind, "one_time");
    await service.fire(once.id);
    assert.equal((await service.list()).find((r) => r.id === once.id).retiredReason, "one_time");

    const onceFail = (await service.create({ ...base, schedule: "2h" })).body.reminder;
    state.sendResult = { delivered: false, error: "no_delivery_channel" };
    const removesBefore = cronCalls.filter((c) => c.action === "remove").length;
    assert.equal((await service.fire(onceFail.id)).status, 502);
    assert.equal((await service.list()).find((r) => r.id === onceFail.id).retiredReason, "one_time_failed");
    assert.equal(
      cronCalls.filter((c) => c.action === "remove").length,
      removesBefore,
      "failed one-time run keeps its Hermes cron job for the failure report",
    );
    state.sendResult = { delivered: true, channel: "sms" };

    const stopped = (await service.create(base)).body.reminder;
    assert.equal((await service.stop(stopped.id)).body.reminder.retiredReason, "stopped");
    assert.equal((await service.stop("r_nope")).status, 404);
    clock = new Date("2026-10-06T16:00:00.000Z");
  }

  // --- DONE by SMS: newest SMS run, after the last nudge, inside the window ---
  {
    const run = (at) => ({ at, result: "delivered", channel: "sms" });
    const r1 = { id: "r_1", status: "active", runs: [run("2026-10-06T15:00:00.000Z")] };
    const r2 = { id: "r_2", status: "active", runs: [run("2026-10-06T15:30:00.000Z")] };
    const emailOnly = { id: "r_3", status: "active", runs: [{ at: "2026-10-06T15:50:00.000Z", result: "delivered", channel: "email" }] };
    const opts = { windowMs: 2 * 3600_000, nowMs: clock.getTime() };
    assert.equal(pickReminderForOwnerDone([r1, r2, emailOnly], opts)?.id, "r_2");
    assert.equal(
      pickReminderForOwnerDone([r1, r2], { ...opts, lastNudgeSentAt: "2026-10-06T15:45:00.000Z" }),
      undefined,
      "DONE after a nudge goes to the nudge",
    );
    assert.equal(pickReminderForOwnerDone([r1], { ...opts, windowMs: 30 * 60_000 }), undefined, "outside the window");
    assert.equal(pickReminderForOwnerDone([{ ...r2, status: "retired" }], opts), undefined);

    const { service } = harness();
    const made = (await service.create(base)).body.reminder;
    await service.fire(made.id);
    const done = await service.retireForOwnerDone({ lastNudgeSentAt: null, windowMs: 2 * 3600_000 });
    assert.equal(done?.id, made.id);
    assert.equal(done?.retiredReason, "owner_done");
  }

  // --- Routes: localhost only; the generated script exits 1 on a failed delivery ---
  {
    const { service, state } = harness();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerOwnerReminderRoutes(router, () => service);
    app.use("/joshu", router);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = server.address().port;
    const api = `http://127.0.0.1:${port}/joshu`;
    try {
      const created = await fetch(`${api}/api/owner-reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(base),
      });
      assert.equal(created.status, 201);
      const { reminder } = await created.json();
      const proxied = await fetch(`${api}/api/owner-reminders`, { headers: { "X-Forwarded-For": "1.2.3.4" } });
      assert.equal(proxied.status, 403);
      const listed = await (await fetch(`${api}/api/owner-reminders`)).json();
      assert.equal(listed.reminders.length, 1);

      const env = { ...process.env, JOSHU_API_BASE: api };
      const scriptPath = path.join(scriptsDir, reminder.scriptName);
      const good = await runScript(scriptPath, env);
      assert.equal(good.status, 0, good.stderr);
      assert.match(good.stdout, /"delivered":true/);
      state.sendResult = { delivered: false, error: "no_delivery_channel" };
      const bad = await runScript(scriptPath, env);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /HTTP 502 .*no_delivery_channel/);

      const stop = await fetch(`${api}/api/owner-reminders/${reminder.id}/stop`, { method: "POST" });
      assert.equal((await stop.json()).reminder.retiredReason, "stopped");
      const active = await (await fetch(`${api}/api/owner-reminders`)).json();
      assert.equal(active.reminders.length, 0);
      const all = await (await fetch(`${api}/api/owner-reminders?includeRetired=1`)).json();
      assert.equal(all.reminders.length, 1);
    } finally {
      server.close();
    }
  }

  // --- Owner text channel: no owner mobile and no companion mailbox ---
  {
    for (const key of Object.keys(process.env)) if (key.startsWith("TWILIO_")) delete process.env[key];
    const out = await sendOwnerText(path.join(root, "empty-project"), {
      sms: "x",
      emailSubject: "Reminder: x",
      emailBody: "x",
    });
    assert.deepEqual(out, { delivered: false, error: "no_delivery_channel" });
  }

  // --- SMS delivery receipt (openspec change owner-sms-delivery-receipt) ---
  {
    // Fake Twilio and fake clock: each SMS part reads the statuses in `script`, one per
    // status read. A sleep moves the clock; `readMs` is the time that each status read takes;
    // `gate` holds each sleep until the test opens it; status "hang" never answers.
    const sms = { sent: [], reads: 0, slept: 0, now: 0, script: [] };
    const fakeTwilio = (script, opts = {}) => {
      Object.assign(sms, { sent: [], reads: 0, slept: 0, now: 0, script });
      setSmsTransportForTests({
        send: async (to, body) => {
          if (opts.sendError) throw new Error(opts.sendError);
          sms.sent.push({ to, body });
          return ["SM1", "SM2"].slice(0, opts.parts ?? 1);
        },
        status: async (sid) => {
          const entry = sms.script[Math.min(sms.reads++, sms.script.length - 1)];
          if (entry === "error") throw new Error("twilio 503");
          if (entry === "hang") return new Promise(() => {});
          sms.now += opts.readMs ?? 0;
          return { sid, ...entry };
        },
        sleep: async (ms) => {
          if (opts.gate) await opts.gate;
          sms.slept += ms;
          sms.now += ms;
        },
        now: () => sms.now,
      });
    };
    const UNDELIVERED = { status: "undelivered", errorCode: 30034 };

    // The receipt helper: a receipt ends the wait; without a final status the wait ends at waitMs.
    fakeTwilio([{ status: "sent" }, { status: "delivered" }]);
    assert.deepEqual(await sendSmsWithReceipt("+15550001111", "hi", 45_000), { outcome: "delivered", sids: ["SM1"] });
    assert.equal(sms.slept, 4_000, "stops at the first delivery receipt");
    fakeTwilio([{ status: "queued" }, "error", UNDELIVERED]);
    assert.deepEqual(await sendSmsWithReceipt("+15550001111", "hi", 45_000), {
      outcome: "undelivered",
      sids: ["SM1"],
      detail: "twilio undelivered 30034",
    });
    fakeTwilio([{ status: "sent" }]);
    assert.deepEqual(await sendSmsWithReceipt("+15550001111", "hi", 45_000), { outcome: "no_receipt", sids: ["SM1"] });
    assert.equal(sms.slept, 45_000, "waits at most waitMs");
    fakeTwilio([{ status: "delivered" }, UNDELIVERED], { parts: 2 });
    assert.equal((await sendSmsWithReceipt("+15550001111", "hi", 45_000)).outcome, "undelivered", "one rejected part");
    // The wait counts real elapsed time: slow status reads do not stretch it.
    fakeTwilio([{ status: "sent" }], { readMs: 20_000 });
    assert.equal((await sendSmsWithReceipt("+15550001111", "hi", 45_000)).outcome, "no_receipt");
    assert.ok(sms.now <= 45_000, `elapsed ${sms.now} ms`);
    assert.equal(sms.reads, 2, "2 s sleep + 20 s read, twice, then the wait ends");
    // A status read that never answers ends at the deadline (real timer, short wait here).
    fakeTwilio(["hang"]);
    const hungStart = Date.now();
    assert.equal((await sendSmsWithReceipt("+15550001111", "hi", 2_300)).outcome, "no_receipt");
    assert.ok(Date.now() - hungStart < 2_000, "a hung read ends after the time that is left (300 ms)");

    // A box with the Twilio SMS gateway and an owner mobile, but no companion mailbox.
    Object.assign(process.env, {
      TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
      TWILIO_AUTH_TOKEN: "test",
      TWILIO_PHONE_NUMBER: "+15550009999",
      TWILIO_SMS_WEBHOOK_URL: "https://box.test/sms/inbound",
      TWILIO_OWNER_CALLER: "+15550001111",
    });
    const smsProject = path.join(root, "sms-project");
    const reminderText = { sms: "Reminder: x", emailSubject: "Reminder: x", emailBody: "x" };

    // Owner text channel: SMS with a receipt, or without a final status, is delivered by SMS.
    fakeTwilio([{ status: "delivered" }]);
    assert.deepEqual(await sendOwnerText(smsProject, reminderText), { delivered: true, channel: "sms" });
    fakeTwilio([{ status: "sent" }]);
    assert.deepEqual(await sendOwnerText(smsProject, reminderText), { delivered: true, channel: "sms" });

    // Owner text channel: an undelivered SMS goes to the email fallback (here: no companion mailbox).
    fakeTwilio([UNDELIVERED]);
    assert.deepEqual(await sendOwnerText(smsProject, reminderText), {
      delivered: false,
      error: "sms_failed:twilio undelivered 30034",
      smsError: "twilio undelivered 30034",
    });
    fakeTwilio([], { sendError: "Twilio 21610" });
    assert.equal((await sendOwnerText(smsProject, reminderText)).error, "sms_failed:Twilio 21610");

    // Owner reminder run: an undelivered SMS without email records "failed", not "delivered".
    {
      const { service } = harness({ sendText: (input) => sendOwnerText(smsProject, input) });
      const { body } = await service.create(base);
      fakeTwilio([UNDELIVERED]);
      const out = await service.fire(body.reminder.id);
      assert.equal(out.status, 502);
      const [stored] = await service.list();
      assert.deepEqual(
        stored.runs.map((r) => [r.result, r.channel ?? r.error]),
        [["failed", "sms_failed:twilio undelivered 30034"]],
      );
    }

    // Owner text channel with a companion mailbox: an undelivered SMS goes by email
    // (Nylas relay faked through fetch).
    {
      const arozData = path.join(root, "aroz");
      const nylasDir = path.join(arozData, "files", "users", "owner@example.com", ".joshu", "nylas");
      await mkdir(nylasDir, { recursive: true });
      await writeFile(path.join(nylasDir, "agent.json"), JSON.stringify({ grantId: "g1", email: "companion@box.test" }));
      await writeFile(path.join(nylasDir, "profile.json"), JSON.stringify({ primaryWorkEmail: "owner@example.com" }));
      const savedEnv = { ...process.env };
      Object.assign(process.env, {
        AROZ_DATA: arozData,
        JOSHU_AROZ_USER: "owner@example.com",
        JOSHU_NYLAS_MODE: "relay",
        CONTROL_PLANE_URL: "https://cp.test",
        JOSHU_INSTANCE_ID: "box",
        INSTANCE_AGENT_TOKEN: "token",
      });
      const realFetch = globalThis.fetch;
      const emails = [];
      globalThis.fetch = async (url, init) => {
        assert.match(String(url), /cp\.test\/api\/instances\/nylas\/proxy$/);
        emails.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ result: "msg1" }), { status: 200 });
      };
      try {
        const mailProject = path.join(root, "mail-project");
        fakeTwilio([{ status: "sent" }, { status: "undelivered", errorCode: 30007 }]);
        assert.deepEqual(await sendOwnerText(mailProject, reminderText), {
          delivered: true,
          channel: "email",
          smsError: "twilio undelivered 30007",
        });
        assert.equal(emails.length, 1);
        assert.equal(emails[0].op, "sendMessage");
        assert.deepEqual(emails[0].args.to.map((r) => r.email), ["owner@example.com"]);

        // Owner reminder run: the email delivered it, and an SMS DONE does not retire it.
        const { service } = harness({ sendText: (input) => sendOwnerText(mailProject, input) });
        const { body } = await service.create(base);
        fakeTwilio([UNDELIVERED]);
        const out = await service.fire(body.reminder.id);
        assert.equal(out.status, 200);
        assert.equal(out.body.channel, "email");
        assert.equal(emails[1].args.subject, "Reminder: Joseph at Wescom");
        const reminders = await service.list();
        assert.deepEqual(reminders[0].runs.map((r) => [r.result, r.channel]), [["delivered", "email"]]);
        assert.equal(
          pickReminderForOwnerDone(reminders, { windowMs: 2 * 3_600_000, nowMs: clock.getTime() + 600_000 }),
          undefined,
        );
      } finally {
        globalThis.fetch = realFetch;
        for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      }
    }

    // Approval request: an undelivered SMS makes the owner channel unavailable.
    fakeTwilio([UNDELIVERED]);
    await assert.rejects(
      notifyOwnerForApproval("p_test", "gmail:send", { to: "ana@example.com" }, smsProject),
      (err) => err.code === "owner_channel_sms_delivery_failed" && /twilio undelivered 30034/.test(err.message),
    );
    fakeTwilio([{ status: "delivered" }]);
    assert.equal(await notifyOwnerForApproval("p_test", "gmail:send", { to: "ana@example.com" }, smsProject), "sms");

    // Links on a live call: textOwner returns when Twilio accepts the SMS (no status read
    // yet), and the background check reports an undelivered SMS to the caller later.
    {
      let open;
      const gate = new Promise((resolve) => (open = resolve));
      fakeTwilio([UNDELIVERED], { gate });
      let reported;
      const undelivered = new Promise((resolve) => (reported = resolve));
      assert.deepEqual(await textOwner(smsProject, "https://example.com/pay", reported), { texted: true });
      assert.equal(sms.reads, 0, "the live call does not wait for the receipt");
      open();
      assert.equal(await undelivered, "twilio undelivered 30034");
      fakeTwilio([], { sendError: "Twilio 21211" });
      assert.deepEqual(await textOwner(smsProject, "https://example.com/pay"), { texted: false, error: "Twilio 21211" });
    }

    // App event SMS.
    fakeTwilio([UNDELIVERED]);
    assert.deepEqual(await notifyOwnerAppEvent({ appId: "a", title: "T", summary: "S" }, smsProject), {
      delivered: false,
      channels: [],
    });

    setSmsTransportForTests();
    for (const key of Object.keys(process.env)) if (key.startsWith("TWILIO_")) delete process.env[key];
  }

  assert.equal(ownerReminderSms({ text: "Call Ana." }), "Reminder: Call Ana. Reply DONE when it is done.");
  console.log("owner reminders: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
