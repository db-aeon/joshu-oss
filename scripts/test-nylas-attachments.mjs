#!/usr/bin/env npx tsx
/**
 * Unit tests: Nylas outbound attachment path resolution.
 *
 * Usage: npm run test:nylas-attachments
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attachmentSummaryNames,
  loadNylasSendAttachments,
  resolveAttachmentPath,
} from "../src/nylas/attachments.js";
import { buildNylasSendSummary } from "../src/actionGuard/gate.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nylas-attach-"));
const desktop = path.join(tmp, "Desktop");
fs.mkdirSync(path.join(desktop, "Projects", "demo"), { recursive: true });
const sample = path.join(desktop, "Projects", "demo", "brief.pptx");
fs.writeFileSync(sample, "fake-pptx");

{
  const resolved = resolveAttachmentPath(desktop, "Projects/demo/brief.pptx");
  assert.equal(resolved, sample);
}

{
  const loaded = loadNylasSendAttachments(["Projects/demo/brief.pptx"], desktop);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].filename, "brief.pptx");
  assert.equal(loaded[0].content.toString(), "fake-pptx");
  assert.match(loaded[0].contentType, /presentation/);
}

{
  assert.throws(() => resolveAttachmentPath(desktop, "/etc/passwd"), /Desktop sandbox/);
}

{
  const names = attachmentSummaryNames([{ path: "Projects/demo/brief.pptx", filename: "Brief.pptx" }]);
  assert.deepEqual(names, ["Brief.pptx"]);
  const summary = buildNylasSendSummary({
    to: "owner@example.com",
    subject: "Deck",
    body: "Attached.",
    attachments: [{ path: "Projects/demo/brief.pptx", filename: "Brief.pptx" }],
  });
  assert.deepEqual(summary.attachments, ["Brief.pptx"]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-nylas-attachments: ok");
