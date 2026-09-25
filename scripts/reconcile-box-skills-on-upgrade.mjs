#!/usr/bin/env node
/**
 * Reconcile box-evolved Hermes skills after a release upgrade.
 *
 * Removes Camofox-era workarounds that conflict with Browser Use Cloud fleet
 * rules, resets known factory skills from the shipped tree, and drops skills
 * superseded by factory procedures.
 *
 * Usage (on box or with env):
 *   node scripts/reconcile-box-skills-on-upgrade.mjs [--dry-run]
 *
 * Env:
 *   HERMES_HOME          default /root/.hermes
 *   JOSHU_REPO_ROOT      default /opt/joshu
 *   JOSHU_CLOUD_BROWSER  1/true → cloud conflict rules (default: read instance.env)
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
  copyFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const repoRoot = process.env.JOSHU_REPO_ROOT || "/opt/joshu";
const hermesHome = process.env.HERMES_HOME || "/root/.hermes";
const factorySkillsDir = join(repoRoot, "integrations/hermes/skills");
const runtimeJoshuDir = join(hermesHome, "skills/joshu");
const runtimeSkillsDir = join(hermesHome, "skills");

function log(msg) {
  console.log(`[skill-reconcile] ${msg}`);
}

function parseCloudBrowserEnabled() {
  const envFlag = (process.env.JOSHU_CLOUD_BROWSER || "").trim();
  if (envFlag) return /^(1|true|yes)$/i.test(envFlag);
  try {
    const instanceEnv = readFileSync("/etc/joshu/instance.env", "utf8");
    const m = instanceEnv.match(/^JOSHU_CLOUD_BROWSER=(.+)$/m);
    if (m) return /^(1|true|yes)$/i.test(m[1].trim());
  } catch {
    // local dev / dry-run without instance.env
  }
  return false;
}

const cloudBrowser = parseCloudBrowserEnabled();

/** Sections or lines evolved during failed runs — strip from any SKILL.md. */
const STRIP_PATTERNS = [
  /## Staging the tab \(when `browser_navigate` isn't on Camofox\)[\s\S]*?(?=\n## |\n---\n|$)/gi,
  /## Staging the tab[\s\S]*?127\.0\.0\.1:9377[\s\S]*?(?=\n## |\n---\n|$)/gi,
  /\| `no_active_browser_tab` \|[^\n]*Camofox[^\n]*\n/gi,
  /^.*curl -s -X POST http:\/\/127\.0\.0\.1:9377\/tabs.*\n/gm,
  /^.*POST http:\/\/127\.0\.0\.1:9377\/start.*\n/gm,
  /^.*hitl-camofox.*workaround.*\n/gim,
  /^.*Open the page \*in Camofox\* first.*\n/gim,
  /^.*When handoff fails, use Camofox.*\n/gim,
  /^.*browser_task.*after `no_active_browser_tab`.*\n/gim,
  // Pre-2026-09-24 realtime-goal: hotel-specific "BOOK THIS" booking phase. The
  // broker now appends a task-neutral "Owner answer" section instead.
  /### Booking phase \(after owner picks from a blocked list\)[\s\S]*?(?=\n\d+\. |\n## |\n### |\n---\n|$)/gi,
  /^.*Owner selection — BOOK THIS.*\n/gm,
];

/** Factory-relative paths — on cloud upgrade, replace box copy entirely (no LLM merge). */
const RESET_FROM_FACTORY_ON_CLOUD = [
  "browser/joshu-browser-handoff/SKILL.md",
];

/**
 * Box-only skills whose procedures now live in factory skills.
 * Removed on reconcile; logged for operator audit.
 */
const SUPERSEDED_SKILLS = [
  {
    dir: "joshu-travel-booking",
    reason: "Blocked-answer rules live in factory `realtime-goal` (Owner answer section).",
  },
];

function walkSkillFiles(rootDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === "SKILL.md") out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function stripConflicts(text) {
  let next = text;
  for (const re of STRIP_PATTERNS) {
    next = next.replace(re, "");
  }
  // Collapse excessive blank lines left by removals
  next = next.replace(/\n{4,}/g, "\n\n\n");
  return next.trimEnd() + "\n";
}

function relFromJoshuSkills(absPath) {
  if (absPath.startsWith(runtimeJoshuDir + "/")) {
    return relative(runtimeJoshuDir, absPath);
  }
  return null;
}

function reconcileSkillFile(absPath) {
  const rel = relFromJoshuSkills(absPath);
  const original = readFileSync(absPath, "utf8");
  let updated = stripConflicts(original);

  if (cloudBrowser && rel && RESET_FROM_FACTORY_ON_CLOUD.includes(rel)) {
    const factoryPath = join(factorySkillsDir, rel);
    try {
      updated = readFileSync(factoryPath, "utf8");
      return { action: "reset-from-factory", rel, before: original, after: updated };
    } catch {
      log(`WARN: factory missing ${rel} — strip-only`);
    }
  }

  if (updated === original) return null;
  return { action: "strip-conflicts", rel: rel || absPath, before: original, after: updated };
}

function removeSupersededSkill(skillDirName) {
  const candidates = [
    join(runtimeJoshuDir, skillDirName),
    join(runtimeSkillsDir, skillDirName),
  ];
  for (const dir of candidates) {
    try {
      statSync(dir);
      if (dryRun) {
        log(`dry-run: would remove superseded skill ${dir}`);
      } else {
        rmSync(dir, { recursive: true, force: true });
        log(`removed superseded skill ${dir}`);
      }
      return true;
    } catch {
      // not present
    }
  }
  return false;
}

function main() {
  log(`cloudBrowser=${cloudBrowser} dryRun=${dryRun}`);
  log(`runtime joshu skills: ${runtimeJoshuDir}`);

  const skillFiles = [
    ...walkSkillFiles(runtimeJoshuDir),
    ...walkSkillFiles(runtimeSkillsDir).filter((p) => !p.startsWith(runtimeJoshuDir)),
  ];

  let changed = 0;
  for (const file of skillFiles) {
    const result = reconcileSkillFile(file);
    if (!result) continue;
    changed++;
    if (dryRun) {
      log(`dry-run: ${result.action} ${result.rel}`);
    } else {
      writeFileSync(file, result.after, "utf8");
      log(`${result.action} ${result.rel}`);
    }
  }

  for (const { dir, reason } of SUPERSEDED_SKILLS) {
    if (removeSupersededSkill(dir)) {
      log(`superseded: ${dir} — ${reason}`);
    }
  }

  // Ensure factory handoff is present after reset (copy if runtime tree missing file)
  if (cloudBrowser && !dryRun) {
    for (const rel of RESET_FROM_FACTORY_ON_CLOUD) {
      const factoryPath = join(factorySkillsDir, rel);
      const runtimePath = join(runtimeJoshuDir, rel);
      try {
        readFileSync(factoryPath, "utf8");
        mkdirSync(dirname(runtimePath), { recursive: true });
        if (!existsSync(runtimePath)) {
          copyFileSync(factoryPath, runtimePath);
          log(`copied missing factory skill ${rel}`);
        }
      } catch {
        // factory path missing in dev checkout
      }
    }
  }

  log(`done — ${changed} skill file(s) ${dryRun ? "would change" : "updated"}`);
}

main();
