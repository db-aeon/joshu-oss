#!/usr/bin/env node
/**
 * Regression: agent skills under $HERMES_HOME/skills/ must never land in skills.disabled.
 * Policy only scans bundled + product dirs, not the writable Hermes home tree.
 *
 * Usage: npm run test:hermes-skills-policy
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { computeProductSkillsPolicy, resolveHermesAgentRoot } = await import(
  pathToFileURL(path.join(rootDir, "dist/hermesSkillsConfig.js")).href
);

const externalSkillsDir = path.join(rootDir, "integrations/hermes/skills");
const hermesAgentRoot =
  resolveHermesAgentRoot() ||
  process.env.HERMES_DIR?.trim() ||
  path.join(process.env.HOME ?? "", "Documents/dev/hermes-agent");

const policy = await computeProductSkillsPolicy({ externalSkillsDir, hermesAgentRoot });
const disabledSet = new Set(policy.disabled);

if (!hermesAgentRoot || policy.disabled.length < 50) {
  console.error(
    `FAIL: expected ~150+ bundled disabled skills; got ${policy.disabled.length} (hermes root: ${hermesAgentRoot ?? "unset"})`,
  );
  process.exit(1);
}

// HERMES_BIN under venv/bin must resolve to repo root with skills/ (local dev + Docker parity).
if (process.env.HERMES_BIN?.includes("venv/bin/hermes")) {
  const root = resolveHermesAgentRoot();
  if (!root || !root.includes("hermes-agent") || root.endsWith("/venv")) {
    console.error(`FAIL: resolveHermesAgentRoot from HERMES_BIN returned ${root ?? "null"}`);
    process.exit(1);
  }
}

// Product enabled skills must never be disabled.
for (const name of policy.enabled) {
  if (disabledSet.has(name)) {
    console.error(`FAIL: enabled skill "${name}" also appears in disabled list`);
    process.exit(1);
  }
}

// Writable agent home is outside policy scan — simulate an evolved skill there.
const agentHome = await mkdtemp(path.join(tmpdir(), "joshu-agent-skills-"));
const agentSkillDir = path.join(agentHome, "skills", "evolved-test-skill");
try {
  await mkdir(agentSkillDir, { recursive: true });
  await writeFile(
    path.join(agentSkillDir, "SKILL.md"),
    "---\nname: evolved-test-skill\n---\n# Evolved\n",
    "utf8",
  );

  const agentPolicy = await computeProductSkillsPolicy({ externalSkillsDir, hermesAgentRoot });
  if (agentPolicy.disabled.includes("evolved-test-skill")) {
    console.error("FAIL: agent skill evolved-test-skill was auto-disabled by policy scan");
    process.exit(1);
  }
} finally {
  await rm(agentHome, { recursive: true, force: true });
}

console.log(
  `OK: ${policy.enabled.length} enabled, ${policy.disabled.length} bundled disabled; agent skills not scanned`,
);
