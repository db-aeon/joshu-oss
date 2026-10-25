import assert from "node:assert/strict";
import test from "node:test";

import { classifyUserTranscript } from "../dist/userInputGate.js";

test("non-ASCII STT is unclear so it does not burn passphrase attempts", () => {
  assert.equal(classifyUserTranscript("Hörst du das?"), "unclear");
  assert.equal(classifyUserTranscript("Não."), "unclear");
  assert.equal(classifyUserTranscript("Courts Lantern"), "clear");
  assert.equal(classifyUserTranscript("uh"), "unclear");
  assert.equal(classifyUserTranscript(""), "empty");
});
