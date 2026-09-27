import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { GeminiLiveClient } from "../dist/geminiLiveClient.js";
import { geminiToolDefinitions, PHONE_TOOL_NAMES } from "../dist/realtimeTools.js";
import { startVoiceTask } from "../dist/brainThink.js";
import { runNativeVoiceTool } from "../dist/nativeToolRunner.js";

const ET_MODEL = "gemini-3.8-live-extended-thinking";
/** 10 ms of 24 kHz PCM silence — enough to survive resampling to μ-law. */
const PCM_CHUNK = Buffer.alloc(480).toString("base64");

/** Minimal `ws` stand-in: records sends, replays server messages via emit("message"). */
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

/** Client whose sockets are fakes; `sockets` lists every socket it opened. */
function nativeClient(config = {}, extraHandlers = {}) {
  const events = [];
  const sockets = [];
  const client = new GeminiLiveClient(
    { audioFormat: "pcmu", model: ET_MODEL, ...config },
    {
      sessionId: "test",
      onReady: () => events.push("ready"),
      onOutputAudioDelta: () => events.push("audio"),
      onResponseStarted: ({ reason }) => events.push(`start:${reason}`),
      onResponseDone: ({ status, functionCalls }) =>
        events.push(`done:${status}:${(functionCalls ?? []).join(",")}`),
      onFunctionCall: ({ name }) => events.push(`fn:${name}`),
      onInteractionIdle: ({ functionCalls }) => events.push(`idle:${functionCalls.join(",")}`),
      onSessionResumed: ({ reason }) => events.push(`resumed:${reason.split(" ")[0]}`),
      onTranscriptionComplete: () => {},
      ...extraHandlers,
    },
  );
  client.createSocket = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  client.connect();
  sockets[0].emit("open");
  sockets[0].server({ setupComplete: {} });
  const current = () => sockets.at(-1);
  const audio = (extra = {}) =>
    current().server({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: PCM_CHUNK } }] } },
      ...extra,
    });
  return { client, events, sockets, current, audio };
}

test("native tool declarations are NON_BLOCKING and include start_task", () => {
  const [{ functionDeclarations }] = geminiToolDefinitions([], PHONE_TOOL_NAMES, {
    nativeAsyncTools: true,
  });
  const names = functionDeclarations.map((d) => d.name);
  assert.ok(names.includes("think"));
  assert.ok(names.includes("start_task"));
  assert.ok(functionDeclarations.every((d) => d.behavior === "NON_BLOCKING"));
});

test("legacy tool declarations stay blocking and omit start_task", () => {
  const [{ functionDeclarations }] = geminiToolDefinitions([], PHONE_TOOL_NAMES);
  assert.ok(!functionDeclarations.some((d) => d.name === "start_task"));
  assert.ok(functionDeclarations.every((d) => d.behavior === undefined));
});

test("3.8 ET setup: thinking level, NON_BLOCKING tools, resumption, compression", () => {
  const h = nativeClient({ thinkingLevel: "low", toolNames: PHONE_TOOL_NAMES });
  assert.equal(h.client.nativeAsyncTools, true);
  const { setup } = h.sockets[0].sent[0];
  assert.equal(setup.model, `models/${ET_MODEL}`);
  assert.deepEqual(setup.generationConfig.thinkingConfig, { thinkingLevel: "low" });
  assert.ok(setup.tools[0].functionDeclarations.every((d) => d.behavior === "NON_BLOCKING"));
  assert.deepEqual(setup.sessionResumption, {});
  assert.deepEqual(setup.contextWindowCompression, { slidingWindow: {} });
  // Gemini's own turn-taking decides when the caller is done — no VAD overrides.
  assert.equal(setup.realtimeInputConfig, undefined);
});

test("end_call is declared only natively and only for surfaces that name it (phone)", () => {
  const names = (toolNames, nativeAsyncTools) =>
    geminiToolDefinitions([], toolNames, { nativeAsyncTools })[0].functionDeclarations.map((d) => d.name);
  assert.ok(names(PHONE_TOOL_NAMES, true).includes("end_call"));
  assert.ok(!names(PHONE_TOOL_NAMES, false).includes("end_call"), "legacy phone keeps Joshu wrap-up");
  assert.ok(!names(undefined, true).includes("end_call"), "browser (all tools) has no hang-up");
});

test("plain 3.8 Live is native but sends no thinkingConfig; 3.1 stays legacy", () => {
  const plain = nativeClient({ model: "gemini-3.8-live", thinkingLevel: "low" });
  assert.equal(plain.client.nativeAsyncTools, true);
  assert.equal(plain.sockets[0].sent[0].setup.generationConfig.thinkingConfig, undefined);
  const legacy = new GeminiLiveClient({ model: "gemini-3.1-flash-live-preview" }, {});
  assert.equal(legacy.nativeAsyncTools, false);
});

test("tool call after turnComplete is delivered and reported when the interaction goes IDLE", () => {
  const h = nativeClient();
  h.audio({ interactionStatus: "IN_PROGRESS" }); // "Let me check."
  h.current().server({ serverContent: { turnComplete: true }, interactionStatus: "IN_PROGRESS" });
  // The async think call lands after the spoken turn already completed.
  h.current().server({
    toolCall: { functionCalls: [{ id: "c1", name: "think", args: {} }] },
    interactionStatus: "IN_PROGRESS",
  });
  h.current().server({ interactionStatus: "IDLE" });
  assert.deepEqual(h.events.slice(1), [
    "start:organic",
    "audio",
    "done:complete:",
    "fn:think",
    "idle:think",
  ]);
});

test("turnComplete + IDLE in one message ends the interaction immediately", () => {
  const h = nativeClient();
  h.audio();
  h.current().server({ serverContent: { turnComplete: true }, interactionStatus: "IDLE" });
  assert.deepEqual(h.events.slice(-2), ["done:complete:", "idle:"]);
});

test("native result goes back as a plain function response and its speech is labeled", () => {
  const h = nativeClient();
  h.current().server({ toolCall: { functionCalls: [{ id: "c1", name: "think", args: {} }] } });
  h.client.sendFunctionResult("c1", { status: "done", answer: "Dentist at 3 PM." });
  const sent = h.current().sent.at(-1);
  const response = sent.toolResponse.functionResponses[0];
  assert.equal(response.id, "c1");
  assert.equal(response.name, "think");
  assert.equal(response.response.answer, "Dentist at 3 PM.");
  assert.equal(response.response.silent, undefined);
  assert.equal(sent.clientContent, undefined);
  h.events.length = 0;
  h.audio(); // model speaks the result
  assert.deepEqual(h.events, ["start:function_result", "audio"]);
});

test("native cancel mutes locally without sending an interrupt to the model", () => {
  const h = nativeClient();
  h.audio(); // organic reply the session wants silenced (e.g. during the lock)
  const sentBefore = h.current().sent.length;
  h.client.cancelActiveResponse();
  assert.equal(h.current().sent.length, sentBefore, "no clientContent interrupt sent");
  h.events.length = 0;
  h.audio();
  h.audio();
  assert.deepEqual(h.events, [], "rest of the generation is dropped");
  h.current().server({ serverContent: { turnComplete: true } });
  h.audio(); // next generation is heard
  assert.deepEqual(h.events.slice(-2), ["start:organic", "audio"]);
});

test("native: a Joshu turn waits for the model's current reply instead of cutting it off", () => {
  const h = nativeClient();
  h.audio(); // model mid-reply (e.g. still reading a callback result)
  const sentBefore = h.current().sent.length;
  h.client.injectAssistantMessage("Latest flight is the 10:50 PM United.", "callback_answer");
  assert.equal(h.current().sent.length, sentBefore, "held while the model is speaking");
  h.events.length = 0;
  h.audio();
  assert.deepEqual(h.events, ["audio"], "current reply is not muted or superseded");
  h.current().server({ serverContent: { turnComplete: true } });
  const turn = h.current().sent.at(-1);
  assert.equal(turn.clientContent.turnComplete, true, "sent once the reply finished");
  assert.match(turn.clientContent.turns[0].parts[0].text, /placed this call/);
  assert.deepEqual(h.events.slice(-1), ["start:hermes_inject"]);
});

test("goAway resumes on a new socket with the latest handle; onReady fires once", () => {
  const h = nativeClient();
  h.sockets[0].server({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } });
  h.sockets[0].server({ sessionResumptionUpdate: { newHandle: "h2", resumable: true } });
  h.sockets[0].server({ goAway: { timeLeft: "10s" } });
  assert.equal(h.sockets.length, 2);
  h.sockets[1].emit("open");
  assert.deepEqual(h.sockets[1].sent[0].setup.sessionResumption, { handle: "h2" });
  h.sockets[1].server({ setupComplete: {} });
  assert.deepEqual(
    h.events.filter((e) => e === "ready" || e.startsWith("resumed")),
    ["ready", "resumed:goAway"],
  );
  assert.equal(h.sockets[0].readyState, 3, "retired socket closed after resume");
  // Audio flows on the new socket.
  h.client.appendMulaw8kB64(Buffer.alloc(160, 0xff).toString("base64"));
  assert.ok(h.sockets[1].sent.some((m) => m.realtimeInput));
});

test("unexpected drop with a handle resumes instead of erroring", () => {
  const errors = [];
  const h = nativeClient({}, { onError: (m) => errors.push(m) });
  h.sockets[0].server({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } });
  h.sockets[0].close();
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(errors, []);
});

test("start_task defers straight to the broker with the voice origin", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({ ok: true, goalId: "g1", reply: "I'll call you back when it's done." }),
      { status: 200 },
    );
  });
  const outcome = await runNativeVoiceTool({
    kind: "start_task",
    task: {
      callSid: "CA1",
      jobId: "j1",
      presentation: "phone",
      title: "Flights to Austin",
      objective: "Find nonstop flights to Austin next Tuesday under $400.",
      userQuote: "find me flights to austin next week",
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/realtime-goals\/defer$/);
  assert.equal(calls[0].body.origin.channel, "pstn_voice");
  assert.equal(calls[0].body.origin.sessionKey, "pstn:owner");
  assert.equal(calls[0].body.origin.messageId, "j1");
  assert.equal(calls[0].body.title, "Flights to Austin");
  assert.match(calls[0].body.text, /nonstop flights to Austin/);
  assert.match(calls[0].body.text, /User said: find me flights/);
  assert.equal(outcome.source, "task");
  assert.equal(outcome.result.status, "queued");
  assert.equal(outcome.result.goal_id, "g1");
});

test("start_task failure becomes an error result, not a fake confirmation", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ ok: false, error: "unavailable" }), { status: 400 }),
  );
  const result = await startVoiceTask({ callSid: "CA1", jobId: "j2", objective: "x" });
  assert.deepEqual(result, { ok: false, error: "unavailable" });
});
