#!/usr/bin/env node
/**
 * Write the OSS rendering of each Markdown file under a folder in place (see
 * scripts/lib/doc-blocks.mjs). AGENTS.md and CLAUDE.md are skipped, because they are never
 * exported. Exits 1 and prints each problem with its file and line when a marker breaks a rule.
 *
 *   node scripts/render-oss-manual.mjs <dir>                  # write the OSS rendering
 *   node scripts/render-oss-manual.mjs --check <dir>          # only check the markers
 *   node scripts/render-oss-manual.mjs --grep <regex> <dir>   # also fail on each line of the
 *                                                             # OSS rendering that matches
 *                                                             # (case-insensitive), with its
 *                                                             # source line; writes nothing
 *
 * Used by scripts/prepare-oss-snapshot.sh, scripts/check-oss-boundaries.sh, and
 * scripts/export-public-docs.sh.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { checkMarkers, ossLines, renderOss } from "./lib/doc-blocks.mjs";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const grepAt = args.indexOf("--grep");
const grep = grepAt === -1 ? null : new RegExp(args[grepAt + 1], "i");
const dir = args.find((arg, index) => !arg.startsWith("--") && (grepAt === -1 || index !== grepAt + 1));
if (!dir || (grepAt !== -1 && !args[grepAt + 1])) {
  console.error("usage: node scripts/render-oss-manual.mjs [--check | --grep <regex>] <dir>");
  process.exit(2);
}

function markdownFiles(folder) {
  return readdirSync(folder)
    .sort()
    .flatMap((name) => {
      const file = path.join(folder, name);
      if (statSync(file).isDirectory()) return markdownFiles(file);
      return name.endsWith(".md") && name !== "AGENTS.md" && name !== "CLAUDE.md" ? [file] : [];
    });
}

const problems = [];
for (const file of markdownFiles(dir)) {
  const text = readFileSync(file, "utf8");
  if (checkOnly || grep) {
    const markerProblems = checkMarkers(text, file);
    problems.push(...markerProblems);
    if (grep && !markerProblems.length) {
      for (const { lineNo, line } of ossLines(text, file)) {
        if (grep.test(line)) problems.push(`${file}:${lineNo}: the OSS rendering matches /${grep.source}/: ${line}`);
      }
    }
    continue;
  }
  const rendered = renderOss(text, file);
  problems.push(...rendered.problems);
  if (!rendered.problems.length && rendered.text !== text) writeFileSync(file, rendered.text);
}

if (problems.length) {
  for (const problem of problems) console.error(`[render-oss-manual] ${problem}`);
  process.exit(1);
}
