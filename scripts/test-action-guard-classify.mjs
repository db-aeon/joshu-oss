#!/usr/bin/env node
/**
 * Fixture tests for action-guard classification (external_writes vs allowlist).
 */
import assert from "node:assert/strict";
import {
  guardedComposioCalls,
  isActionGuarded,
  isActionGuardedExternalWrites,
  isComposioWriteTool,
  isGuardedComposioTool,
} from "./lib/action-guard-classify.mjs";

const externalPolicy = {
  enabled: true,
  gateMode: "external_writes",
  guardedActions: ["nylas_send_message"],
  browserGateWrites: false,
};

const allowlistPolicy = {
  enabled: true,
  gateMode: "allowlist",
  guardedActions: ["nylas_send_message", "composio:GMAIL_SEND_EMAIL"],
  browserGateWrites: false,
};

// Composio write heuristics
assert.equal(isComposioWriteTool("GOOGLECALENDAR_CREATE_EVENT"), true);
assert.equal(isComposioWriteTool("SLACK_SEND_MESSAGE"), true);
assert.equal(isComposioWriteTool("GITHUB_CREATE_ISSUE"), true);
assert.equal(isComposioWriteTool("GMAIL_LIST_EMAILS"), false);
assert.equal(isComposioWriteTool("COMPOSIO_SEARCH_TOOLS"), false);
assert.equal(isComposioWriteTool("GOOGLECALENDAR_FIND_FREE_SLOTS"), false);
assert.equal(isComposioWriteTool("GOOGLECALENDAR_PATCH_EVENT"), true, "a patch can notify guests");

// external_writes mode
assert.equal(
  isActionGuarded("composio:GOOGLECALENDAR_CREATE_EVENT", externalPolicy),
  true,
);
assert.equal(isActionGuarded("composio:GMAIL_LIST_EMAILS", externalPolicy), false);
assert.equal(isActionGuarded("nylas_send_message", externalPolicy), true);
assert.equal(isActionGuarded("browser:click", externalPolicy), false);

const browserPolicy = { ...externalPolicy, browserGateWrites: true };
assert.equal(isActionGuarded("browser:click", browserPolicy), true);
assert.equal(isActionGuarded("browser:snapshot", browserPolicy), false);

// allowlist mode — only explicit ids
assert.equal(isActionGuarded("composio:GOOGLECALENDAR_CREATE_EVENT", allowlistPolicy), false);
assert.equal(isActionGuarded("nylas_send_message", allowlistPolicy), true);
assert.equal(isGuardedComposioTool("GMAIL_SEND_EMAIL", allowlistPolicy), true);

// disabled policy
assert.equal(isActionGuarded("nylas_send_message", { ...externalPolicy, enabled: false }), false);

// direct external writes helper
assert.equal(
  isActionGuardedExternalWrites("composio:SLACK_POST_MESSAGE", externalPolicy),
  true,
);

// Composio meta tools stay reads by name. Their inner tool calls are checked
// by guardedComposioCalls (more cases in scripts/test-composio-guard-bypasses.mjs).
assert.equal(isComposioWriteTool("COMPOSIO_MULTI_EXECUTE_TOOL"), false);
const calendarCreate = { tools: [{ tool_slug: "GOOGLECALENDAR_CREATE_EVENT", arguments: {} }] };
assert.equal(guardedComposioCalls("COMPOSIO_MULTI_EXECUTE_TOOL", calendarCreate, externalPolicy).length, 1);
assert.equal(
  guardedComposioCalls("COMPOSIO_MULTI_EXECUTE_TOOL", calendarCreate, allowlistPolicy).length,
  0,
  "allowlist mode gates only listed ids",
);

console.log("action-guard classify fixtures: ok");
