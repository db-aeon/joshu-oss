#!/usr/bin/env node
/**
 * Refresh integrations/hermes/skills-enabled.yaml from repo skills + essentials.
 * Bundled denylist is computed at gateway sync (not committed to git).
 *
 * Usage: npm run hermes:sync-skills-policy
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const externalSkillsDir = path.join(rootDir, "integrations/hermes/skills");
const hermesDir =
  process.env.HERMES_DIR?.trim() || path.join(process.env.HOME ?? "", "Documents/dev/hermes-agent");
const targetFile = path.join(rootDir, "integrations/hermes/skills-enabled.yaml");

const { computeProductSkillsPolicy, JOSHU_ESSENTIAL_HERMES_SKILLS } = await import(
  pathToFileURL(path.join(rootDir, "dist/hermesSkillsConfig.js")).href
);

const { enabled, disabled, discovered } = await computeProductSkillsPolicy({
  externalSkillsDir,
  hermesAgentRoot: hermesDir,
});

const out = `# Product skill allowlist — merged at gateway sync with bundled essentials below.
# All other Hermes bundled skills are disabled at runtime (computed, not listed here).
# Agent-created skills in ~/.hermes/skills/ are never auto-disabled (Hermes learning loop).
# Optional extras: JOSHU_HERMES_SKILLS_ENABLED=name1,name2
# Regenerate after Hermes pin bump: npm run hermes:sync-skills-policy
# Bundled discovered: ${discovered.length} | Enabled: ${enabled.length} | Computed disabled: ${disabled.length}
enabled:
${enabled.map((n) => `  - ${n}`).join("\n")}
`;

await writeFile(targetFile, out, "utf8");
console.log(`Wrote ${enabled.length} enabled skills to ${targetFile}`);
console.log(`Bundled discovered: ${discovered.length}; computed disabled (not committed): ${disabled.length}`);
console.log(`Essentials: ${[...JOSHU_ESSENTIAL_HERMES_SKILLS].join(", ")}`);
