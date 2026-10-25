#!/usr/bin/env npx tsx
/**
 * Unit tests: HERMES.md tells the agent to keep scratch scripts off the owner's Desktop
 * (Hermes terminal.cwd is the ArozOS Desktop, so files written there show to the owner),
 * and HERMES_WRITE_SAFE_ROOT lets write_file save them in the scratch folder.
 *
 * Usage: npm run test:hermes-context-file
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { buildHermesContextMarkdown } from "../src/hermesContextFile.js";
import { HERMES_SCRATCH_DIR, resolveJoshuHermesWorkspaceScope } from "../src/joshuFilesPaths.js";

test("HERMES.md keeps scratch scripts off the Desktop", () => {
  const md = buildHermesContextMarkdown({ ownerName: "Maya", assistantName: "Mina" });
  assert.match(md, /## Scratch files/);
  assert.match(md, /\/tmp\/joshu-scratch\//);
  assert.match(md, /execute_code/);
  assert.ok(md.indexOf("## Scratch files") < md.indexOf("## Operating rules"));
});

test("HERMES.md tells the companion to report box problems", () => {
  const md = buildHermesContextMarkdown({ ownerName: "Maya", assistantName: "Mina" });
  const start = md.indexOf("## Box problems");
  assert.ok(start > md.indexOf("## Scratch files") && start < md.indexOf("## Operating rules"));
  const section = md.slice(start, md.indexOf("## Operating rules"));
  assert.match(section, /\/opt\/hermes-agent/);
  assert.match(section, /config\.user\.yaml/);
  assert.match(section, /Joshu team fixes box problems/);
  assert.match(section, /`system:`/);
  assert.match(section, /memory entry or a skill that tells how to get around a guard/);
});

test("default write safe root holds the Desktop and the scratch folder", () => {
  const prev = process.env.JOSHU_HERMES_WRITE_SAFE_ROOT;
  delete process.env.JOSHU_HERMES_WRITE_SAFE_ROOT;
  try {
    const scope = resolveJoshuHermesWorkspaceScope({ desktopRoot: "/data/users/maya/Desktop" });
    assert.equal(scope.writeSafeRoot, `/data/users/maya/Desktop${path.delimiter}${HERMES_SCRATCH_DIR}`);
    assert.equal(scope.terminalCwd, "/data/users/maya/Desktop");

    process.env.JOSHU_HERMES_WRITE_SAFE_ROOT = "/custom/path";
    assert.equal(resolveJoshuHermesWorkspaceScope({ desktopRoot: "/data/users/maya/Desktop" }).writeSafeRoot, "/custom/path");
  } finally {
    if (prev === undefined) delete process.env.JOSHU_HERMES_WRITE_SAFE_ROOT;
    else process.env.JOSHU_HERMES_WRITE_SAFE_ROOT = prev;
  }
});

test("HERMES.md names the same scratch folder as the write safe root", () => {
  const md = buildHermesContextMarkdown({ ownerName: "Maya", assistantName: "Mina" });
  assert.ok(md.includes(`${HERMES_SCRATCH_DIR}/`));
});
