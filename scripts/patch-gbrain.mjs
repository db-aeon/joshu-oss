#!/usr/bin/env node
/**
 * Idempotent Joshu patches for gbrain (runs from TS source under bun). Applied
 * at image build and on every gbrain start. Each patch has its own marker;
 * anchors that no longer match (upstream changed) are reported and skipped,
 * never fatal.
 *
 * title-coercion — page titles YAML reads as non-strings crashed import with
 *   "opts.title.toLowerCase is not a function" (core/content-sanity.ts), so the
 *   file never indexed. Trigger: a bare markdown file whose first heading is a
 *   date/number/bool (journals starting "# 2026-09-30").
 *
 * inferred-type-* — frontmatter inference ends its hardcoded folder rules with a
 *   catch-all `type: note` (all of `joshu's files/` lands there), and inferred
 *   frontmatter overrides the active schema pack, so Joshu pack types
 *   (journal, inbox, …) never applied. Leave the type empty instead.
 *
 * Usage: node patch-gbrain.mjs [gbrain package dir]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TAG = "[gbrain-patch]";

const pkgDir =
  process.argv[2] ||
  process.env.GBRAIN_PKG_DIR ||
  path.join(os.homedir(), ".bun", "install", "global", "node_modules", "gbrain");

const PATCHES = [
  {
    marker: "joshu-patch: title-coercion",
    file: "src/core/frontmatter-inference.ts",
    from: [
      "  const needsQuote = /[:\"'#\\[\\]{}|>&*!?,]/.test(fm.title);",
      "  lines.push(`title: ${needsQuote ? JSON.stringify(fm.title) : fm.title}`);",
    ].join("\n"),
    to: [
      '  // joshu-patch: title-coercion: always quote — bare "2026-09-30" / "2026" / "true" parse as non-strings.',
      "  lines.push(`title: ${JSON.stringify(fm.title)}`);",
    ].join("\n"),
  },
  {
    marker: "joshu-patch: title-coercion",
    file: "src/core/markdown.ts",
    from: "  const title = (frontmatter.title as string) || inferTitle(filePath);",
    to: [
      "  // joshu-patch: title-coercion: YAML can hand back Date/number/bool titles; downstream expects a string.",
      "  const rawTitle = frontmatter.title as unknown;",
      "  const title =",
      "    (rawTitle instanceof Date",
      "      ? rawTitle.toISOString().slice(0, 10)",
      "      : rawTitle != null && rawTitle !== ''",
      "        ? String(rawTitle)",
      "        : '') || inferTitle(filePath);",
    ].join("\n"),
  },
  {
    marker: "joshu-patch: inferred-type-catchall",
    file: "src/core/frontmatter-inference.ts",
    from: "  { pathPrefix: '', type: 'note', titleStrategy: 'heading' },",
    to: [
      "  // joshu-patch: inferred-type-catchall: catch-all keeps title/date inference but no type;",
      "  // upstream says this rule is opt-in, yet import applies it and overrides the schema pack.",
      "  { pathPrefix: '', type: '', titleStrategy: 'heading' },",
    ].join("\n"),
  },
  {
    marker: "joshu-patch: inferred-type-fallback",
    file: "src/core/frontmatter-inference.ts",
    from: "    matchedRule = { pathPrefix: '', type: 'note', titleStrategy: 'heading' };",
    to: [
      "    // joshu-patch: inferred-type-fallback: no folder rule → no type, so the schema pack decides.",
      "    matchedRule = { pathPrefix: '', type: '', titleStrategy: 'heading' };",
    ].join("\n"),
  },
  {
    marker: "joshu-patch: inferred-type-line",
    file: "src/core/frontmatter-inference.ts",
    from: "  lines.push(`type: ${fm.type}`);",
    to: [
      "  // joshu-patch: inferred-type-line: omit an empty type (see inferred-type-fallback).",
      "  if (fm.type) lines.push(`type: ${fm.type}`);",
    ].join("\n"),
  },
];

if (!existsSync(path.join(pkgDir, "package.json"))) {
  console.log(`${TAG} skip: gbrain not found at ${pkgDir}`);
  process.exit(0);
}

let changed = 0;
for (const p of PATCHES) {
  const target = path.join(pkgDir, p.file);
  if (!existsSync(target)) {
    console.warn(`${TAG} WARN: ${p.file} missing; skipped ${p.marker}`);
    continue;
  }
  const src = readFileSync(target, "utf8");
  if (src.includes(p.marker)) continue;
  if (!src.includes(p.from)) {
    console.warn(`${TAG} WARN: anchor for ${p.marker} not found in ${p.file} (gbrain changed?); skipped`);
    continue;
  }
  writeFileSync(target, src.replace(p.from, p.to), "utf8");
  changed += 1;
  console.log(`${TAG} applied ${p.marker} → ${p.file}`);
}
if (changed === 0) console.log(`${TAG} already patched or nothing to do (${pkgDir})`);
