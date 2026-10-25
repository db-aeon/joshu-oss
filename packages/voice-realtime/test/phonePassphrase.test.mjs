import assert from "node:assert/strict";
import test from "node:test";

import {
  looksLikeVoicemailGreeting,
  matchesThinkPassphrase,
  redactPassphrase,
} from "../dist/phonePassphrase.js";

test("redaction strips STT near-misses of the passphrase", () => {
  const secret = "red swoosh";
  assert.equal(redactPassphrase("Red swoosh. Save a note", secret), "Save a note");
  assert.equal(redactPassphrase("red swish, save a note", secret), "save a note");
  assert.equal(redactPassphrase("the red one please", secret), "the red one please");
});

test("voicemail greetings are recognized", () => {
  assert.equal(
    looksLikeVoicemailGreeting("Hi, this is Dan, please leave a message after the tone."),
    true,
  );
  assert.equal(looksLikeVoicemailGreeting("The person you are calling is not available."), true);
  assert.equal(looksLikeVoicemailGreeting("Red swoosh"), false);
  assert.equal(looksLikeVoicemailGreeting("Hello?"), false);
});

test("fuzzy match accepts STT drift around a two-word passphrase", () => {
  const secret = "Falken's Maze";
  assert.equal(matchesThinkPassphrase("Falken's Maze", secret), true);
  assert.equal(matchesThinkPassphrase("Falcon's Maze", secret), true);
  assert.equal(matchesThinkPassphrase("falkens maze", secret), true);
  assert.equal(matchesThinkPassphrase("hello there", secret), false);
});

test("phonetic match accepts quartz heard as courts (PSTN STT)", () => {
  const secret = "quartz lantern";
  assert.equal(matchesThinkPassphrase("Courts Lantern", secret), true);
  assert.equal(matchesThinkPassphrase("quartz lantern", secret), true);
  assert.equal(matchesThinkPassphrase("harbor lantern", secret), false);
});
