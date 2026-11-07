#!/usr/bin/env node
/**
 * Tests for bootstrap-hermes-learning-skills.sh: the seed key follows the factory skills tree.
 * A stub replaces the LLM merge (merge-hermes-factory-skill.mjs), so no network is used.
 * Usage: node scripts/test-hermes-skills-seed.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// The real script that moves the box pitfalls of a split skill (change mail-worker-skills).
mkdirSync(join(appDir, "scripts/lib"), { recursive: true });
for (const rel of ["move-split-skill-pitfalls.mjs", "lib/skill-merge-pitfalls.mjs"]) {
  copyFileSync(join(scriptsDir, rel), join(appDir, "scripts", rel));
}
const stub = join(root, "node-stub.sh");
writeFileSync(
  stub,
  `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == *move-split-skill-pitfalls.mjs ]]; then exec node "$@"; fi
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

  // 10. Split skill (change mail-worker-skills): a new factory skill names the skill it was
  //     split from. The seed moves the box pitfalls of the moved sections into the new skill,
  //     before the merge of the old skill, and later factory updates merge the new skill.
  const P_INGRESS = "**Pitfall — the stub path has the account key** (observed 2026-10-20): open the stub by path.";
  const P_SUMMARY = "**Pitfall — old unread Nylas threads** (observed 2026-10-21): skip sent artifacts.";
  writeFileSync(
    boxPlaybook,
    skill("ea-playbook", "2.26.0", `## Mail ingress\n\n1. File.\n\n${P_INGRESS}\n\n## Summary email\n\n${P_SUMMARY}`),
  );
  const splitFront = (name, version, body) =>
    `---\nname: ${name}\nmetadata:\n  hermes:\n    version: "${version}"\n  joshu:\n    split_from: ea-playbook\n---\n\n${body}\n`;
  writeSkill(factory, "executive-assistant/ea-mail-ingress", splitFront("ea-mail-ingress", "1.0.0", "## Mail ingress\n\n1. File."));
  writeSkill(factory, "executive-assistant/ea-playbook", skill("ea-playbook", "3.0.0", "## Summary email\n\nSend it."));
  r = run();
  const boxIngress = join(target, "executive-assistant/ea-mail-ingress/SKILL.md");
  const ingressText = readFileSync(boxIngress, "utf8");
  assert.ok(ingressText.includes(P_INGRESS), "box pitfall of a moved section moves to the new skill");
  assert.ok(!ingressText.includes(P_SUMMARY), "box pitfall of a section that stays does not move");
  assert.match(ingressText, /## Pitfalls kept from this box/);
  assert.match(r.out, /moved 1 box pitfall\(s\) into executive-assistant\/ea-mail-ingress/);
  const ingressState = readFileSync(join(target, ".joshu-seed-skills.tsv"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("executive-assistant/ea-mail-ingress\t"));
  assert.equal(ingressState.split("\t")[2], "merged", "a new skill with moved box pitfalls counts as box-evolved");
  writeSkill(factory, "executive-assistant/ea-mail-ingress", splitFront("ea-mail-ingress", "1.1.0", "## Mail ingress\n\n1. File now."));
  r = run();
  assert.deepEqual(r.merges, ["executive-assistant/ea-mail-ingress/SKILL.md"], "the next factory update merges the new skill");
  //     A box without the old skill gets the plain factory copy of a new split skill.
  writeSkill(factory, "executive-assistant/ea-mail-track", splitFront("ea-mail-track", "1.0.0", "## Project reconcile\n\nReconcile."));
  rmSync(join(target, "executive-assistant/ea-playbook"), { recursive: true });
  r = run();
  assert.equal(
    readFileSync(join(target, "executive-assistant/ea-mail-track/SKILL.md"), "utf8"),
    readFileSync(join(factory, "executive-assistant/ea-mail-track/SKILL.md"), "utf8"),
  );

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
