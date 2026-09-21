#!/usr/bin/env npx tsx
/**
 * Unit tests: optional You.com web-search MCP policy (src/youMcpPolicy.ts).
 *
 * Usage: npm run test:you-mcp-policy
 */
import assert from "node:assert/strict";

import {
  desiredYouMcpServer,
  resolveYouMcpUrl,
  toolsetsWithYou,
  youApiKey,
  youMcpEnabled,
  youMcpHeaders,
} from "../src/youMcpPolicy.js";

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Default: fully off — no env vars, no MCP entry, no toolset.
withEnv({ JOSHU_YOU_MCP_ENABLED: "", YDC_API_KEY: "" }, () => {
  assert.equal(youMcpEnabled(), false);
  assert.equal(desiredYouMcpServer(), null);
  assert.equal(youApiKey(), "");
  assert.deepEqual(youMcpHeaders(), {});
  assert.equal(resolveYouMcpUrl(), "https://api.you.com/mcp?profile=free");
});

// Opt-in without a key → keyless free profile, no auth header.
withEnv({ JOSHU_YOU_MCP_ENABLED: "true", YDC_API_KEY: "" }, () => {
  assert.equal(youMcpEnabled(), true);
  assert.equal(resolveYouMcpUrl(), "https://api.you.com/mcp?profile=free");
  assert.deepEqual(youMcpHeaders(), {});
  assert.deepEqual(desiredYouMcpServer(), {
    url: "https://api.you.com/mcp?profile=free",
    headers: {},
    enabled: true,
  });
});

// Opt-in with a key → authenticated endpoint + Bearer header.
withEnv({ JOSHU_YOU_MCP_ENABLED: "1", YDC_API_KEY: "test-key" }, () => {
  assert.equal(youMcpEnabled(), true);
  assert.equal(resolveYouMcpUrl(), "https://api.you.com/mcp");
  assert.deepEqual(youMcpHeaders(), { Authorization: "Bearer test-key" });
  assert.deepEqual(desiredYouMcpServer(), {
    url: "https://api.you.com/mcp",
    headers: { Authorization: "Bearer test-key" },
    enabled: true,
  });
});

// A key alone must NOT enable the provider (explicit opt-in required).
withEnv({ JOSHU_YOU_MCP_ENABLED: "", YDC_API_KEY: "test-key" }, () => {
  assert.equal(youMcpEnabled(), false);
  assert.equal(desiredYouMcpServer(), null);
});

// Explicit opt-out spellings.
for (const off of ["0", "false", "no", "off"]) {
  withEnv({ JOSHU_YOU_MCP_ENABLED: off }, () => {
    assert.equal(youMcpEnabled(), false);
  });
}

// Explicit URL override wins over keyless/authenticated resolution.
withEnv(
  { JOSHU_YOU_MCP_ENABLED: "true", JOSHU_YOU_MCP_URL: "https://you.example.com/mcp" },
  () => {
    assert.equal(resolveYouMcpUrl(), "https://you.example.com/mcp");
  },
);

// Toolset add/remove mirrors toolsetsWithFal.
assert.deepEqual(toolsetsWithYou(["hermes-cli", "browser"], true), [
  "hermes-cli",
  "browser",
  "mcp-you",
]);
assert.deepEqual(toolsetsWithYou(["hermes-cli", "browser"], false), [
  "hermes-cli",
  "browser",
]);
assert.deepEqual(toolsetsWithYou(["hermes-cli", "mcp-you", "browser"], false), [
  "hermes-cli",
  "browser",
]);
assert.deepEqual(toolsetsWithYou(["hermes-cli", "mcp-you", "browser"], true), [
  "hermes-cli",
  "mcp-you",
  "browser",
]);

console.log("test-you-mcp-policy: ok");
