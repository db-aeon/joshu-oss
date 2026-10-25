#!/usr/bin/env node
/**
 * Tests for bootstrap-hermes-learning-skills.sh: the seed key follows the factory skills tree.
 * A stub replaces the LLM merge (merge-hermes-factory-skill.mjs), so no network is used.
 * Usage: node scripts/test-hermes-skills-seed.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, "..");
const bootstrap = join(scriptsDir, "bootstrap-hermes-learning-skills.sh");
const seedKeyScript = join(scriptsDir, "hermes-skills-seed-key.py");

const root = mkdtempSync(join(tmpdir(), "joshu-skills-seed-"));
const appDir = join(root, "app");
const factory = join(appDir, "integrations/hermes/skills");
const hermesHome = join(root, "hermes");
const target = join(hermesHome, "skills/joshu");
const stamp = join(target, ".joshu-seed-version");
const mergeLog = join(root, "merge.log");

const skill = (name, version, body = "Factory body.") =>
  `---\nname: ${name}\nmetadata:\n  hermes:\n    version: "${version}"\n---\n\n${body}\n`;

function writeSkill(base, rel, text) {
  mkdirSync(join(base, rel), { recursive: true });
  writeFileSync(join(base, rel, "SKILL.md"), text);
}

// The stub stands in for `node merge-hermes-factory-skill.mjs`. It logs the box file and
// writes box + factory text, so a test can see that the box evolution stays.
mkdirSync(join(appDir, "scripts"), { recursive: true });
writeFileSync(join(appDir, "scripts/merge-hermes-factory-skill.mjs"), "// stub target\n");
const stub = join(root, "node-stub.sh");
writeFileSync(
  stub,
  `#!/usr/bin/env bash
set -euo pipefail
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --factory) f="$2"; shift 2 ;;
    --box) b="$2"; shift 2 ;;
    --out) o="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "$b" >> "${mergeLog}"
[[ "\${STUB_FAIL:-}" == "1" ]] && exit 1
{ cat "$f"; echo "MERGED-BOX:"; cat "$b"; } > "$o"
`,
);
chmodSync(stub, 0o755);

function run(env = {}) {
  if (existsSync(mergeLog)) rmSync(mergeLog);
  const out = execFileSync("bash", [bootstrap], {
    env: { ...process.env, HERMES_HOME: hermesHome, APP_DIR: appDir, NODE_BIN: stub, ...env },
    encoding: "utf8",
  });
  const merges = existsSync(mergeLog)
    ? readFileSync(mergeLog, "utf8").trim().split("\n").filter(Boolean).map((p) => p.slice(target.length + 1))
    : [];
  return { out, merges, stamp: existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null };
}

const seedKey = (dir) =>
  execFileSync("python3", [seedKeyScript, dir], { encoding: "utf8" })
    .trim()
    .split("\n")
    .find((l) => l.startsWith("*\t"))
    .split("\t")[1];

try {
  writeSkill(factory, "executive-assistant/ea-playbook", skill("ea-playbook", "2.23.0"));
  writeSkill(factory, "mail/joshu-mail", skill("joshu-mail", "1.4.0"));

  // 1. Fresh install copies the factory and stamps the seed key.
  let r = run();
  assert.match(r.out, /fresh install/);
  assert.equal(r.stamp, seedKey(factory));
  assert.ok(existsSync(join(target, "mail/joshu-mail/SKILL.md")));

  // 2. Same factory: up to date, no merge.
  r = run();
  assert.match(r.out, /up to date/);
  assert.deepEqual(r.merges, []);

  // 3. The box evolves ea-playbook. Factory unchanged: no merge, box evolution stays.
  const boxPlaybook = join(target, "executive-assistant/ea-playbook/SKILL.md");
  writeFileSync(boxPlaybook, skill("ea-playbook", "2.23.0", "Factory body.\n\nBox pitfall: owner wants Monday."));
  r = run();
  assert.deepEqual(r.merges, []);
  assert.match(readFileSync(boxPlaybook, "utf8"), /Box pitfall/);

  // 4. A factory SKILL.md version change changes the seed key without a manifest bump.
  const keyBefore = r.stamp;
  writeSkill(factory, "mail/joshu-mail", skill("joshu-mail", "1.5.0", "Factory body. Filter by threadId."));
  assert.notEqual(seedKey(factory), keyBefore, "seed key must change when a factory SKILL.md changes");
  //    Only the changed skill is merged; the box-evolved ea-playbook is not re-merged.
  r = run();
  assert.deepEqual(r.merges, []); // box joshu-mail had no box evolution: factory copy, no LLM merge
  assert.notEqual(r.stamp, keyBefore);
  assert.match(readFileSync(join(target, "mail/joshu-mail/SKILL.md"), "utf8"), /threadId/);
  assert.match(readFileSync(boxPlaybook, "utf8"), /Box pitfall/);

  // 5. Factory changes a box-evolved skill: LLM merge (stub) keeps the box evolution.
  writeSkill(factory, "executive-assistant/ea-playbook", skill("ea-playbook", "2.24.0", "List tracks by threadId."));
  r = run();
  assert.deepEqual(r.merges, ["executive-assistant/ea-playbook/SKILL.md"]);
  const merged = readFileSync(boxPlaybook, "utf8");
  assert.match(merged, /2\.24\.0/);
  assert.match(merged, /Box pitfall/);
  assert.equal(r.stamp, seedKey(factory));

  // 6. A failed merge keeps the box file and the old stamp; the next run retries only that skill.
  writeFileSync(boxPlaybook, merged + "\nMore box notes.\n");
  writeSkill(factory, "executive-assistant/ea-playbook", skill("ea-playbook", "2.25.0", "New step."));
  writeSkill(factory, "realtime/realtime-goal", skill("realtime-goal", "2.0.0"));
  const keyBeforeFail = r.stamp;
  r = run({ STUB_FAIL: "1" });
  assert.deepEqual(r.merges, ["executive-assistant/ea-playbook/SKILL.md"]);
  assert.equal(r.stamp, keyBeforeFail);
  assert.match(readFileSync(boxPlaybook, "utf8"), /More box notes/);
  assert.ok(existsSync(join(target, "realtime/realtime-goal/SKILL.md")), "new skill copied despite failure");
  r = run();
  assert.deepEqual(r.merges, ["executive-assistant/ea-playbook/SKILL.md"]);
  assert.equal(r.stamp, seedKey(factory));

  //    After a merge the box file holds box evolution: the next factory change merges again.
  writeSkill(factory, "executive-assistant/ea-playbook", skill("ea-playbook", "2.26.0", "Newer step."));
  r = run();
  assert.deepEqual(r.merges, ["executive-assistant/ea-playbook/SKILL.md"]);
  assert.match(readFileSync(boxPlaybook, "utf8"), /More box notes/);

  // 7. A box stamped by the old scheme (manifest release, no per-skill state) re-seeds once.
  writeFileSync(stamp, "0.2.6\n");
  rmSync(join(target, ".joshu-seed-skills.tsv"));
  writeFileSync(join(target, "mail/joshu-mail/SKILL.md"), skill("joshu-mail", "1.4.0"));
  r = run();
  assert.ok(r.merges.includes("mail/joshu-mail/SKILL.md"));
  assert.equal(r.stamp, seedKey(factory));

  // 8. The real factory tree yields a seed key.
  assert.match(seedKey(join(repoRoot, "integrations/hermes/skills")), /^sha256:[0-9a-f]{16}$/);

  // 9. One skills seed at a time (flock; Linux only, macOS has no flock).
  if (spawnSync("flock", ["--version"]).status === 0) {
    const lockFile = join(hermesHome, ".joshu-skills-seed.lock");
    const holder = spawn("flock", [lockFile, "sleep", "4"], { stdio: "ignore" });
    try {
      while (spawnSync("flock", ["-n", lockFile, "true"]).status === 0) {
        execFileSync("sleep", ["0.1"]);
      }
      writeSkill(factory, "mail/joshu-mail", skill("joshu-mail", "1.6.0", "Lock test."));
      //    The lock is held past the wait: skip, change nothing.
      r = run({ JOSHU_HERMES_SKILLS_SEED_LOCK_WAIT_SEC: "1" });
      assert.match(r.out, /skip: a different skills seed holds/);
      assert.notEqual(r.stamp, seedKey(factory));
      //    The lock is released during the wait: the run seeds after the other run.
      r = run({ JOSHU_HERMES_SKILLS_SEED_LOCK_WAIT_SEC: "30" });
      assert.equal(r.stamp, seedKey(factory));
      assert.match(readFileSync(join(target, "mail/joshu-mail/SKILL.md"), "utf8"), /Lock test/);
    } finally {
      holder.kill();
    }
  } else {
    console.log("test-hermes-skills-seed: no flock, case 9 skipped");
  }

  console.log("test-hermes-skills-seed: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
