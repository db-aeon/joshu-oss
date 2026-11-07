#!/usr/bin/env npx tsx
/**
 * AG-UI app chat threads become Hermes session ids. Hermes answers 400 when a session id holds
 * a path separator, so a jNotes chat on `Notes/financial planning.md` got no reply. The thread
 * id must be encoded, and a safe id must stay the same so existing sessions keep their history.
 *
 * Usage: npm run test:ag-ui-session-id
 */
import assert from "node:assert/strict";

import { describeRunError, toHermesSessionId } from "../src/agUiAppContext.ts";

/** Same rule as Hermes `gateway.session._is_path_unsafe` plus the api_server header checks. */
function hermesAccepts(id) {
  if (id.includes("..") || id.includes("/") || id.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(id)) return false;
  if (/[\r\n\0]/.test(id)) return false;
  return id.length <= 256;
}

// Safe thread ids pass through unchanged.
for (const id of ["md-editor:plan.md:chat:1", "jmail:inbox:chat:1730000000000", "agui-1730000000000"]) {
  assert.equal(toHermesSessionId(id), id);
}

// A jNotes chat on a note inside a folder (the failure seen on 2026-10-29).
const notes = toHermesSessionId("md-editor:Notes/financial planning.md:chat:1");
assert.equal(notes, "md-editor:Notes%2Ffinancial planning.md:chat:1");
assert.ok(hermesAccepts(notes));

// Other unsafe shapes are accepted by Hermes after encoding.
for (const id of [
  "md-editor:a/b/c.md:chat:1",
  "md-editor:..\\secret.md:chat:1",
  "x:scope/with/slash:chat:1",
  "md-editor:line\nbreak:chat:1",
  `md-editor:${"deep/".repeat(80)}file.md:chat:1`,
]) {
  const encoded = toHermesSessionId(id);
  assert.ok(hermesAccepts(encoded), `Hermes rejects ${JSON.stringify(encoded)}`);
  assert.equal(toHermesSessionId(id), encoded, "encoding must be stable across turns");
}

// Two files that differ only by "/" vs a literal "%2F" do not share a session.
assert.notEqual(
  toHermesSessionId("md-editor:a/b.md:chat:1"),
  toHermesSessionId("md-editor:a%2Fb/x.md:chat:1"),
);

// Long paths that share a prefix stay distinct after truncation.
const longA = toHermesSessionId(`md-editor:${"deep/".repeat(80)}a.md:chat:1`);
const longB = toHermesSessionId(`md-editor:${"deep/".repeat(80)}b.md:chat:1`);
assert.ok(longA.length <= 256 && longB.length <= 256);
assert.notEqual(longA, longB);

// Run errors shown in the chat panel keep the Hermes message and drop the raw JSON body.
assert.equal(
  describeRunError(
    'Hermes chat request failed: 400 {"error":{"message":"Invalid session ID","type":"invalid_request_error"}}',
  ),
  "Hermes returned 400: Invalid session ID",
);
assert.equal(describeRunError("Hermes chat request failed: 502 Bad Gateway"), "Hermes returned 502: Bad Gateway");
assert.equal(describeRunError("Hermes chat request failed: 503 "), "Hermes returned 503.");
assert.equal(describeRunError("socket hang up"), "socket hang up");

console.log("ag-ui session id: ok");
