/**
 * Release facts: after an upgrade, check Hermes memory and the box-made skills against the facts
 * that the new releases changed, so that a note about an old tool limit does not outlive the fix.
 * Spec: openspec/changes/release-facts-memory-check/specs/release-facts/spec.md
 */
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { callCronBridge, type CronBridgeJobSummary } from "./hermesCronBridge.js";
import { isVersionAtLeast, parseVersionParts, readBoxReleaseVersion } from "./onboarding/promptRegistry.js";

export type ReleaseFact = {
  id: string;
  introducedIn: string;
  fact: string;
  wasBelieved: string;
};

export const RELEASE_FACTS_JOB_PREFIX = "Joshu release facts check";
/** Hermes one-time schedule: run once, this long after the Joshu API starts (the gateway is up by then). */
export const RELEASE_FACTS_JOB_DELAY = "15m";
const STAMP_FILE = ".joshu-release-facts-checked";

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function parseReleaseFacts(raw: string): ReleaseFact[] {
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  if (!Array.isArray(parsed.facts)) return [];
  return parsed.facts.flatMap((row): ReleaseFact[] => {
    const r = (row ?? {}) as Record<string, unknown>;
    const fact = { id: text(r.id), introducedIn: text(r.introducedIn), fact: text(r.fact), wasBelieved: text(r.wasBelieved) };
    return fact.id && fact.introducedIn && fact.fact && fact.wasBelieved ? [fact] : [];
  });
}

export function loadReleaseFacts(projectRoot = process.cwd()): ReleaseFact[] {
  const file = path.join(projectRoot, "factory", "release-facts.yaml");
  if (!fs.existsSync(file)) return [];
  return parseReleaseFacts(fs.readFileSync(file, "utf8"));
}

/** A real release version; the dev sentinel 0.0.0-dev has no release facts. */
function isReleaseVersion(version: string): boolean {
  return parseVersionParts(version).some((n) => n > 0);
}

/**
 * The facts that the box has not checked: introduced at or before the current release, and after
 * the release that the box checked last. A box that never checked gets every fact up to the current release.
 */
export function selectFactsToCheck(facts: ReleaseFact[], lastChecked: string | null, current: string): ReleaseFact[] {
  if (!isReleaseVersion(current)) return [];
  return facts.filter(
    (f) =>
      isVersionAtLeast(current, f.introducedIn) &&
      (lastChecked === null || !isVersionAtLeast(lastChecked, f.introducedIn)),
  );
}

export function releaseFactsJobName(version: string): string {
  return `${RELEASE_FACTS_JOB_PREFIX} ${version}`;
}

/** The prompt of the one-time Hermes job. The companion judges which notes the facts make untrue. */
export function buildReleaseFactsPrompt(facts: ReleaseFact[], version: string, home = hermesHome()): string {
  const memories = path.join(home, "memories");
  const skills = path.join(home, "skills");
  const factLines = facts.flatMap((f, i) => [
    `${i + 1}. Fact (since release ${f.introducedIn}): ${f.fact}`,
    `   Old belief that is now untrue: ${f.wasBelieved}`,
  ]);
  return [
    `Joshu release ${version} is now on this box. The releases since the last check changed these facts about Joshu tools:`,
    "",
    ...factLines,
    "",
    "Find and fix notes that these facts make untrue. Do not change anything else.",
    "",
    `1. Hermes memory: read ${path.join(memories, "MEMORY.md")} and ${path.join(memories, "USER.md")} with read_file. Entries are separated by a line with only "§". For each entry that states an old belief above, or a workaround that rests on it (for example "use the browser"), remove the entry or rewrite it so that it agrees with the fact. Keep the "§" separators and every other entry exactly as they are. Edit with patch; do not rewrite a whole file.`,
    `2. Box-made skills: search the SKILL.md files and the references/ files under ${skills} with search_files, but skip ${path.join(skills, "joshu")} (factory skills; Joshu updates them). For each box-made skill that states an old belief or rests on it, change the wrong part with skill_manage action patch. Delete a box-made skill with skill_manage action delete only when its whole purpose is a workaround that a fact makes unnecessary.`,
    "3. When a note is about the same topic but does not contradict a fact, leave it.",
    "4. End with a short list: each entry or skill that you changed or deleted, and why. If nothing needed a change, say so.",
  ].join("\n");
}

function readStamp(home: string): string | null {
  try {
    return fs.readFileSync(path.join(home, STAMP_FILE), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeStamp(home: string, version: string): void {
  fs.writeFileSync(path.join(home, STAMP_FILE), `${version}\n`);
}

export type ReleaseFactsCheckResult =
  | { action: "none"; version: string }
  | { action: "scheduled" | "already_scheduled"; version: string; factIds: string[] };

/**
 * Once per release: when facts are new to this box, add a one-time Hermes job that checks memory and
 * the box-made skills. The stamp moves to the current release only after the job exists, so a failed
 * create is tried again at the next start.
 */
export async function scheduleReleaseFactsCheck(
  projectRoot = process.cwd(),
  deps: { cron?: typeof callCronBridge; version?: string; home?: string } = {},
): Promise<ReleaseFactsCheckResult> {
  const cron = deps.cron ?? callCronBridge;
  const home = deps.home ?? hermesHome();
  const version = deps.version ?? (await readBoxReleaseVersion(projectRoot));
  const lastChecked = readStamp(home);
  if (lastChecked === version) return { action: "none", version };

  const facts = selectFactsToCheck(loadReleaseFacts(projectRoot), lastChecked, version);
  if (facts.length === 0) {
    if (isReleaseVersion(version)) writeStamp(home, version);
    return { action: "none", version };
  }

  const name = releaseFactsJobName(version);
  const factIds = facts.map((f) => f.id);
  const list = await cron({ action: "list", include_disabled: true });
  if (!list.success) throw new Error(typeof list.error === "string" ? list.error : "cron list failed");
  const jobs: CronBridgeJobSummary[] = Array.isArray(list.jobs) ? list.jobs : [];
  if (jobs.some((j) => j.name === name)) {
    writeStamp(home, version);
    return { action: "already_scheduled", version, factIds };
  }

  const created = await cron({
    action: "create",
    name,
    schedule: RELEASE_FACTS_JOB_DELAY,
    repeat: 1,
    prompt: buildReleaseFactsPrompt(facts, version, home),
    deliver: "local",
    enabled_toolsets: ["file", "skills"],
  });
  if (!created.success) throw new Error(typeof created.error === "string" ? created.error : "cron create failed");
  writeStamp(home, version);
  return { action: "scheduled", version, factIds };
}

/** Boot hook: log and keep going on failure (the next start tries again). */
export async function tryScheduleReleaseFactsCheck(projectRoot = process.cwd()): Promise<void> {
  try {
    const result = await scheduleReleaseFactsCheck(projectRoot);
    if (result.action !== "none") {
      console.log(`[release-facts] ${result.action} for ${result.version}: ${result.factIds.join(", ")}`);
    }
  } catch (err) {
    console.warn(`[release-facts] check not scheduled: ${(err as Error).message}`);
  }
}
