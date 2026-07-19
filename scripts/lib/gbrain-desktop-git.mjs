/**
 * gbrain sync is git-aware — markdown under Desktop must be committed before
 * sync_brain indexes it. Git root is always ArozOS `files/users/` (never the
 * joshu app repo or per-Desktop nested repos).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Joshu gbrain",
  GIT_AUTHOR_EMAIL: "gbrain@joshu.local",
  GIT_COMMITTER_NAME: "Joshu gbrain",
  GIT_COMMITTER_EMAIL: "gbrain@joshu.local",
};

/**
 * Desktop paths that must never enter File Brain (gitignore + untrack).
 * - HERMES.md / SOUL.md: Joshu-managed context without gbrain frontmatter.
 * - .metadata/: ArozOS trash + desktop metadata — deleting a folder moves it
 *   here; if those .md files stay git-tracked, sync never drops the live pages
 *   (and may re-index trash).
 */
export const GBRAIN_DESKTOP_EXCLUDE_ENTRIES = [
  "HERMES.md",
  "SOUL.md",
  ".metadata/",
];

const GBRAIN_GITIGNORE_MARKER = "# joshu-managed: gbrain-desktop-excludes";
/** Paths recorded in sync-failures.jsonl that we permanently exclude. */
const GBRAIN_SYNC_FAILURE_IGNORE_MARKER = "# joshu-managed: gbrain-sync-failure-excludes";

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
 * @param {string} entry gitignore-style path (may end with `/`)
 */
function gitignoreEntryToRmPath(entry) {
  return entry.replace(/\/+$/, "");
}

/**
 * Resolve `${GBRAIN_HOME}/.gbrain/sync-failures.jsonl`.
 * @returns {string | null}
 */
export function resolveGbrainSyncFailuresPath() {
  const home = process.env.GBRAIN_HOME?.trim();
  if (!home) return null;
  return path.join(home, ".gbrain", "sync-failures.jsonl");
}

/**
 * Relative Desktop paths that repeatedly block gbrain sync (MCP `sync_brain`
 * has no `--skip-failed`). Safe subset only — no absolute / `..` paths.
 *
 * @returns {string[]}
 */
export function listGbrainSyncFailureExcludePaths() {
  const failuresPath = resolveGbrainSyncFailuresPath();
  if (!failuresPath || !existsSync(failuresPath)) return [];

  /** @type {Set<string>} */
  const paths = new Set();
  let raw = "";
  try {
    raw = readFileSync(failuresPath, "utf8");
  } catch {
    return [];
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      const rel = typeof row?.path === "string" ? row.path.trim() : "";
      if (!rel || path.isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) continue;
      paths.add(rel.replace(/\\/g, "/"));
    } catch {
      /* skip corrupt lines */
    }
  }
  return [...paths].sort();
}

/**
 * Keep Desktop/.gitignore excluding Joshu-managed Hermes context, ArozOS
 * metadata/trash, and recorded sync-failure paths. Idempotent.
 *
 * @param {string} desktopRoot
 * @returns {boolean} true when the file was created or changed
 */
export function ensureDesktopGbrainGitignore(desktopRoot) {
  const desktop = path.resolve(desktopRoot);
  if (path.basename(desktop) !== "Desktop") return false;
  mkdirSync(desktop, { recursive: true });

  const gitignorePath = path.join(desktop, ".gitignore");
  let existing = "";
  if (existsSync(gitignorePath)) {
    try {
      existing = readFileSync(gitignorePath, "utf8");
    } catch {
      existing = "";
    }
  }

  const lines = existing.split(/\r?\n/);
  const have = new Set(lines.map((l) => l.trim()).filter(Boolean));
  /** @type {string[]} */
  const staticToAdd = [];
  for (const entry of GBRAIN_DESKTOP_EXCLUDE_ENTRIES) {
    if (!have.has(entry)) staticToAdd.push(entry);
  }
  const failurePaths = listGbrainSyncFailureExcludePaths();
  /** @type {string[]} */
  const failureToAdd = [];
  for (const rel of failurePaths) {
    if (!have.has(rel)) failureToAdd.push(rel);
  }

  const needStaticMarker = !have.has(GBRAIN_GITIGNORE_MARKER);
  const needFailureMarker =
    failurePaths.length > 0 && !have.has(GBRAIN_SYNC_FAILURE_IGNORE_MARKER);
  if (
    staticToAdd.length === 0 &&
    failureToAdd.length === 0 &&
    !needStaticMarker &&
    !needFailureMarker
  ) {
    return false;
  }

  let next = existing;
  if (next && !next.endsWith("\n")) next += "\n";
  if (needStaticMarker || staticToAdd.length > 0) {
    if (!have.has(GBRAIN_GITIGNORE_MARKER)) {
      if (next && !next.endsWith("\n\n")) next += next.endsWith("\n") ? "\n" : "\n\n";
      next += `${GBRAIN_GITIGNORE_MARKER}\n`;
      have.add(GBRAIN_GITIGNORE_MARKER);
    }
    for (const entry of staticToAdd) {
      next += `${entry}\n`;
      have.add(entry);
    }
  }
  if (needFailureMarker || failureToAdd.length > 0) {
    if (!have.has(GBRAIN_SYNC_FAILURE_IGNORE_MARKER)) {
      if (next && !next.endsWith("\n\n")) next += next.endsWith("\n") ? "\n" : "\n\n";
      next += `${GBRAIN_SYNC_FAILURE_IGNORE_MARKER}\n`;
      have.add(GBRAIN_SYNC_FAILURE_IGNORE_MARKER);
    }
    for (const entry of failureToAdd) {
      next += `${entry}\n`;
      have.add(entry);
    }
  }
  writeFileSync(gitignorePath, next, "utf8");
  return true;
}

/**
 * Drop excluded Desktop paths from the git index (leave on disk).
 * Already-tracked excludes keep being synced until this runs.
 *
 * @param {string} desktopRoot
 * @returns {Promise<boolean>} true when the index changed
 */
async function untrackDesktopGbrainExcludes(desktopRoot) {
  const desktop = path.resolve(desktopRoot);
  if (path.basename(desktop) !== "Desktop") return false;
  if (!(await hasValidOwnGitRepo(desktop))) return false;

  /** @type {string[]} */
  const targets = [
    ...GBRAIN_DESKTOP_EXCLUDE_ENTRIES.map(gitignoreEntryToRmPath),
    ...listGbrainSyncFailureExcludePaths(),
  ];

  let changed = false;
  for (const entry of targets) {
    try {
      const { stdout } = await runGit(desktop, ["ls-files", "--", entry]);
      if (!stdout.trim()) continue;
      // -r so `.metadata/` (and any nested trash) drops in one shot
      await runGit(desktop, ["rm", "--cached", "-r", "-q", "--", entry]);
      changed = true;
    } catch {
      /* not tracked or already removed */
    }
  }
  return changed;
}

/**
 * gbrain 0.40+ federated sources require .git at the Desktop path passed to sync_brain.
 *
 * @param {string} desktopRoot
 */
async function ensureDesktopFederatedGit(desktopRoot) {
  const desktop = path.resolve(desktopRoot);
  if (path.basename(desktop) !== "Desktop") return;

  ensureDesktopGbrainGitignore(desktop);
  await repairBrokenGitRoot(desktop);
  if (await hasValidOwnGitRepo(desktop)) {
    await untrackDesktopGbrainExcludes(desktop);
    return;
  }

  console.warn(`[gbrain-desktop-git] initializing federated git at ${desktop}`);
  await runGit(desktop, ["init", "-q"]);
  ensureDesktopGbrainGitignore(desktop);
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
 * Stage everything and commit if anything is staged, in a single repo root.
 *
 * @param {string} gitRoot
 * @returns {Promise<boolean>} true when a commit was created
 */
async function commitAllInGbrainRepo(gitRoot) {
  await assertOwnGitRoot(gitRoot);
  await runGit(gitRoot, ["add", "-A"]);
  try {
    await runGit(gitRoot, ["diff", "--cached", "--quiet"]);
    return false; // nothing staged
  } catch (err) {
    if (gitExitCode(err) !== 1) throw err;
  }
  const stamp = new Date().toISOString();
  await runGit(gitRoot, ["commit", "-m", `gbrain desktop index ${stamp}`]);
  return true;
}

/**
 * Stage and commit markdown so the next sync_brain sees Desktop changes.
 *
 * gbrain resolves every source to its nearest ancestor git repo. In gbrain
 * 0.40+ federated mode the Desktop is its own repo (see
 * `ensureDesktopFederatedGit`), so BOTH the default source
 * (`sync.repo_path` = `<Desktop>/joshu's files`) and the federated Desktop
 * source read `Desktop/.git`. New markdown must therefore be committed *inside*
 * the Desktop repo — committing only the outer `files/users/` repo records a
 * gitlink bump that gbrain never reads, leaving fresh files unindexed. We commit
 * in the Desktop repo (when present) and also keep the outer `files/users/` repo
 * current for legacy layouts and its gitlink pointer.
 *
 * @param {string} desktopRoot
 * @returns {Promise<{ ok: boolean; committed: boolean; error?: string }>}
 */
export async function stageDesktopForGbrainSync(desktopRoot) {
  if (!desktopRoot?.trim()) {
    return { ok: false, committed: false, error: "desktop root unset" };
  }

  const usersRoot = resolveGbrainGitRoot(desktopRoot);
  if (!usersRoot) {
    return { ok: false, committed: false, error: "files/users root could not be resolved" };
  }

  try {
    assertSafeGbrainGitRoot(usersRoot);
    await ensureGbrainGitRepo(desktopRoot);
    await ensureDesktopFederatedGit(desktopRoot);

    // Ordered set of repos gbrain may read: federated Desktop repo first (it
    // owns the indexed markdown), then the outer files/users repo.
    const desktop = path.resolve(desktopRoot);
    if (path.basename(desktop) === "Desktop") {
      ensureDesktopGbrainGitignore(desktop);
      await untrackDesktopGbrainExcludes(desktop);
    }
    /** @type {string[]} */
    const commitRoots = [];
    if (path.basename(desktop) === "Desktop" && (await hasValidOwnGitRepo(desktop))) {
      commitRoots.push(desktop);
    }
    if (!commitRoots.includes(usersRoot)) {
      commitRoots.push(usersRoot);
    }

    let committed = false;
    for (const root of commitRoots) {
      if (await commitAllInGbrainRepo(root)) committed = true;
    }
    return { ok: true, committed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, committed: false, error: message };
  }
}
