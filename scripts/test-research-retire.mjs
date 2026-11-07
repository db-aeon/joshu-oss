/**
 * Test of the boot cleanup that removes the last30days app from a box (change research-reports,
 * task 8.3). Runs twice on a temporary tree with each leftover and the owner files.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retireLast30daysCronJobs, retireLast30daysFiles } from "../src/research/retireLast30days.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-retire-"));
const hermesHome = path.join(root, "hermes");
const arozData = path.join(root, "aroz");
const user = "owner@example.com";
const userRoot = path.join(arozData, "files", "users", user);
const registry = path.join(userRoot, ".joshu", "app-skills.json");
const paths = { hermesHome, arozData, appSkillsRegistryPath: registry };

function write(p, text = "x\n") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

try {
  const leftovers = [
    path.join(hermesHome, "scripts", "last30days-watchlist-run.sh"),
    path.join(hermesHome, "scripts", "last30days-watchlist-weekly.sh"),
    path.join(hermesHome, "skills", "apps", "last30days", "last30days-chat", "SKILL.md"),
    path.join(hermesHome, "skills", "joshu", "last30days-chat", "SKILL.md"),
    path.join(hermesHome, "skills", "joshu", "last30days-gui", "SKILL.md"),
    path.join(hermesHome, "plugins", "joshu-last30days", "plugin.yaml"),
    path.join(arozData, "subservice", "last30days", "joshu.app.json"),
    path.join(arozData, "system", "desktop", "template", "last30days.shortcut"),
    path.join(userRoot, "Desktop", "last30days.shortcut"),
  ];
  for (const p of leftovers) write(p);
  const kept = [
    path.join(hermesHome, "scripts", "ea-morning.sh"),
    path.join(hermesHome, "plugins", "joshu-research", "plugin.yaml"),
    path.join(hermesHome, "skills", "joshu", "jmail-gui", "SKILL.md"),
    path.join(arozData, "subservice", "jmail", "joshu.app.json"),
    path.join(userRoot, "Desktop", "jMail.shortcut"),
    path.join(userRoot, "Desktop", "joshu's files", "research", "last30days", "2026-09-01-openai.md"),
    path.join(userRoot, ".joshu", "last30days", "share", "research.db"),
    path.join(userRoot, ".joshu", "last30days", "watch-snapshots.json"),
  ];
  for (const p of kept) write(p, "keep\n");
  write(registry, `${JSON.stringify({ skills: ["jmail-gui", "last30days-chat", "last30days-gui"] })}\n`);

  const first = retireLast30daysFiles(paths);
  for (const p of leftovers) assert.ok(!fs.existsSync(p), `removed: ${p}`);
  assert.ok(!fs.existsSync(path.join(hermesHome, "skills", "apps", "last30days")));
  assert.ok(!fs.existsSync(path.join(arozData, "subservice", "last30days")));
  for (const p of kept) assert.equal(fs.readFileSync(p, "utf8"), "keep\n", `kept unchanged: ${p}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(registry, "utf8")).skills, ["jmail-gui"]);
  assert.ok(first.length >= 9);
  assert.deepEqual(retireLast30daysFiles(paths), [], "a second run changes nothing");
  console.log("ok last30days files removed, owner files kept, second run changes nothing");

  const jobs = [
    { job_id: "a", name: "last30days: watchlist daily" },
    { job_id: "b", name: "last30days: watchlist weekly" },
    { job_id: "c", name: "EA morning review" },
  ];
  const removedIds = [];
  const bridge = async (payload) => {
    if (payload.action === "list") return { success: true, jobs: jobs.filter((j) => !removedIds.includes(j.job_id)) };
    if (payload.action === "remove") removedIds.push(payload.job_id);
    return { success: true };
  };
  assert.deepEqual(await retireLast30daysCronJobs(bridge), ["last30days: watchlist daily", "last30days: watchlist weekly"]);
  assert.deepEqual(removedIds, ["a", "b"], "only the two watch jobs");
  assert.deepEqual(await retireLast30daysCronJobs(bridge), [], "a second run removes nothing");
  console.log("ok last30days watch cron jobs removed by name");
  console.log("all research retire checks passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
