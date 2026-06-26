#!/usr/bin/env npx tsx
import { parseOptionalRecipients, parseRequiredTo } from "../src/nylas/recipients.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const multi = parseRequiredTo("db@project-aeon.com, dbenyamin@gmail.com");
assert(multi.length === 2, "comma-separated to");
assert(multi[0].email === "db@project-aeon.com", "first email");

const cc = parseOptionalRecipients(["guest@example.com"], "cc");
assert(cc && cc[0].email === "guest@example.com", "cc array");

const named = parseRequiredTo(["Giovanni Butera <gbutera@google.com>"]);
assert(named.length === 1, "display-name to length");
assert(named[0].email === "gbutera@google.com", "display-name email");
assert(named[0].name === "Giovanni Butera", "display-name name");

const namedCc = parseOptionalRecipients(
  ["Allison Printz <aprintz@google.com>", "Dan Benyamin <dbenyamin@gmail.com>"],
  "cc",
);
assert(namedCc?.length === 2, "display-name cc length");
assert(namedCc?.[0].email === "aprintz@google.com", "display-name cc email");

try {
  parseRequiredTo("not-an-email");
  assert(false, "should throw");
} catch {
  /* expected */
}

console.log("test-nylas-recipients: ok");
