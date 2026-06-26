/**
 * gbrain sync is git-aware — markdown under Desktop must be committed before
 * sync_brain indexes it. Git root is always ArozOS `files/users/` (never the
 * joshu app repo or per-Desktop nested repos).
 */
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Joshu gbrain",
  GIT_AUTHOR_EMAIL: "gbrain@joshu.local",
  GIT_COMMITTER_NAME: "Joshu gbrain",
  GIT_COMMITTER_EMAIL: "gbrain@joshu.local",
};

/** @param {unknown} err */
function gitExitCode(err) {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = /** @type {{ code?: unknown }} */ (err).code;
  return typeof code === "number" ? code : undefined;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function runGit(cwd, args) {
  return execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY },
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Resolve `${AROZ_DATA}/files/users` from Desktop or an explicit users root.
 *
 * @param {string} desktopOrUsersRoot
 * @returns {string | null}
 */
export function resolveGbrainGitRoot(desktopOrUsersRoot) {
  const override = process.env.JOSHU_GBRAIN_GIT_ROOT?.trim();
  if (override) return path.resolve(override);

  const root = path.resolve(desktopOrUsersRoot);
  if (path.basename(root) === "users" && path.basename(path.dirname(root)) === "files") {
    return root;
  }
  if (path.basename(root) === "Desktop") {
    return path.resolve(root, "..", "..");
  }
  return null;
}

/**
 * @param {string} gitRoot
 * @returns {Promise<string | null>}
 */
async function gitToplevel(gitRoot) {
  try {
    const { stdout } = await runGit(gitRoot, ["rev-parse", "--show-toplevel"]);
    return path.resolve(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * True when `gitRoot` is its own repo root — not a bogus `.git` dir (e.g. empty
 * mkdir) that makes git walk up to the joshu app checkout.
 *
 * @param {string} gitRoot
 */
async function hasValidOwnGitRepo(gitRoot) {
  const resolved = path.resolve(gitRoot);
  if (!existsSync(path.join(resolved, ".git"))) return false;
  const toplevel = await gitToplevel(resolved);
  return toplevel === resolved;
}

/**
 * Empty or partial `.git` (mkdir without git init) makes git treat the path as
 * inside the parent repo — drop broken roots so nested init can proceed.
 *
 * @param {string} gitRoot
 */
async function repairBrokenGitRoot(gitRoot) {
  const resolved = path.resolve(gitRoot);
  const dotGit = path.join(resolved, ".git");
  if (!existsSync(dotGit)) return;
  if (await hasValidOwnGitRepo(resolved)) return;
  console.warn(`[gbrain-desktop-git] removing invalid .git at ${resolved}`);
  rmSync(dotGit, { recursive: true, force: true });
}

/**
 * Refuse to stage/commit when git would operate on a parent checkout.
 *
 * @param {string} gitRoot
 */
async function assertOwnGitRoot(gitRoot) {
  const resolved = path.resolve(gitRoot);
  const toplevel = await gitToplevel(resolved);
  if (toplevel !== resolved) {
    throw new Error(
      `[gbrain-desktop-git] refusing git at ${resolved}: nested repo missing (inside ${toplevel ?? "unknown"})`,
    );
  }
}

/**
 * Refuse to run gbrain git inside the joshu application checkout (local dev bug:
 * Desktop under .local/ used to commit day0/docs into origin/main).
 *
 * @param {string} gitRoot
 */
export function assertSafeGbrainGitRoot(gitRoot) {
  const resolved = path.resolve(gitRoot);
  const marker = `${path.sep}.local${path.sep}arozos-data${path.sep}files${path.sep}users`;
  if (resolved.includes(marker) || resolved.includes(`${path.sep}var${path.sep}lib${path.sep}arozos${path.sep}files${path.sep}users`)) {
    return;
  }
  const appRoot = process.env.JOSHU_APP_ROOT?.trim() || process.cwd();
  const appAbs = path.resolve(appRoot);
  if (
    existsSync(path.join(appAbs, "package.json")) &&
    existsSync(path.join(appAbs, "scripts", "start-gbrain.sh")) &&
    (resolved === appAbs || resolved.startsWith(`${appAbs}${path.sep}`))
  ) {
    throw new Error(
      `[gbrain-desktop-git] refusing git at ${resolved}: use ${appAbs}/.local/arozos-data/files/users (nested repo), not the joshu app root`,
    );
  }
}

/**
 * @param {string} root
 */
async function ensureBaselineCommit(root) {
  try {
    await runGit(root, ["rev-parse", "HEAD"]);
    return;
  } catch {
    /* create baseline below */
  }

  await runGit(root, ["add", "-A"]);
  try {
    await runGit(root, ["diff", "--cached", "--quiet"]);
    await runGit(root, ["commit", "--allow-empty", "-m", "gbrain sync baseline"]);
  } catch (err) {
    if (gitExitCode(err) === 1) {
      await runGit(root, ["commit", "-m", "gbrain sync baseline"]);
      return;
    }
    throw err;
  }
}

/**
 * gbrain 0.40+ federated sources require .git at the Desktop path passed to sync_brain.
 *
 * @param {string} desktopRoot
 */
async function ensureDesktopFederatedGit(desktopRoot) {
  const desktop = path.resolve(desktopRoot);
  if (path.basename(desktop) !== "Desktop") return;

  await repairBrokenGitRoot(desktop);
  if (await hasValidOwnGitRepo(desktop)) return;

  console.warn(`[gbrain-desktop-git] initializing federated git at ${desktop}`);
  await runGit(desktop, ["init", "-q"]);
  await ensureBaselineCommit(desktop);
}

/**
 * Ensure a git repo at `${AROZ_DATA}/files/users` (never Desktop or joshu root).
 *
 * @param {string} desktopOrUsersRoot
 */
export async function ensureGbrainGitRepo(desktopOrUsersRoot) {
  const gitRoot = resolveGbrainGitRoot(desktopOrUsersRoot);
  if (!gitRoot) {
    throw new Error(`[gbrain-desktop-git] cannot resolve files/users from ${desktopOrUsersRoot}`);
  }
  assertSafeGbrainGitRoot(gitRoot);
  await repairBrokenGitRoot(gitRoot);

  if (path.basename(path.resolve(desktopOrUsersRoot)) === "Desktop") {
    await ensureDesktopFederatedGit(desktopOrUsersRoot);
  }

  const hasOwnGit = await hasValidOwnGitRepo(gitRoot);
  const toplevel = await gitToplevel(gitRoot);

  if (toplevel === gitRoot && !hasOwnGit) {
    await ensureBaselineCommit(gitRoot);
    return;
  }

  if (hasOwnGit) {
    await ensureBaselineCommit(gitRoot);
    return;
  }

  if (toplevel && toplevel !== gitRoot) {
    console.warn(
      `[gbrain-desktop-git] files/users inside ${toplevel}; initializing nested git at ${gitRoot}`,
    );
  }

  await runGit(gitRoot, ["init", "-q"]);
  await ensureBaselineCommit(gitRoot);
}

/** @deprecated Use ensureGbrainGitRepo */
export const ensureDesktopGitRepo = ensureGbrainGitRepo;

/**
 * Stage and commit under `files/users/` so the next sync_brain sees Desktop changes.
 *
 * @param {string} desktopRoot
 * @returns {Promise<{ ok: boolean; committed: boolean; error?: string }>}
 */
export async function stageDesktopForGbrainSync(desktopRoot) {
  if (!desktopRoot?.trim()) {
    return { ok: false, committed: false, error: "desktop root unset" };
  }

  const gitRoot = resolveGbrainGitRoot(desktopRoot);
  if (!gitRoot) {
    return { ok: false, committed: false, error: "files/users root could not be resolved" };
  }

  try {
    assertSafeGbrainGitRoot(gitRoot);
    await ensureGbrainGitRepo(desktopRoot);
    await ensureDesktopFederatedGit(desktopRoot);
    await assertOwnGitRoot(gitRoot);
    await runGit(gitRoot, ["add", "-A"]);
    try {
      await runGit(gitRoot, ["diff", "--cached", "--quiet"]);
      return { ok: true, committed: false };
    } catch (err) {
      if (gitExitCode(err) !== 1) throw err;
    }
    const stamp = new Date().toISOString();
    await runGit(gitRoot, ["commit", "-m", `gbrain desktop index ${stamp}`]);
    return { ok: true, committed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, committed: false, error: message };
  }
}
