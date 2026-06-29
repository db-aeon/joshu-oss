import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function projectRoot(): string {
  return process.cwd();
}

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || path.join(process.env.HOME || "/root", ".hermes");
}

/** Resolve bundled scripts under scripts/ only (AGPL tree). */
function resolveScript(relativeScript: string): string | null {
  const scriptPath = path.join(projectRoot(), relativeScript);
  return fs.existsSync(scriptPath) ? scriptPath : null;
}

async function runBashScript(
  relativeScript: string,
  extraEnv?: Record<string, string>,
): Promise<void> {
  const scriptPath = resolveScript(relativeScript);
  if (!scriptPath) {
    console.log(`[hermes-learning] skip missing script: ${relativeScript}`);
    return;
  }
  const root = projectRoot();
  const env = {
    ...process.env,
    HERMES_HOME: hermesHome(),
    APP_DIR: root,
    JOSHU_REPO_ROOT: root,
    ...extraEnv,
  };
  const timeoutMs =
    extraEnv?.JOSHU_HERMES_SKILLS_SEED_MODE === "overwrite" ? 120_000 : 600_000;
  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath], {
      env,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const out = (stdout || stderr).trim();
    if (out) console.log(out);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    console.warn(`[hermes-learning] ${relativeScript} failed: ${e.stderr?.trim() || e.message}`);
  }
}

/** Seed writable Hermes skills from factory (merge or overwrite). Best-effort. */
export async function bootstrapHermesLearning(opts?: {
  seedMode?: "merge" | "overwrite";
}): Promise<void> {
  const seedEnv =
    opts?.seedMode === "overwrite"
      ? { JOSHU_HERMES_SKILLS_SEED_MODE: "overwrite" }
      : undefined;
  await runBashScript("scripts/bootstrap-hermes-learning-skills.sh", seedEnv);
  await runBashScript("proprietary/scripts/hermes-learning-bootstrap.sh");
}
