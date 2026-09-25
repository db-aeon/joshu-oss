import assert from "node:assert/strict";
import test from "node:test";

import { askedAnythingElse, classifyWrapUp, wrapUpApplies, wrapUpLine } from "../dist/phoneWrapUp.js";
import { classifyUserTranscript } from "../dist/userInputGate.js";

test("classifies wrap-up turns heard on the canary box 2026-09-24", () => {
  assert.equal(classifyWrapUp("No, that's it. Thank you."), "closing");
  assert.equal(classifyWrapUp("No. Thank you."), "decline");
  assert.equal(classifyWrapUp("No."), "decline");
  assert.equal(classifyWrapUp("No, I'm waiting."), "waiting");
  assert.equal(classifyWrapUp("Um, I'm good, thanks"), "closing");
  assert.equal(classifyWrapUp("Thank you."), "decline");
  assert.equal(classifyWrapUp("Bye!"), "closing");
});

test("turns with real content are not wrap-ups", () => {
  assert.equal(classifyWrapUp("No, make it Friday instead."), null);
  assert.equal(classifyWrapUp("Yeah, just email me the details. Thank you."), null);
  assert.equal(classifyWrapUp("Pull up the flight times, please."), null);
  assert.equal(classifyWrapUp("Okay."), null);
  assert.equal(classifyWrapUp(""), null);
});

test("anything-else prompt detection", () => {
  assert.ok(askedAnythingElse("Still working on it. Anything else I can help with?"));
  assert.ok(askedAnythingElse("Is there anything else you'd like me to handle?"));
  assert.ok(!askedAnythingElse("Want me to send you a fresh link?"));
  assert.ok(!askedAnythingElse(undefined));
});

test("a bare no only closes after an anything-else prompt", () => {
  assert.ok(wrapUpApplies("decline", "Anything else I can help with?", false));
  assert.ok(!wrapUpApplies("decline", "Want me to book the American nonstop?", false));
  // "That's it" answering a specific question is an answer, not a goodbye.
  assert.ok(!wrapUpApplies("closing", "Is that the flight you want?", false));
  assert.ok(wrapUpApplies("closing", "I'll call you back when it's done.", false));
  // "I'm waiting" only matters while an answer is still coming.
  assert.ok(wrapUpApplies("waiting", "One moment.", true));
  assert.ok(!wrapUpApplies("waiting", "One moment.", false));
});

test("wrap-up lines promise a text only while an answer is pending", () => {
  assert.match(wrapUpLine("decline", true), /text you/);
  assert.equal(wrapUpLine("waiting", true), "Still on it.");
  assert.equal(wrapUpLine("closing", false), "Sounds good. Talk soon.");
});

test("punctuated short answers are clear, not noise", () => {
  assert.equal(classifyUserTranscript("No."), "clear");
  assert.equal(classifyUserTranscript("Yes!"), "clear");
  assert.equal(classifyUserTranscript("Eh."), "unclear");
});
