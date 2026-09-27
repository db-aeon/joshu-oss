import assert from "node:assert/strict";
import test from "node:test";

import { GeminiLiveClient } from "../dist/geminiLiveClient.js";

/** 10 ms of 24 kHz PCM silence — enough to survive resampling to μ-law. */
const PCM_CHUNK = Buffer.alloc(480).toString("base64");

/**
 * Client wired to a fake socket so tests can replay Gemini server messages.
 * Records every handler call in order.
 */
function harness() {
  const events = [];
  const sent = [];
  const client = new GeminiLiveClient(
    { audioFormat: "pcmu" },
    {
      sessionId: "test",
      onOutputAudioDelta: () => events.push("audio"),
      onResponseStarted: ({ reason }) => events.push(`start:${reason}`),
      onResponseDone: ({ status }) => events.push(`done:${status}`),
      onInterrupted: () => events.push("local-interrupt"),
      onSpeechStarted: () => events.push("barge-in"),
      onTranscriptionComplete: () => {},
    },
  );
  client.ws = { readyState: 1, send: (msg) => sent.push(JSON.parse(msg)), close() {} };
  client.sessionReady = true;
  const server = (serverContent) => client.handleServerMessage({ serverContent });
  const audio = () => server({ modelTurn: { parts: [{ inlineData: { data: PCM_CHUNK } }] } });
  return { client, events, sent, server, audio };
}

test("cancelled generation stays muted instead of restarting as organic per chunk", () => {
  const h = harness();
  h.audio(); // organic reply starts
  h.client.cancelActiveResponse();
  h.events.length = 0;
  // Gemini ignores the cancel and keeps streaming (seen on the canary box 2026-09-24).
  h.audio();
  h.audio();
  h.audio();
  assert.deepEqual(h.events, []);
  h.server({ turnComplete: true });
  // Next generation is heard normally.
  h.audio();
  assert.deepEqual(h.events.slice(-2), ["start:organic", "audio"]);
});

test("instruct mid-stream: old audio dropped, new turn keeps its reason", () => {
  const h = harness();
  h.audio(); // organic generation streaming
  h.client.injectAssistantMessage("Your flight leaves at 9:05 AM.");
  h.events.length = 0;
  h.audio(); // trailing chunk of the old generation
  h.server({ interrupted: true }); // Gemini acknowledges the replacement
  h.audio(); // the injected answer
  h.server({ turnComplete: true });
  assert.deepEqual(h.events, ["local-interrupt", "audio", "done:complete"]);
});

test("caller interrupt after a stale cancel is still a barge-in", () => {
  const h = harness();
  h.audio();
  h.client.cancelActiveResponse();
  h.server({ turnComplete: true }); // cancelled turn drained
  h.client.injectAssistantMessage("Here is the answer.");
  h.audio();
  h.events.length = 0;
  h.server({ interrupted: true }); // caller talks over the answer
  assert.deepEqual(h.events, ["barge-in"]);
});

test("cancel before any audio does not mute the next instructed turn", () => {
  const h = harness();
  h.client.injectProgressMessage("One moment.");
  h.client.cancelActiveResponse();
  h.client.injectAssistantMessage("Done.");
  h.events.length = 0;
  h.audio();
  assert.deepEqual(h.events, ["audio"]);
});
