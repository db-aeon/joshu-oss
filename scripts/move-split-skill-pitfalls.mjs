#!/usr/bin/env node
/**
 * Move the box pitfalls of a split skill into the new skill (change mail-worker-skills).
 * bootstrap-hermes-learning-skills.sh runs this script when it first copies a factory skill
 * that names the skill it was split from (metadata.joshu.split_from).
 *
 * Usage: node move-split-skill-pitfalls.mjs --source <box SKILL.md of the old skill> --target <new SKILL.md>
 * Prints "moved <count>". Writes the target only when it moved a box pitfall.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { moveSplitPitfalls } from "./lib/skill-merge-pitfalls.mjs";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? "" : (args[i + 1] ?? "");
};
const source = arg("--source");
const target = arg("--target");
if (!source || !target) {
  console.error("usage: move-split-skill-pitfalls.mjs --source <path> --target <path>");
  process.exit(2);
}

const { text, moved } = moveSplitPitfalls({
  source: readFileSync(source, "utf8"),
  target: readFileSync(target, "utf8"),
});
if (moved.length > 0) writeFileSync(target, `${text.replace(/\s+$/, "")}\n`, "utf8");
process.stdout.write(`moved ${moved.length}\n`);
