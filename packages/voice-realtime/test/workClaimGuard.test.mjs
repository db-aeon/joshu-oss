import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import test, { after } from "node:test";

/** Fake Joshu API: an opener with no items, and think jobs that finish at once. */
const joshu = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.method === "POST" && req.url === "/joshu/api/realtime-goals/jobs") {
      return res.end(JSON.stringify({ jobId: "job-1", status: "done", source: "hermes", answer: "Dentist at 3:15 PM.", delivered: [] }));
    }
    res.end(JSON.stringify({ items: [] }));
  });
});
joshu.listen(0, "127.0.0.1");
await once(joshu, "listening");
after(() => joshu.close());

Object.assign(process.env, {
  JOSHU_VOICE_PROVIDER: "gemini_live",
  GEMINI_LIVE_MODEL: "gemini-3.8-live-extended-thinking",
  GEMINI_API_KEY: "test",
  HERMES_API_KEY: "svc",
  JOSHU_API_BASE_URL: `http://127.0.0.1:${joshu.address().port}/joshu`,
});

const { GeminiLiveClient } = await import("../dist/geminiLiveClient.js");
const { TwilioRealtimeSession } = await import("../dist/twilioRealtimeSession.js");
const { detectWorkClaim, WorkClaimGuard, workClaimNote } = await import("../dist/workClaimGuard.js");
const { buildVoiceSystemPrompt, resolveJoshuIdentity } = await import("../dist/joshuIdentity.js");

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(msg) {
    this.sent.push(JSON.parse(msg));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  server(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}
const geminiSockets = [];
GeminiLiveClient.prototype.createSocket = function createSocket() {
  const socket = new FakeSocket();
  geminiSockets.push(socket);
  return socket;
};

async function waitFor(predicate, label) {
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const IDLE = { serverContent: { turnComplete: true, interactionStatus: "IDLE" } };
/** 100 ms of 24 kHz PCM silence: model audio starts a new reply, as on a real call. */
const AUDIO = { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: Buffer.alloc(4800).toString("base64") } }] } } };
const notes = (gemini) =>
  gemini.sent
    .filter((msg) => msg.clientContent?.turnComplete === false)
    .map((msg) => msg.clientContent.turns?.[0]?.parts?.[0]?.text ?? "")
    .filter((text) => text.includes("you called no tool"));
const turns = (gemini) => gemini.sent.filter((msg) => msg.clientContent?.turnComplete === true);

/** A phone call on the native async tool path, past the opener. */
async function openCall(callSid) {
  const session = new TwilioRealtimeSession(new FakeSocket());
  session.handleStart(callSid, `MZ-${callSid}`, { gate: { mode: "inbound", via: "trusted" } });
  const gemini = geminiSockets.at(-1);
  gemini.emit("open");
  gemini.server({ setupComplete: {} });
  await waitFor(() => turns(gemini).length === 1, "opener");
  gemini.server({ serverContent: { outputTranscription: { text: "Hi, what can I do for you?" } } });
  gemini.server(IDLE);
  return { session, gemini };
}

test("work claims: phrases that claim work now, and phrases that do not", () => {
  for (const text of [
    "Let me check your",
    "I'm still looking into this for you.",
    "I'm looking into that right now.",
    "Give me a moment.",
    "I'll check your inbox.",
    "Still working on it.",
  ]) {
    assert.equal(detectWorkClaim(text), true, text);
  }
  for (const text of [
    "I can check that for you if you like.",
    "Paris is the capital of France.",
    "I'm looking forward to it.",
    "Let me know if you need anything else.",
  ]) {
    assert.equal(detectWorkClaim(text), false, text);
  }
  const note = workClaimNote('Let me check "your"');
  assert.match(note, /you said "Let me check 'your'"/);
  assert.match(note, /no tool call is running/);
  assert.match(note, /call think or start_task now/);
});

test("guard: a tool call or a running tool call backs the work claim", () => {
  const guard = new WorkClaimGuard();
  guard.noteReply("Let me check your calendar.", false);
  assert.equal(guard.onInteractionEnd({ functionCalls: ["think"], toolRunning: false }), undefined);
  guard.noteReply("I'm still working on it.", false);
  assert.equal(guard.onInteractionEnd({ functionCalls: [], toolRunning: true }), undefined);
  guard.noteReply("Paris is the capital of France.", false);
  assert.equal(guard.onInteractionEnd({ functionCalls: [], toolRunning: false }), undefined);
  assert.equal(guard.onInteractionEnd({ functionCalls: [], toolRunning: false }), undefined, "one decision per claim");
});

test("guard: note only after an interruption, note and one turn after a finished reply", () => {
  const guard = new WorkClaimGuard();
  guard.noteReply("Let me check your", true);
  const cut = guard.onInteractionEnd({ functionCalls: [], toolRunning: false });
  assert.equal(cut.claim, "Let me check your");
  assert.equal(cut.requestTurn, false);

  guard.noteReply("I'm looking into that right now.", false);
  assert.equal(guard.onInteractionEnd({ functionCalls: [], toolRunning: false }).requestTurn, true);
  guard.noteReply("I'm still looking into it.", false);
  const again = guard.onInteractionEnd({ functionCalls: [], toolRunning: false });
  assert.ok(again, "the second claim still gets a note");
  assert.equal(again.requestTurn, false, "at most one turn before the owner speaks again");

  guard.noteOwnerSpoke();
  guard.noteReply("Let me look.", false);
  assert.equal(guard.onInteractionEnd({ functionCalls: [], toolRunning: false }).requestTurn, true);
  guard.noteReply("Let me look.", false);
  assert.equal(guard.onInteractionEnd({ functionCalls: [], toolRunning: false, callEnding: true }).requestTurn, false);
});

test("phone call: an 'um' cuts off 'Let me check your' before the tool call", async () => {
  const { session, gemini } = await openCall("CA-wc-1");
  gemini.server(AUDIO);
  gemini.server({ serverContent: { outputTranscription: { text: "Let me check your" } } });
  gemini.server({ serverContent: { interrupted: true } });
  gemini.server(IDLE);
  await waitFor(() => notes(gemini).length === 1, "note");
  assert.match(notes(gemini)[0], /you said "Let me check your"/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(turns(gemini).length, 1, "no turn while the owner is talking");
  session.close();
});

test("phone call: a finished 'I'm looking into that' with no tool call gets a note and one turn", async () => {
  const { session, gemini } = await openCall("CA-wc-2");
  gemini.server({ serverContent: { outputTranscription: { text: "I'm looking into that right now." } } });
  gemini.server({ serverContent: { generationComplete: true } });
  gemini.server(IDLE);
  await waitFor(() => turns(gemini).length === 2, "turn after the note");
  assert.equal(notes(gemini).length, 1);
  assert.match(turns(gemini)[1].clientContent.turns[0].parts[0].text, /Continue the conversation/);

  gemini.server({ serverContent: { outputTranscription: { text: "I'm still looking into it." } } });
  gemini.server({ serverContent: { generationComplete: true } });
  gemini.server(IDLE);
  await waitFor(() => notes(gemini).length === 2, "second note");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(turns(gemini).length, 2, "no second turn before the owner speaks");
  session.close();
});

test("phone call: 'Let me check your calendar' with a think call gets no note", async () => {
  const { session, gemini } = await openCall("CA-wc-3");
  gemini.server({ serverContent: { outputTranscription: { text: "Let me check your calendar." } } });
  gemini.server({ toolCall: { functionCalls: [{ id: "call-1", name: "think", args: { user_quote: "When's my dentist?" } }] } });
  gemini.server({ serverContent: { generationComplete: true } });
  gemini.server(IDLE);
  await waitFor(() => gemini.sent.some((msg) => msg.toolResponse), "think result");
  assert.equal(notes(gemini).length, 0);
  session.close();
});

test("prompt: only the native prompts say that only a tool call starts work", () => {
  const identity = resolveJoshuIdentity();
  const rule = /Only a tool call starts work/;
  assert.match(buildVoiceSystemPrompt(identity, "phone", { nativeAsyncTools: true }), rule);
  assert.match(buildVoiceSystemPrompt(identity, "web", { nativeAsyncTools: true }), rule);
  assert.doesNotMatch(buildVoiceSystemPrompt(identity, "phone"), rule);
  assert.doesNotMatch(buildVoiceSystemPrompt(identity, "web"), rule);
});
