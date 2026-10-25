import assert from "node:assert/strict";
import { scryptSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";

// Env is read at module load — set it before importing the gate.
const AUTH_TOKEN = "test-auth-token";
const ACCOUNT_SID = "AC0000000000000000000000000000test";
const PASSPHRASE = "Falken's Maze";
const OWNER = "+15551230000";
const aroz = mkdtempSync(join(tmpdir(), "joshu-gate-aroz-"));
const userDir = join(aroz, "files", "users", "owner@example.com");
mkdirSync(join(userDir, "Desktop"), { recursive: true });
mkdirSync(join(userDir, ".joshu", "telephone"), { recursive: true });
const clipDir = mkdtempSync(join(tmpdir(), "joshu-gate-clips-"));

/** Fake Joshu: records callback outcome reports from the gate. */
const outcomes = [];
const joshu = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    outcomes.push({ url: req.url, callSid: req.headers["x-joshu-voice-call-sid"], body: JSON.parse(body || "{}") });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});
joshu.listen(0, "127.0.0.1");
await once(joshu, "listening");

Object.assign(process.env, {
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_ACCOUNT_SID: ACCOUNT_SID,
  TWILIO_THINK_PASSWORD: PASSPHRASE,
  TWILIO_MEDIA_STREAM_SECRET: "media-secret",
  AROZ_DATA: aroz,
  VOICE_LOCK_PROMPT_DIR: clipDir,
  JOSHU_API_BASE_URL: `http://127.0.0.1:${joshu.address().port}/joshu`,
  HERMES_API_KEY: "svc",
  JOSHU_NAME: "Ava",
});
delete process.env.JOSHU_VOICE_GATE_SPEECH_MODEL;

const { default: express } = await import("express");
const { computeTwilioSignature, validateTwilioRequest } = await import("../dist/gate/twilioSignature.js");
const { createGateRouter, MAX_GATE_ROUNDS } = await import("../dist/gate/routes.js");
const { mintUnlockToken, redeemUnlockToken, UNLOCK_TOKEN_TTL_MS } = await import("../dist/gate/unlockToken.js");
const { resetPinFailures, PIN_FAILURE_LIMIT, verifyPin } = await import("../dist/gate/pin.js");
const { clearLockPromptCache, LOCK_PROMPTS } = await import("../dist/lockPrompts.js");
const { matchesGatePassphrase } = await import("../dist/phonePassphrase.js");

const app = express();
app.use(createGateRouter());
const server = http.createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
/** What Twilio signs: the public URL, as Caddy forwards it. */
const PUBLIC = "https://box.example.test";

function writeSettings(settings) {
  writeFileSync(join(userDir, ".joshu", "telephone", "settings.json"), JSON.stringify(settings));
}

function pinHash(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** POST like Twilio: form body, signature over the public URL. */
async function twilioPost(pathAndQuery, params, { sign = true, accountSid = ACCOUNT_SID } = {}) {
  const body = { AccountSid: accountSid, CallSid: "CA-test-1", From: OWNER, To: "+15550009999", ...params };
  const signature = computeTwilioSignature(AUTH_TOKEN, `${PUBLIC}${pathAndQuery}`, body);
  const response = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-Host": "box.example.test",
      "X-Forwarded-Proto": "https",
      ...(sign ? { "X-Twilio-Signature": signature } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });
  return { status: response.status, xml: await response.text() };
}

/** Follow the Gather action URL the gate handed out. */
function actionPath(xml) {
  const match = xml.match(/action="([^"]+)"/);
  assert.ok(match, `no Gather action in ${xml}`);
  const url = new URL(match[1].replace(/&amp;/g, "&"));
  assert.equal(url.origin, PUBLIC, "action URLs are absolute on the signed public origin");
  return `${url.pathname}${url.search}`;
}

function unlockParam(xml) {
  return xml.match(/<Parameter name="unlock" value="([^"]+)"/)?.[1];
}

before(() => writeSettings({ ownerCaller: OWNER }));
beforeEach(() => {
  outcomes.length = 0;
  resetPinFailures();
  writeSettings({ ownerCaller: OWNER });
});
after(() => {
  server.close();
  joshu.close();
  rmSync(aroz, { recursive: true, force: true });
  rmSync(clipDir, { recursive: true, force: true });
});

test("signatures match the Twilio SDK and pin the public URL", () => {
  const params = { CallSid: "CA1", Digits: "1234", From: "+1555", To: "+1666" };
  const url = "https://box.example.test/voice-rt/gate/check?mode=inbound&attempt=0";
  const signature = computeTwilioSignature(AUTH_TOKEN, url, params);
  try {
    const twilio = createRequire(import.meta.url)("twilio");
    assert.equal(twilio.validateRequest(AUTH_TOKEN, signature, url, params), true);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
  const req = {
    originalUrl: "/voice-rt/gate/check?mode=inbound&attempt=0",
    headers: { host: "127.0.0.1:8792", "x-forwarded-host": "box.example.test", "x-twilio-signature": signature },
    body: params,
  };
  assert.equal(validateTwilioRequest(AUTH_TOKEN, req), url);
  assert.equal(validateTwilioRequest("other-token", req), undefined);
  // Tampering with the query (e.g. attempt counter) breaks the signature.
  assert.equal(validateTwilioRequest(AUTH_TOKEN, { ...req, originalUrl: "/voice-rt/gate/check?mode=inbound&attempt=9" }), undefined);
});

test("unsigned, mis-signed, or other-account requests are refused", async () => {
  assert.equal((await twilioPost("/voice-rt/gate/start?mode=inbound", {}, { sign: false })).status, 403);
  assert.equal((await twilioPost("/voice-rt/gate/start?mode=inbound", {}, { accountSid: "ACother" })).status, 403);
});

test("inbound: greeting gathers speech with passphrase hints, falls back to <Say> without clips", async () => {
  const { status, xml } = await twilioPost("/voice-rt/gate/start?mode=inbound&trusted=0", {});
  assert.equal(status, 200);
  assert.match(xml, /<Gather [^>]*input="speech"/);
  assert.match(xml, /speechTimeout="auto"/);
  assert.match(xml, /actionOnEmptyResult="true"/);
  assert.match(xml, /hints="Falken&apos;s Maze, Falken&apos;s, Maze"/);
  assert.doesNotMatch(xml, /numDigits/);
  assert.ok(xml.includes(`<Say>${LOCK_PROMPTS.greeting}</Say>`));
  assert.match(actionPath(xml), /^\/voice-rt\/gate\/check\?mode=inbound&attempt=0&round=1$/);
});

test("inbound: the right passphrase opens a stream with a single-use token bound to the call", async () => {
  const start = await twilioPost("/voice-rt/gate/start?mode=inbound", {});
  const { xml } = await twilioPost(actionPath(start.xml), { SpeechResult: "Falcon's Maze.", Confidence: "0.9" });
  assert.match(xml, /<Connect><Stream url="wss:\/\/box\.example\.test\/voice-rt\/media\/media-secret">/);
  assert.match(xml, /<Parameter name="caller" value="\+15551230000"\/>/);
  assert.match(xml, /<Parameter name="ownerCaller" value="\+15551230000"\/>/);
  const token = unlockParam(xml);
  assert.ok(token);
  assert.equal(redeemUnlockToken(token, "CA-other"), undefined, "bound to its CallSid");
  const claims = redeemUnlockToken(token, "CA-test-1");
  assert.equal(claims?.via, "passphrase");
  assert.equal(claims?.mode, "inbound");
  assert.equal(redeemUnlockToken(token, "CA-test-1"), undefined, "single use");
});

test("unlock tokens expire and cannot be forged", () => {
  const now = Date.now();
  const token = mintUnlockToken({ callSid: "CA-x", mode: "inbound", via: "pin" }, now);
  assert.equal(redeemUnlockToken(token, "CA-x", now + UNLOCK_TOKEN_TTL_MS + 1), undefined);
  const [payload] = token.split(".");
  assert.equal(redeemUnlockToken(`${payload}.forged`, "CA-x", now), undefined);
  assert.ok(redeemUnlockToken(token, "CA-x", now + 1_000));
});

test("wrong answers: retry, last try, then lockout — unclear speech and silence spend nothing", async () => {
  let { xml } = await twilioPost("/voice-rt/gate/start?mode=inbound", {});
  ({ xml } = await twilioPost(actionPath(xml), { SpeechResult: "open sesame please" }));
  assert.ok(xml.includes(`<Say>${LOCK_PROMPTS.retry}</Say>`));
  assert.match(actionPath(xml), /attempt=1&round=2/);
  ({ xml } = await twilioPost(actionPath(xml), {}));
  assert.ok(xml.includes(`<Say>${LOCK_PROMPTS.unclear}</Say>`), "silence asks again");
  assert.match(actionPath(xml), /attempt=1&round=3/);
  ({ xml } = await twilioPost(actionPath(xml), { SpeechResult: "Hmm." }));
  assert.match(actionPath(xml), /attempt=1&round=4/, "a filler is not an attempt");
  ({ xml } = await twilioPost(actionPath(xml), { SpeechResult: "maze" }));
  assert.ok(xml.includes(`<Say>${LOCK_PROMPTS.last_try}</Say>`), "half the passphrase is wrong");
  ({ xml } = await twilioPost(actionPath(xml), { SpeechResult: "harbor lantern" }));
  assert.ok(xml.includes(`<Say>${LOCK_PROMPTS.locked_out}</Say><Hangup/>`));
  assert.equal(unlockParam(xml), undefined);
});

test("a silent line is hung up after the round limit", async () => {
  let { xml } = await twilioPost("/voice-rt/gate/start?mode=inbound", {});
  for (let round = 1; round < MAX_GATE_ROUNDS; round += 1) {
    ({ xml } = await twilioPost(actionPath(xml), {}));
    assert.match(xml, /<Gather/);
  }
  ({ xml } = await twilioPost(actionPath(xml), {}));
  assert.match(xml, /<Response><Hangup\/><\/Response>/);
});

test("PIN: keypad accepted alongside speech; wrong PINs count box-wide", async () => {
  const hash = pinHash("482913");
  assert.equal(verifyPin("482913", hash), true);
  assert.equal(verifyPin("482914", hash), false);
  writeSettings({ ownerCaller: OWNER, pinHash: hash, pinLength: 6 });
  let { xml } = await twilioPost("/voice-rt/gate/start?mode=inbound", {});
  assert.match(xml, /input="dtmf speech"/);
  assert.match(xml, /numDigits="6"/);
  assert.ok(xml.includes(`<Say>${LOCK_PROMPTS.greeting_pin}</Say>`));
  const first = actionPath(xml);
  ({ xml } = await twilioPost(first, { Digits: "000000" }));
  assert.ok(xml.includes(`<Say>${LOCK_PROMPTS.retry}</Say>`));
  ({ xml } = await twilioPost(actionPath(xml), { Digits: "482913" }));
  assert.equal(redeemUnlockToken(unlockParam(xml), "CA-test-1")?.via, "pin");

  for (let i = 1; i < PIN_FAILURE_LIMIT; i += 1) await twilioPost(first, { Digits: "111111" });
  ({ xml } = await twilioPost("/voice-rt/gate/start?mode=inbound", {}));
  assert.match(xml, /input="speech"/, "keypad off after too many wrong PINs");
  ({ xml } = await twilioPost(first, { Digits: "482913" }));
  assert.equal(unlockParam(xml), undefined, "even the right PIN is refused while locked");
});

test("verified owner caller ID skips the passphrase only when the owner opted in", async () => {
  let { xml } = await twilioPost("/voice-rt/gate/start?mode=inbound&trusted=1", {});
  assert.match(xml, /<Gather/, "opt-in off → still gated");
  writeSettings({ ownerCaller: OWNER, trustVerifiedCallerId: true });
  ({ xml } = await twilioPost("/voice-rt/gate/start?mode=inbound&trusted=1", { From: "+15559999999" }));
  assert.match(xml, /<Gather/, "not the owner's number → still gated");
  ({ xml } = await twilioPost("/voice-rt/gate/start?mode=inbound&trusted=0", {}));
  assert.match(xml, /<Gather/, "no verified attestation → still gated");
  ({ xml } = await twilioPost("/voice-rt/gate/start?mode=inbound&trusted=1", {}));
  assert.equal(redeemUnlockToken(unlockParam(xml), "CA-test-1")?.via, "trusted");
});

test("callbacks: greeting names the assistant, voicemail leaves a notice, lockout reports", async () => {
  const q = "/voice-rt/gate/start?mode=callback&batch=b-1&bt=b-1.sig&req=1";
  let { xml } = await twilioPost(q, { From: "+15550009999", To: OWNER });
  assert.ok(xml.includes(`<Say>${LOCK_PROMPTS.callback_greeting}</Say>`));
  assert.match(LOCK_PROMPTS.callback_greeting, /Ava/);
  const check = actionPath(xml);
  assert.match(check, /batch=b-1&bt=b-1.sig&req=1/);

  ({ xml } = await twilioPost(check, { SpeechResult: "Hi, you've reached Dan. Please leave a message after the tone." }));
  assert.ok(xml.includes(`<Pause length="1"/><Say>${LOCK_PROMPTS.voicemail_notice}</Say><Hangup/>`));
  assert.deepEqual(outcomes.map((o) => [o.url, o.callSid, o.body.outcome]), [
    ["/joshu/api/realtime-goals/voice/batch/b-1/outcome?token=b-1.sig", "CA-test-1", "voicemail"],
  ]);

  ({ xml } = await twilioPost(check, { SpeechResult: "Falken's Maze", To: OWNER }));
  assert.match(xml, /<Parameter name="caller" value="\+15551230000"\/>/, "callback caller is the number dialed");
  assert.match(xml, /<Parameter name="realtimeGoalBatchId" value="b-1"\/>/);
  assert.match(xml, /<Parameter name="ownerRequested" value="1"\/>/);
  assert.equal(redeemUnlockToken(unlockParam(xml), "CA-test-1")?.mode, "callback");

  outcomes.length = 0;
  let path = check;
  for (const wrong of ["banana split", "orange juice", "grape soda"]) {
    ({ xml } = await twilioPost(path, { SpeechResult: wrong }));
    if (xml.includes("<Gather")) path = actionPath(xml);
  }
  assert.match(xml, /<Hangup\/>/);
  assert.deepEqual(outcomes.map((o) => o.body.outcome), ["auth_failed"]);

  ({ xml } = await twilioPost("/voice-rt/gate/voicemail?mode=callback&batch=b-1", {}));
  assert.ok(xml.includes(`<Say>${LOCK_PROMPTS.voicemail_notice}</Say><Hangup/>`));
  assert.doesNotMatch(xml, /<Pause/, "answering machine: the beep already happened");
});

test("rendered clips are played from versioned WAV URLs", async () => {
  // One second of PCM16 @ 24 kHz, as the clip generator writes it.
  writeFileSync(join(clipDir, "greeting.pcm.b64"), `${Buffer.alloc(48000).toString("base64")}\n`);
  clearLockPromptCache();
  const { xml } = await twilioPost("/voice-rt/gate/start?mode=inbound", {});
  const url = xml.match(/<Play>([^<]+)<\/Play>/)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(url, xml);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/voice-rt/gate/clips/greeting.wav");
  assert.match(parsed.searchParams.get("v") ?? "", /^[0-9a-f]{12}$/);
  const response = await fetch(`http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.length, 44 + 16000, "one second of PCM16 @ 8 kHz");
  assert.equal((await fetch(`http://127.0.0.1:${port}/voice-rt/gate/clips/nope.wav`)).status, 404);
});

test("gate passphrase match drops the one-word shortcut but keeps STT tolerance", () => {
  assert.equal(matchesGatePassphrase("Falcon's Maze", PASSPHRASE), true);
  assert.equal(matchesGatePassphrase("falkens maze.", PASSPHRASE), true);
  assert.equal(matchesGatePassphrase("It's Falken's Maze", PASSPHRASE), true);
  assert.equal(matchesGatePassphrase("maze", PASSPHRASE), false);
  assert.equal(matchesGatePassphrase("Falken", PASSPHRASE), false);
  assert.equal(matchesGatePassphrase("Courts Lantern", "quartz lantern"), true);
});
