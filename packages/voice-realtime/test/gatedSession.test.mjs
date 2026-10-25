import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

/** Fake Joshu: opener with one unheard result; records presence / heard posts. */
const posts = [];
const joshu = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    posts.push({ path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/joshu/api/telephone/owner-mobile/from-call") {
      res.end(JSON.stringify({ status: "saved", ownerCallerDisplay: "+1 (310) 555-0199" }));
      return;
    }
    if (req.url === "/joshu/api/realtime-goals/voice/opener") {
      res.end(
        JSON.stringify({
          context: "- Cancun flights (done; result NOT yet heard by owner — offer it)",
          items: [{ id: "i1", kind: "completed", title: "Cancun flights", text: "Delta nonstop, Dec 20, $838." }],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ items: [] }));
  });
});
joshu.listen(0, "127.0.0.1");
await once(joshu, "listening");

const clipDir = mkdtempSync(join(tmpdir(), "joshu-gated-clips-"));
// "Unlocked." — half a second of PCM16 @ 24 kHz.
writeFileSync(join(clipDir, "unlocked.pcm.b64"), `${Buffer.alloc(24000).toString("base64")}\n`);

Object.assign(process.env, {
  JOSHU_VOICE_PROVIDER: "gemini_live",
  GEMINI_LIVE_MODEL: "gemini-3.8-live-extended-thinking",
  GEMINI_API_KEY: "test",
  HERMES_API_KEY: "svc",
  JOSHU_API_BASE_URL: `http://127.0.0.1:${joshu.address().port}/joshu`,
  JOSHU_OWNER_NAME: "Dan",
  JOSHU_OWNER_LANGUAGE: "English",
  TWILIO_THINK_PASSWORD: "harbor lantern",
  VOICE_LOCK_PROMPT_DIR: clipDir,
});

const { GeminiLiveClient } = await import("../dist/geminiLiveClient.js");
const { TwilioRealtimeSession } = await import("../dist/twilioRealtimeSession.js");

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
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

after(() => {
  joshu.close();
  rmSync(clipDir, { recursive: true, force: true });
});

test("gated inbound call: unlocked clip, owner context at setup, exactly one opening turn", async () => {
  const twilio = new FakeSocket();
  const session = new TwilioRealtimeSession(twilio);
  session.handleStart("CA-gated-1", "MZ-1", {
    caller: "+13105550100",
    ownerCaller: "+13105550100",
    gate: { mode: "inbound", via: "passphrase" },
  });

  // "Unlocked." goes straight down the media stream while the model connects.
  const media = twilio.sent.filter((msg) => msg.event === "media");
  assert.equal(media.length, 25, "0.5 s of μ-law in 20 ms frames");
  assert.ok(twilio.sent.some((msg) => msg.event === "mark"));

  const gemini = geminiSockets.at(-1);
  gemini.emit("open");
  await waitFor(() => gemini.sent.some((msg) => msg.setup), "setup");
  const instruction = gemini.sent.find((msg) => msg.setup).setup.systemInstruction.parts[0].text;
  assert.match(instruction, /passed the passphrase check before you joined/);
  assert.doesNotMatch(instruction, /The call starts locked/, "no lock rules for a gated call");
  assert.match(instruction, /Delta nonstop, Dec 20, \$838\./, "unheard result text is in context");
  assert.match(instruction, /RESPOND IN ENGLISH/);

  gemini.server({ setupComplete: {} });
  await waitFor(() => gemini.sent.some((msg) => msg.clientContent?.turnComplete === true), "opener");
  const turns = gemini.sent.filter((msg) => msg.clientContent?.turnComplete === true);
  assert.equal(turns.length, 1, "exactly one opening turn");
  const opener = turns[0].clientContent.turns[0].parts[0].text;
  assert.match(opener, /Hi Dan — your Cancun flights results are ready\. Want to hear them\?/);
  assert.equal(
    gemini.sent.filter((msg) => msg.clientContent && msg.clientContent.turnComplete === false).length,
    0,
    "context went into setup, not a late context turn",
  );
  assert.ok(posts.some((post) => post.path === "/joshu/api/realtime-goals/voice/opener" && post.body.callSid === "CA-gated-1"));

  // The model answers in Spanish: logged and corrected once.
  gemini.server({ serverContent: { outputTranscription: { text: "Claro, puedo ayudarte con eso. ¿Qué necesitas para el viaje?" } } });
  gemini.server({ serverContent: { turnComplete: true } });
  gemini.server({ serverContent: { outputTranscription: { text: "Sí, claro, el vuelo de Delta es el más barato para ti." } } });
  gemini.server({ serverContent: { turnComplete: true } });
  const corrections = gemini.sent.filter((msg) =>
    msg.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes("The owner speaks English"),
  );
  assert.equal(corrections.length, 1, "one correction per call");

  session.close();
  await waitFor(() => posts.some((post) => post.body?.event === "ended"), "presence ended");
});

test("gated call: the owner talking first skips the greeting", async () => {
  const twilio = new FakeSocket();
  const session = new TwilioRealtimeSession(twilio);
  session.handleStart("CA-gated-2", "MZ-2", { gate: { mode: "inbound", via: "trusted" } });
  assert.equal(twilio.sent.filter((msg) => msg.event === "media").length, 0, "trusted caller: no unlock clip");
  const gemini = geminiSockets.at(-1);
  gemini.emit("open");
  await waitFor(() => gemini.sent.some((msg) => msg.setup), "setup");
  gemini.server({ setupComplete: {} });
  gemini.server({ serverContent: { inputTranscription: { text: "Hey, did the Cancun search finish?" } } });
  await waitFor(() => posts.some((post) => post.body?.callSid === "CA-gated-2"), "opener fetch");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const turns = gemini.sent.filter((msg) => msg.clientContent?.turnComplete === true);
  assert.equal(turns.length, 0, "no greeting over the owner");
  session.close();
});

/** Declared tool names and the system instruction of a call's Gemini setup. */
async function setupOf(gemini) {
  gemini.emit("open");
  await waitFor(() => gemini.sent.some((msg) => msg.setup), "setup");
  const setup = gemini.sent.find((msg) => msg.setup).setup;
  return {
    tools: setup.tools.flatMap((tool) => tool.functionDeclarations ?? []).map((decl) => decl.name),
    instruction: setup.systemInstruction.parts[0].text,
  };
}

const toolResponses = (gemini) =>
  gemini.sent.flatMap((msg) => msg.toolResponse?.functionResponses ?? []);
const savePosts = () => posts.filter((post) => post.path === "/joshu/api/telephone/owner-mobile/from-call");

test("owner mobile offer: eligible call declares the tool, saves the caller ID on a clear yes, once", async () => {
  const session = new TwilioRealtimeSession(new FakeSocket());
  session.handleStart("CA-offer-1", "MZ-o1", {
    caller: "+13105550199",
    gate: { mode: "inbound", via: "passphrase" },
  });
  const gemini = geminiSockets.at(-1);
  const { tools, instruction } = await setupOf(gemini);
  assert.ok(tools.includes("save_owner_mobile"));
  assert.match(instruction, /ending in 0199/);
  gemini.server({ setupComplete: {} });

  gemini.server({ serverContent: { inputTranscription: { text: "Yes, save it." } } });
  gemini.server({
    toolCall: {
      functionCalls: [{ id: "s1", name: "save_owner_mobile", args: { user_quote: "Yes, save it.", number: "+19995550000" } }],
    },
  });
  await waitFor(() => toolResponses(gemini).some((r) => r.id === "s1"), "save result");
  assert.deepEqual(savePosts().map((post) => post.body), [{ callSid: "CA-offer-1", caller: "+13105550199" }], "the caller ID, never a number from the model");
  assert.match(toolResponses(gemini).find((r) => r.id === "s1").response.answer, /now the owner's mobile/);

  gemini.server({ toolCall: { functionCalls: [{ id: "s2", name: "save_owner_mobile", args: { user_quote: "yes" } }] } });
  await waitFor(() => toolResponses(gemini).some((r) => r.id === "s2"), "second result");
  assert.equal(savePosts().length, 1, "one try per call");
  session.close();
});

test("owner mobile offer: an unclear reply saves nothing", async () => {
  const before = savePosts().length;
  const session = new TwilioRealtimeSession(new FakeSocket());
  session.handleStart("CA-offer-2", "MZ-o2", { caller: "+13105550199", gate: { mode: "inbound", via: "pin" } });
  const gemini = geminiSockets.at(-1);
  await setupOf(gemini);
  gemini.server({ setupComplete: {} });
  gemini.server({ serverContent: { inputTranscription: { text: "hmm, maybe later" } } });
  gemini.server({
    toolCall: { functionCalls: [{ id: "u1", name: "save_owner_mobile", args: { user_quote: "hmm, maybe later" } }] },
  });
  await waitFor(() => toolResponses(gemini).some((r) => r.id === "u1"), "unclear result");
  assert.equal(savePosts().length, before, "nothing posted");
  assert.match(toolResponses(gemini).find((r) => r.id === "u1").response.answer, /did not clearly say yes/);
  session.close();
});

test("owner mobile offer: no tool and no offer when the box has an owner mobile", async () => {
  const session = new TwilioRealtimeSession(new FakeSocket());
  session.handleStart("CA-offer-3", "MZ-o3", {
    caller: "+13105550199",
    ownerCaller: "+13105550100",
    gate: { mode: "inbound", via: "passphrase" },
  });
  const gemini = geminiSockets.at(-1);
  const { tools, instruction } = await setupOf(gemini);
  assert.equal(tools.includes("save_owner_mobile"), false);
  assert.doesNotMatch(instruction, /\[Owner mobile\]/);
  session.close();
});
