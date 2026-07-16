#!/usr/bin/env node
/**
 * Regression: reply subject threading compare + mismatch payload.
 * Usage: node scripts/check-reply-subject.mjs  (needs dist/ — run npm run build first, or tsc)
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  normalizeMailSubjectForThreadCompare,
  replySubjectsMatch,
  buildReplySubjectMismatchError,
} = await import(pathToFileURL(path.join(rootDir, "dist/nylas/replySubject.js")).href);

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

assert(
  normalizeMailSubjectForThreadCompare("Re: Hello") === "Hello",
  "strip single Re:",
);
assert(
  normalizeMailSubjectForThreadCompare("RE: Fwd: Hello") === "Hello",
  "strip stacked Re:/Fwd:",
);
assert(
  replySubjectsMatch(
    "Re: Next steps: 0-to-1 PM role at Google Labs!",
    "Re: Next steps: 0-to-1 PM role at Google Labs!",
  ),
  "exact match",
);
assert(
  replySubjectsMatch(
    "Next steps: 0-to-1 PM role at Google Labs!",
    "Re: Next steps: 0-to-1 PM role at Google Labs!",
  ),
  "Re: prefix only difference ok",
);
assert(
  !replySubjectsMatch(
    "Re: Next steps: 0-to-1 PM role at Google Labs! — Dan's availability",
    "Re: Next steps: 0-to-1 PM role at Google Labs!",
  ),
  "decorated subject must fail",
);

const payload = buildReplySubjectMismatchError({
  got: "Re: Foo — bar",
  expected: "Re: Foo",
});
assert(payload.error === "reply_subject_mismatch", "error code");
assert(payload.expectedSubject === "Re: Foo", "expectedSubject");
assert(payload.hint.includes("Re: Foo"), "hint includes exact subject");

console.log("ok: reply subject checks passed");
