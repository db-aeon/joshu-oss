#!/usr/bin/env node
/**
 * Unit tests for reconcile-box-skills-on-upgrade strip/reset logic.
 * Usage: node scripts/test-reconcile-box-skills.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "joshu-skill-reconcile-"));
const hermesHome = join(root, "hermes");
const repoRoot = join(root, "joshu");
const runtimeDir = join(hermesHome, "skills/joshu/browser/joshu-browser-handoff");
const factoryDir = join(repoRoot, "integrations/hermes/skills/browser/joshu-browser-handoff");

mkdirSync(runtimeDir, { recursive: true });
mkdirSync(factoryDir, { recursive: true });

const factorySkill = `---
name: joshu-browser-handoff
description: factory
metadata:
  hermes:
    version: "1.7.0"
---

# Factory handoff
Use browser_navigate on cloud.
`;

const pollutedBoxSkill = `---
name: joshu-browser-handoff
description: box
metadata:
  hermes:
    version: "1.6.0"
---

# Box handoff

## Staging the tab (when \`browser_navigate\` isn't on Camofox)

curl -s -X POST http://127.0.0.1:9377/tabs ...

| \`no_active_browser_tab\` | Open the page *in Camofox* first |
`;

writeFileSync(join(factoryDir, "SKILL.md"), factorySkill, "utf8");
writeFileSync(join(runtimeDir, "SKILL.md"), pollutedBoxSkill, "utf8");

const script = join(process.cwd(), "scripts/reconcile-box-skills-on-upgrade.mjs");
execFileSync(process.execPath, [script], {
  env: {
    ...process.env,
    HERMES_HOME: hermesHome,
    JOSHU_REPO_ROOT: repoRoot,
    JOSHU_CLOUD_BROWSER: "1",
  },
  stdio: "pipe",
});

const after = readFileSync(join(runtimeDir, "SKILL.md"), "utf8");
if (!after.includes("Use browser_navigate on cloud")) {
  console.error("FAIL: expected factory reset on cloud box");
  process.exit(1);
}
if (after.includes("9377") || after.includes("Staging the tab")) {
  console.error("FAIL: Camofox conflict section still present");
  process.exit(1);
}

// Strip-only on non-reset skill
const miscDir = join(hermesHome, "skills/joshu/owner-account-subscription-review");
mkdirSync(miscDir, { recursive: true });
writeFileSync(
  join(miscDir, "SKILL.md"),
  "# Review\n\nGood line.\n\n## Staging the tab (when `browser_navigate` isn't on Camofox)\n\nBad curl http://127.0.0.1:9377/tabs\n\n## Done\n",
  "utf8",
);

execFileSync(process.execPath, [script], {
  env: {
    ...process.env,
    HERMES_HOME: hermesHome,
    JOSHU_REPO_ROOT: repoRoot,
    JOSHU_CLOUD_BROWSER: "1",
  },
  stdio: "pipe",
});

const miscAfter = readFileSync(join(miscDir, "SKILL.md"), "utf8");
if (miscAfter.includes("9377") || miscAfter.includes("Staging the tab")) {
  console.error("FAIL: strip patterns did not remove Camofox section from misc skill");
  process.exit(1);
}
if (!miscAfter.includes("Good line")) {
  console.error("FAIL: strip removed too much from misc skill");
  process.exit(1);
}

rmSync(root, { recursive: true, force: true });
console.log("test-reconcile-box-skills — all passed");
