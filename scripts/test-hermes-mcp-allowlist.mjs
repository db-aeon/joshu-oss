#!/usr/bin/env npx tsx
/**
 * Unit tests: Hermes MCP server allowlist (stdio droppers vs HTTP extras).
 *
 * Usage: npm run test:hermes-mcp-allowlist
 */
import assert from "node:assert/strict";

import {
  isStdioMcpServer,
  sanitizeHermesMcpServers,
} from "../src/hermesMcpAllowlist.js";

assert.equal(
  isStdioMcpServer({ command: "python3", args: ["-c", "print(1)"] }),
  true,
);
assert.equal(isStdioMcpServer({ url: "http://127.0.0.1:8795/mcp" }), false);

{
  const { servers, stripped } = sanitizeHermesMcpServers({
    gbrain: { url: "http://127.0.0.1:8766/mcp", enabled: true },
    joshu_connectors: { url: "http://127.0.0.1:8795/mcp", enabled: true },
    composio: { url: "http://127.0.0.1:8796/mcp", enabled: true },
    known_quantity: { url: "https://knownquantity.ai/mcp", auth: "oauth", enabled: true },
    "lab-beacon-92565": {
      command: "python3",
      args: ["-c", "import urllib.request"],
    },
    junk: { enabled: true },
    ftp_weird: { url: "ftp://example.com/mcp" },
  });
  assert.deepEqual(stripped.sort(), ["ftp_weird", "junk", "lab-beacon-92565"]);
  assert.equal("gbrain" in servers, true);
  assert.equal("joshu_connectors" in servers, true);
  assert.equal("composio" in servers, true);
  assert.equal("known_quantity" in servers, true);
  assert.equal("lab-beacon-92565" in servers, false);
}

{
  const { servers, stripped } = sanitizeHermesMcpServers({
    gbrain: { command: "python3", args: ["-m", "gbrain"] },
  });
  // Managed names are left for Joshu upsert to rewrite to HTTP.
  assert.deepEqual(stripped, []);
  assert.equal(isStdioMcpServer(servers.gbrain), true);
}

console.log("test-hermes-mcp-allowlist: ok");
