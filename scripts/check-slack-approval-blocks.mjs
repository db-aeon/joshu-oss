#!/usr/bin/env node
/**
 * Regression: Slack approval mrkdwn chunking (no truncation of long email bodies).
 * Usage: node scripts/check-slack-approval-blocks.mjs  (needs dist/)
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chunkSlackMrkdwn, SLACK_SECTION_TEXT_MAX } = await import(
  pathToFileURL(path.join(rootDir, "dist/ownerChannel/slackMrkdwnChunk.js")).href
);

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const short = "hello";
assert(chunkSlackMrkdwn(short).length === 1, "short stays one chunk");
assert(chunkSlackMrkdwn(short)[0] === short, "short unchanged");

const long = Array.from({ length: 40 }, (_, i) => `Line ${i}: ${"x".repeat(100)}`).join("\n");
const chunks = chunkSlackMrkdwn(long);
assert(chunks.length > 1, "long text yields multiple chunks");
assert(chunks.every((c) => c.length <= SLACK_SECTION_TEXT_MAX), "each chunk under section max");
assert(chunks.join("") === long, `content preserved across chunks (got ${chunks.join("").length} vs ${long.length})`);

console.log("ok: slack approval block chunking passed");
