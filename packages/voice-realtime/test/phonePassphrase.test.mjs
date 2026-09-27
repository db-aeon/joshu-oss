import assert from "node:assert/strict";
import test from "node:test";

import {
  isPassphraseOnlyTurn,
  isPassphraseResidue,
  looksLikePhoneTaskRequest,
  looksLikeVoicemailGreeting,
  matchesThinkPassphrase,
  redactPassphrase,
} from "../dist/phonePassphrase.js";

test("leftover unlock audio is residue, real requests are not (canary box 2026-09-24)", () => {
  const secret = "red swoosh";
  // "red swoosh … note" became a queued "Save note" task.
  assert.equal(isPassphraseResidue("Red swoosh, note.", secret, { graceWindow: false }), true);
  assert.equal(isPassphraseResidue("um red swoosh okay", secret, { graceWindow: false }), true);
  assert.equal(isPassphraseResidue("redswoosh", secret, { graceWindow: false }), true);
  // One word of the passphrase only counts right after unlock.
  assert.equal(isPassphraseResidue("swoosh", secret, { graceWindow: true }), true);
  assert.equal(isPassphraseResidue("the red one", secret, { graceWindow: false }), false);
  // A real request after the passphrase is kept.
  assert.equal(
    isPassphraseResidue("red swoosh, find me flights to Bentonville", secret, { graceWindow: true }),
    false,
  );
  assert.equal(isPassphraseResidue("book the nonstop", secret, { graceWindow: true }), false);
});

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
  const secret = "quartz citadel";
  assert.equal(matchesThinkPassphrase("Courts Citadel", secret), true);
  assert.equal(matchesThinkPassphrase("quartz citadel", secret), true);
  assert.equal(matchesThinkPassphrase("harbor lantern", secret), false);
});

test("passphrase-only turns are not task requests", () => {
  const secret = "Falken's Maze";
  assert.equal(isPassphraseOnlyTurn("Falcon's Maze", secret), true);
  assert.equal(isPassphraseOnlyTurn("falkens maze please check my email", secret), false);
  assert.equal(looksLikePhoneTaskRequest("check my email"), true);
  assert.equal(isPassphraseOnlyTurn("what is on my calendar", secret), false);
});
