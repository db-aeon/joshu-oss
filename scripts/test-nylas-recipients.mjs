#!/usr/bin/env npx tsx
import { parseOptionalRecipients, parseRequiredTo } from "../src/nylas/recipients.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const multi = parseRequiredTo("sam@acme.example, sam.owner@example.com");
assert(multi.length === 2, "comma-separated to");
assert(multi[0].email === "sam@acme.example", "first email");

const cc = parseOptionalRecipients(["guest@example.com"], "cc");
assert(cc && cc[0].email === "guest@example.com", "cc array");

const named = parseRequiredTo(["Casey Partner <casey@partner.example>"]);
assert(named.length === 1, "display-name to length");
assert(named[0].email === "casey@partner.example", "display-name email");
assert(named[0].name === "Casey Partner", "display-name name");

const namedCc = parseOptionalRecipients(
  ["Robin Partner <robin@partner.example>", "Sam Owner <sam.owner@example.com>"],
  "cc",
);
assert(namedCc?.length === 2, "display-name cc length");
assert(namedCc?.[0].email === "robin@partner.example", "display-name cc email");

try {
  parseRequiredTo("not-an-email");
  assert(false, "should throw");
} catch {
  /* expected */
}

console.log("test-nylas-recipients: ok");
