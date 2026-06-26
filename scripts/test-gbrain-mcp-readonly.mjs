#!/usr/bin/env node
/**
 * Unit checks for gbrain MCP read-only allowlist (no test runner required).
 */
import assert from "node:assert/strict";
import {
  filterReadOnlyToolList,
  isReadOnlyGbrainTool,
} from "./lib/gbrain-mcp-readonly.mjs";
import { normalizeGbrainQueryArgs, parseGbrainTimeBound } from "./lib/gbrain-query-args.mjs";

assert.equal(isReadOnlyGbrainTool("search"), true);
assert.equal(isReadOnlyGbrainTool("query"), true);
assert.equal(isReadOnlyGbrainTool("get_page"), true);
assert.equal(isReadOnlyGbrainTool("recall"), true);

assert.equal(isReadOnlyGbrainTool("put_page"), false);
assert.equal(isReadOnlyGbrainTool("sync_brain"), false);
assert.equal(isReadOnlyGbrainTool("delete"), false);
assert.equal(isReadOnlyGbrainTool("extract_facts"), false);

const filtered = filterReadOnlyToolList([
  { name: "search", description: "x" },
  { name: "put_page", description: "y" },
  { name: "query", description: "z" },
]);
assert.equal(filtered.length, 2);
assert.ok(filtered.every((t) => isReadOnlyGbrainTool(t.name)));

const since90 = parseGbrainTimeBound("90d");
assert.ok(since90 && /^\d{4}-\d{2}-\d{2}T/.test(since90));
const normalized = normalizeGbrainQueryArgs({ since: "90d", query: "test" });
assert.ok(normalized.since !== "90d");
assert.match(String(normalized.since), /^\d{4}-\d{2}-\d{2}T/);

console.log("test-gbrain-mcp-readonly: ok");
