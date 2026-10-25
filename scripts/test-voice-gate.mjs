#!/usr/bin/env npx tsx
/**
 * Call gate, Joshu side: inbound calls and owner
 * callbacks are handed to the voice-realtime gate, caller-ID trust is decided
 * from Twilio's STIR/SHAKEN verdict, the Telephone PIN hash is one the gate can
 * verify, and the opener endpoint gives a gated call its context and unheard
 * results. The gate itself is tested in packages/voice-realtime/test/gate.test.mjs.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";

import express from "express";
import twilio from "twilio";

const temp = await mkdtemp(path.join(tmpdir(), "joshu-voice-gate-"));
Object.assign(process.env, {
  JOSHU_REALTIME_GOALS_STATE_DIR: path.join(temp, "state"),
  JOSHU_REALTIME_GOALS_CALLBACK_SECRET: "unit-test-secret",
  AROZ_DATA: path.join(temp, "aroz"),
  TWILIO_AUTH_TOKEN: "auth-token",
  TWILIO_ACCOUNT_SID: "AC-test",
  TWILIO_MEDIA_STREAM_SECRET: "media-secret",
  TWILIO_VOICE_WEBHOOK_URL: "https://box.example.test/joshu/api/twilio/voice/inbound",
  TWILIO_MEDIA_STREAM_WSS_URL: "wss://box.example.test/voice-rt/media/media-secret",
  TWILIO_THINK_PASSWORD: "harbor lantern",
  TWILIO_OWNER_CALLER: "+13105550100",
  HERMES_API_KEY: "svc-key",
});
delete process.env.JOSHU_AROZ_USER;
delete process.env.JOSHU_VOICE_GATE_URL;
delete process.env.JOSHU_REALTIME_GOALS_CALLBACK_AMD;
await mkdir(path.join(temp, "aroz", "files", "users", "owner", "Desktop", "joshu's files"), { recursive: true });

const { callerTrustedForGate, voiceGateBaseUrl, voiceGateUrl, VERIFIED_CALLER_STATUS } = await import(
  "../src/voiceGate.ts"
);
const { registerTwilioVoiceRoutes } = await import("../src/twilioPhoneGateway.ts");
const { registerTelephoneRoutes } = await import("../src/telephoneSettings/routes.ts");
const { readTelephoneSettingsFile } = await import("../src/telephoneSettings/store.ts");
const { verifyPin } = await import("../packages/voice-realtime/src/gate/pin.ts");
const { gateAmdLeavesNotice, ownerCallbackCallRequest, registerRealtimeGoalVoiceRoutes } = await import(
  "../src/realtimeGoals/voiceCallback.ts"
);
const { RealtimeGoalBroker } = await import("../src/realtimeGoals/broker.ts");

const servers = [];
try {
  // ---- Gate URL + caller trust ----
  assert.equal(voiceGateBaseUrl(), "https://box.example.test/voice-rt/gate");
  assert.equal(
    voiceGateUrl("start", { mode: "inbound", trusted: "0", batch: undefined }),
    "https://box.example.test/voice-rt/gate/start?mode=inbound&trusted=0",
  );
  process.env.TWILIO_MEDIA_STREAM_WSS_URL = "wss://box.example.test/joshu/api/twilio/media-stream/x";
  assert.equal(voiceGateBaseUrl(), "https://box.example.test/voice-rt/gate", "falls back to the webhook host");
  process.env.JOSHU_VOICE_GATE_URL = "https://gate.example.test/voice-rt/gate/";
  assert.equal(voiceGateBaseUrl(), "https://gate.example.test/voice-rt/gate");
  delete process.env.JOSHU_VOICE_GATE_URL;
  process.env.TWILIO_MEDIA_STREAM_WSS_URL = "wss://box.example.test/voice-rt/media/media-secret";

  const trust = (overrides) =>
    callerTrustedForGate({
      from: "+13105550100",
      stirVerstat: VERIFIED_CALLER_STATUS,
      ownerCaller: "+13105550100",
      trustVerifiedCallerId: true,
      ...overrides,
    });
  assert.equal(trust({}), true);
  assert.equal(trust({ from: "3105550100" }), true, "same number without +1");
  assert.equal(trust({ trustVerifiedCallerId: false }), false, "opt-in required");
  assert.equal(trust({ stirVerstat: "TN-Validation-Passed-B" }), false, "partial attestation is not enough");
  assert.equal(trust({ stirVerstat: "" }), false);
  assert.equal(trust({ from: "+13105550199" }), false, "someone else's number");
  assert.equal(trust({ ownerCaller: "" }), false);

  // ---- HTTP: Telephone settings + inbound webhook ----
  const tasks = new Map();
  let seq = 0;
  const broker = new RealtimeGoalBroker(process.cwd(), undefined, {
    kanbanBridge: async (payload) => {
      if (payload.action === "create") {
        const id = `t_${++seq}`;
        tasks.set(id, { status: "running" });
        return { success: true, task_id: id, task: { task_id: id, status: "ready" } };
      }
      if (payload.action === "show") {
        const task = tasks.get(payload.task_id);
        return { success: true, task: { task_id: payload.task_id, ...task } };
      }
      return { success: true };
    },
    outboxSenders: () => ({
      capabilities: () => ({ voice: true, sms: true }),
      callWindow: async () => ({ ok: false, civilHours: false }),
      sendText: async () => ({ ok: true }),
      enqueueSurface: async () => ({ ok: true }),
      placeCallback: async () => ({ ok: false, error: "not in this test" }),
    }),
  });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const reconciles = [];
  registerTelephoneRoutes(router, {
    projectRoot: process.cwd(),
    reconcileOnboarding: (_root, reason) => reconciles.push(reason),
  });
  registerTwilioVoiceRoutes(router, {}, "");
  registerRealtimeGoalVoiceRoutes(router, broker);
  app.use(router);
  const server = http.createServer(app);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  const put = async (body) => {
    const response = await fetch(`${base}/api/telephone`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  assert.equal((await put({ pin: "1234" })).status, 400, "sequential PIN refused");
  assert.equal((await put({ pin: "12a4" })).status, 400);
  const saved = await put({ pin: "482913", trustVerifiedCallerId: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.telephone.pinConfigured, true);
  assert.equal(saved.json.telephone.pinLength, 6);
  assert.equal(JSON.stringify(saved.json).includes("482913"), false, "the PIN never comes back");
  const stored = readTelephoneSettingsFile();
  assert.notEqual(stored.pinHash, undefined);
  assert.equal(JSON.stringify(stored).includes("482913"), false, "only a hash is stored");
  assert.equal(verifyPin("482913", stored.pinHash), true, "voice-realtime verifies Joshu's hash");
  assert.equal(verifyPin("482914", stored.pinHash), false);

  // ---- Owner mobile offer: save the caller ID of an unlocked call ----
  const fromCall = async (body, auth = "Bearer svc-key") => {
    const response = await fetch(`${base}/api/telephone/owner-mobile/from-call`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  assert.equal((await fromCall({ callSid: "CA-m1", caller: "+13105550199" }, "Bearer nope")).status, 403);
  const envOwner = await fromCall({ callSid: "CA-m1", caller: "+13105550199" });
  assert.equal(envOwner.status, 409, "TWILIO_OWNER_CALLER is an owner mobile");
  assert.equal(envOwner.json.status, "already_set");
  assert.equal(readTelephoneSettingsFile().ownerCaller, undefined);
  const savedOwnerEnv = process.env.TWILIO_OWNER_CALLER;
  delete process.env.TWILIO_OWNER_CALLER;
  process.env.TWILIO_PHONE_NUMBER = "+17625839074";
  assert.equal((await fromCall({ callSid: "CA-m1", caller: "+17625839074" })).json.status, "invalid", "the box number");
  assert.equal((await fromCall({ callSid: "CA-m1", caller: "55501" })).status, 400, "not a mobile");
  assert.equal((await fromCall({ callSid: "", caller: "+13105550199" })).status, 400);
  assert.equal(reconciles.length, 0);
  const before = readTelephoneSettingsFile();
  const savedMobile = await fromCall({ callSid: "CA-m1", caller: "3105550199" });
  assert.equal(savedMobile.status, 200);
  assert.equal(savedMobile.json.status, "saved");
  assert.equal(savedMobile.json.ownerCallerDisplay, "+1 (310) 555-0199");
  const after = readTelephoneSettingsFile();
  assert.equal(after.ownerCaller, "+13105550199");
  assert.deepEqual({ ...after, ownerCaller: undefined }, { ...before, ownerCaller: undefined }, "only ownerCaller changes");
  assert.equal(after.trustVerifiedCallerId, true, "trusted caller ID stays as the owner set it");
  assert.deepEqual(reconciles, ["owner mobile saved from call"], "onboarding reconcile runs once");
  const replaced = await fromCall({ callSid: "CA-m2", caller: "+13105550142" });
  assert.equal(replaced.status, 409, "never replaces an owner mobile");
  assert.equal(readTelephoneSettingsFile().ownerCaller, "+13105550199");
  // Restore: the gate cases below expect the owner mobile from the environment.
  await put({ ownerCaller: "" });
  delete process.env.TWILIO_PHONE_NUMBER;
  process.env.TWILIO_OWNER_CALLER = savedOwnerEnv;
  reconciles.length = 0;

  const inbound = async (params) => {
    const body = { AccountSid: "AC-test", CallSid: "CA-in-1", From: "+13105550100", To: "+15550009999", ...params };
    const signature = twilio.getExpectedTwilioSignature("auth-token", process.env.TWILIO_VOICE_WEBHOOK_URL, body);
    const response = await fetch(`${base}/api/twilio/voice/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(body).toString(),
    });
    return { status: response.status, xml: await response.text() };
  };
  let reply = await inbound({ StirVerstat: VERIFIED_CALLER_STATUS });
  assert.equal(reply.status, 200);
  assert.equal(
    reply.xml,
    '<?xml version="1.0" encoding="UTF-8"?><Response><Redirect method="POST">https://box.example.test/voice-rt/gate/start?mode=inbound&amp;trusted=1</Redirect></Response>',
  );
  reply = await inbound({ StirVerstat: "TN-Validation-Passed-C" });
  assert.match(reply.xml, /trusted=0/);
  reply = await inbound({ From: "+14155550123", StirVerstat: VERIFIED_CALLER_STATUS });
  assert.match(reply.xml, /trusted=0/, "a verified stranger is still gated");
  assert.doesNotMatch(reply.xml, /<Stream/, "no media stream URL leaves Joshu in gate mode");
  await put({ trustVerifiedCallerId: false });
  reply = await inbound({ StirVerstat: VERIFIED_CALLER_STATUS });
  assert.match(reply.xml, /trusted=0/, "opt-out wins");

  // ---- Owner callbacks through the gate ----
  const config = { from: "+15550009999", to: "+13105550100", wssUrl: process.env.TWILIO_MEDIA_STREAM_WSS_URL };
  const request = ownerCallbackCallRequest(config, { id: "b-1", items: [], ownerRequested: true }, "https://box.example.test/status");
  assert.equal(request.machineDetection, "DetectMessageEnd");
  assert.equal(request.asyncAmd, "true");
  assert.match(request.twiml, /<Redirect method="POST">https:\/\/box\.example\.test\/voice-rt\/gate\/start\?mode=callback&amp;batch=b-1&amp;bt=b-1\.[0-9a-f]{64}&amp;req=1<\/Redirect>/);
  assert.doesNotMatch(request.twiml, /media-secret/);

  const inFlight = { callSid: "CA-cb", batchId: "b-1", since: "", leaseUntil: "", itemIds: [] };
  assert.equal(gateAmdLeavesNotice(inFlight, "b-1", "CA-cb"), true);
  assert.equal(gateAmdLeavesNotice({ ...inFlight, unlockedAt: "now" }, "b-1", "CA-cb"), false, "owner already in");
  assert.equal(gateAmdLeavesNotice({ ...inFlight, outcome: "voicemail" }, "b-1", "CA-cb"), false, "gate left the notice");
  assert.equal(gateAmdLeavesNotice(inFlight, "b-2", "CA-cb"), false);
  assert.equal(gateAmdLeavesNotice(inFlight, "b-1", "CA-other"), false);
  assert.equal(gateAmdLeavesNotice(undefined, "b-1", "CA-cb"), false);

  // ---- Opener: context + unheard results for a gated inbound call ----
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-27T04:00:00Z") });
  await broker.defer(
    {
      origin: { channel: "pstn_voice", sessionKey: "pstn:owner", sessionId: "CA-old", messageId: "job-1" },
      text: "Intent: Cancun flights\nUser said: find flights to Cancun",
    },
    "Cancun flights",
  );
  mock.timers.setTime(Date.parse("2026-09-27T04:02:00Z"));
  await broker.tick();
  for (const task of tasks.values()) Object.assign(task, { status: "done", latest_run: { summary: "Cancun: Delta nonstop $838, Dec 20." } });
  mock.timers.setTime(Date.parse("2026-09-27T04:05:00Z"));
  await broker.tick();
  let state = await broker.store.read();
  assert.equal(state.outbox?.[0]?.state, "ready", "result waits for the owner (outside call hours)");

  const opener = async (body, headers = {}) => {
    const response = await fetch(`${base}/api/realtime-goals/voice/opener`, {
      method: "POST",
      headers: { Authorization: "Bearer svc-key", "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  assert.equal((await opener({ callSid: "CA-in-2", mode: "inbound" }, { Authorization: "Bearer nope" })).status, 403);
  const opened = await opener({ callSid: "CA-in-2", mode: "inbound" });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.json.items.map((item) => item.title), ["Cancun flights"]);
  assert.match(opened.json.items[0].text, /\$838/);
  assert.match(opened.json.context ?? "", /Cancun flights/);
  state = await broker.store.read();
  assert.equal(state.outbox[0].state, "offered");
  assert.equal(state.outbox[0].offered.callSid, "CA-in-2");
  assert.equal(state.owner.presence.activeCall.callSid, "CA-in-2", "owner is on a live call — no callbacks");
  const again = await opener({ callSid: "CA-in-2", mode: "inbound" });
  assert.deepEqual(again.json.items, [], "offered once per call");
  const callback = await opener({ callSid: "CA-cb-9", mode: "callback" });
  assert.deepEqual(callback.json.items, [], "a callback's batch comes from its own endpoint");
  mock.timers.reset();

  console.log("test-voice-gate: ok");
} finally {
  mock.timers.reset();
  for (const server of servers) server.close();
  await rm(temp, { recursive: true, force: true });
}
