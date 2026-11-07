#!/usr/bin/env node
/**
 * Unit tests: block markers and the OSS rendering of the user's manual
 * (openspec change export-public-docs, spec public-docs-export). The last tests read the real
 * docs/user-manual/: valid markers, no joshu.me in the OSS rendering, and no *.oss.md twin.
 *
 * Usage: npm run test:doc-blocks
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkMarkers, ossLines, renderOss } from "./lib/doc-blocks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lines = (...parts) => `${parts.join("\n")}\n`;

// Marker rules.
assert.match(
  checkMarkers(lines("<!-- self-host -->", "a", "<!-- hosted-only -->", "b", "<!-- /self-host -->"), "c.md")[0],
  /^c\.md:3: .*cannot be nested/,
);
assert.match(checkMarkers(lines("Text <!-- self-host -->"), "c.md")[0], /^c\.md:1: .*own line/);
assert.match(checkMarkers(lines("<!-- hosted-only -->", "a"), "c.md")[0], /^c\.md:1: .*never closed/);
assert.match(
  checkMarkers(lines("<!-- hosted-only -->", "a", "<!-- /self-host -->"), "c.md")[0],
  /^c\.md:3: .*does not match/,
);
assert.match(checkMarkers(lines("<!-- /self-host -->"), "c.md")[0], /never opened/);
assert.deepEqual(checkMarkers(lines("  <!-- self-host -->  ", "a", "<!--/self-host-->")), []);

// Markers inside a fenced code block are text.
const fenced = lines("Example:", "", "```markdown", "<!-- self-host -->", "Only marker text.", "```", "");
assert.deepEqual(checkMarkers(fenced), []);
assert.equal(renderOss(fenced).text, fenced);

// A tab pair with one blank line between the blocks.
assert.equal(
  renderOss(
    lines(
      "# Title",
      "",
      "<!-- hosted-only -->",
      "Hosted text.",
      "<!-- /hosted-only -->",
      "",
      "<!-- self-host -->",
      "Self-host text.",
      "<!-- /self-host -->",
      "",
      "Shared text.",
    ),
  ).text,
  lines("# Title", "", "Self-host text.", "", "Shared text."),
);

// ossLines() keeps the source line numbers of the lines that the OSS rendering keeps.
assert.deepEqual(
  ossLines(lines("A", "<!-- hosted-only -->", "hello.joshu.me", "<!-- /hosted-only -->", "<!-- self-host -->", "B", "<!-- /self-host -->")),
  [
    { lineNo: 1, line: "A" },
    { lineNo: 6, line: "B" },
    { lineNo: 8, line: "" },
  ],
);

// A hosted-only block at the start and at the end of a text.
assert.equal(
  renderOss(lines("<!-- hosted-only -->", "Hosted.", "<!-- /hosted-only -->", "", "# Title", "", "Text.")).text,
  lines("# Title", "", "Text."),
);
assert.equal(
  renderOss(lines("# Title", "", "Text.", "", "<!-- hosted-only -->", "Hosted.", "<!-- /hosted-only -->")).text,
  lines("# Title", "", "Text."),
);

// A hosted-only block between two lines of one list.
assert.equal(
  renderOss(lines("- one", "<!-- hosted-only -->", "- hosted", "<!-- /hosted-only -->", "- two")).text,
  lines("- one", "- two"),
);

// Two blank lines in the source, away from a block, stay.
const doubleBlank = lines("A", "", "", "B", "", "<!-- self-host -->", "C", "<!-- /self-host -->");
assert.equal(renderOss(doubleBlank).text, lines("A", "", "", "B", "", "C"));

// A text without markers keeps the same bytes, also without a final newline.
for (const text of [lines("# Title", "", "", "Text.  "), "No newline at the end"]) {
  assert.equal(renderOss(text).text, text);
}

// A text with a marker problem is not rendered.
const broken = renderOss(lines("<!-- self-host -->", "a"), "b.md");
assert.equal(broken.problems.length, 1);

// The real user's manual.
const manualDir = path.join(root, "docs", "user-manual");
const names = readdirSync(manualDir);
assert.deepEqual(
  names.filter((name) => name.endsWith(".oss.md")),
  [],
  "docs/user-manual/ must have no *.oss.md twin; put the self-host text in self-host blocks",
);
// AGENTS.md is not exported, so its text may name joshu.me.
for (const name of names.filter((n) => n.endsWith(".md") && n !== "AGENTS.md")) {
  const file = `docs/user-manual/${name}`;
  const { text, problems } = renderOss(readFileSync(path.join(manualDir, name), "utf8"), file);
  assert.deepEqual(problems, [], `marker problems in ${file}`);
  text.split("\n").forEach((line, index) => {
    assert.ok(!/joshu\.me/i.test(line), `${file}: line ${index + 1} of the OSS rendering contains joshu.me`);
  });
}

console.log("doc-blocks tests passed");
