import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { loadReleaseVersion } from "./manifest.js";
import type { BoxPaths } from "./paths.js";
import { hermesUserSnapshotPaths } from "./paths.js";
import {
  ensureArchiveLocal,
  listAllSnapshots,
  persistSnapshot,
  resolveSnapshotStorage,
} from "./storage/index.js";

const execFileAsync = promisify(execFile);

export interface SnapshotManifest {
  schemaVersion: 1;
  snapshotId: string;
  label?: string;
  createdAt: string;
  releaseVersion: string;
  joshuArozUser: string;
  gbrainStrategy: "rebuild" | "include";
  storageBackend?: string;
  storageBoxId?: string;
  storageKey?: string;
  components: Array<{ name: string; path: string; sha256: string; bytes: number }>;
}

function sha256File(filePath: string): { sha256: string; bytes: number } {
  const data = fs.readFileSync(filePath);
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function copyPathSync(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) copyDirSync(src, dest);
  else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function dumpHindsight(paths: BoxPaths, destFile: string): Promise<boolean> {
  try {
    await execFileAsync("pg_dump", ["--dbname", paths.hindsightDatabaseUrl, "--no-owner", "--no-acl"], {
      maxBuffer: 64 * 1024 * 1024,
    }).then(({ stdout }) => {
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.writeFileSync(destFile, stdout);
    });
    return true;
  } catch (err) {
    console.warn(`[box-state] Hindsight pg_dump skipped: ${(err as Error).message}`);
    return false;
  }
}

// pg_dump >= 17 writes `SET transaction_timeout = 0;` into the dump header.
// Older servers (the box ships PG 15) reject it with "unrecognized configuration
// parameter", which aborts the whole restore under ON_ERROR_STOP=1. These are
// session no-ops for a restore, so neutralize any known cross-version params
// before applying. Extend this list as newer pg_dump versions introduce more.
const PG_CROSS_VERSION_INCOMPATIBLE_SET_PARAMS = ["transaction_timeout"];

// Lines that require object ownership/superuser the restore role (hindsight)
// doesn't have. `COMMENT ON EXTENSION vector` fails with "must be owner of
// extension vector" because the extension is owned by the bootstrap superuser,
// not the app role. The comment is cosmetic metadata, so it's safe to skip.
const PG_OWNERSHIP_REQUIRED_LINE_PATTERNS = [/^COMMENT ON EXTENSION\b.*$/gm];

/**
 * Neutralize statements that would abort a cross-version / non-superuser restore
 * under ON_ERROR_STOP=1: newer-server-only SET params and ownership-gated lines.
 * Each is a no-op for restoring the actual data.
 */
function sanitizeCrossVersionDump(sqlFile: string): void {
  const text = fs.readFileSync(sqlFile, "utf8");
  const patterns = [
    new RegExp(
      `^SET (?:${PG_CROSS_VERSION_INCOMPATIBLE_SET_PARAMS.join("|")}) =.*$`,
      "gm",
    ),
    ...PG_OWNERSHIP_REQUIRED_LINE_PATTERNS,
  ];
  let cleaned = text;
  for (const pattern of patterns) {
    cleaned = cleaned.replace(
      pattern,
      (line) => `-- box-state: skipped for cross-version restore -> ${line}`,
    );
  }
  if (cleaned !== text) fs.writeFileSync(sqlFile, cleaned);
}

// The Hindsight service boots and runs Alembic migrations, so the target DB is
// never empty at restore time. Our dumps are plain pg_dump (no --clean/DROP), so
// every CREATE TABLE would collide ("relation ... already exists"). Reset the
// public schema first by dropping the objects the app role owns (all tables +
// materialized views), while KEEPING extensions: `vector`/`pg_trgm` are owned by
// the bootstrap superuser and the `hindsight` role can't recreate them, and the
// dump's `CREATE EXTENSION IF NOT EXISTS` is a no-op once they exist. This makes
// restore idempotent and independent of the dump's own DROP statements.
const HINDSIGHT_RESET_PUBLIC_SCHEMA_SQL = `
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT matviewname AS n FROM pg_matviews WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS public.%I CASCADE', r.n);
  END LOOP;
  FOR r IN SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.n);
  END LOOP;
END $$;
`;

async function restoreHindsight(paths: BoxPaths, sqlFile: string): Promise<void> {
  if (!fs.existsSync(sqlFile)) return;
  sanitizeCrossVersionDump(sqlFile);
  // Drop existing app-owned objects so the dump's CREATE statements don't collide.
  await execFileAsync(
    "psql",
    [paths.hindsightDatabaseUrl, "-v", "ON_ERROR_STOP=1", "-c", HINDSIGHT_RESET_PUBLIC_SCHEMA_SQL],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  await execFileAsync("psql", [paths.hindsightDatabaseUrl, "-v", "ON_ERROR_STOP=1", "-f", sqlFile], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

export interface CreateSnapshotOptions {
  label?: string;
  includeGbrain?: boolean;
  /** Upload under boxes/shared/ for seeding new boxes. */
  shared?: boolean;
}

export async function createSnapshot(
  paths: BoxPaths,
  options: CreateSnapshotOptions = {},
): Promise<{ snapshotId: string; manifest: SnapshotManifest; archivePath: string }> {
  const storage = resolveSnapshotStorage(paths);
  const snapshotId = new Date().toISOString().replace(/[:.]/g, "-");
  const staging = path.join(paths.snapshotDir, `.staging-${snapshotId}`);
  fs.mkdirSync(staging, { recursive: true });

  const arozDest = path.join(staging, "arozos", "files", "users", paths.arozUser);
  if (fs.existsSync(paths.userHome)) {
    copyDirSync(paths.userHome, arozDest);
  }

  const hermesDest = path.join(staging, "hermes");
  fs.mkdirSync(hermesDest, { recursive: true });
  for (const src of hermesUserSnapshotPaths(paths.hermesHome)) {
    const base = path.basename(src);
    copyPathSync(src, path.join(hermesDest, base));
  }

  const hindsightDir = path.join(staging, "hindsight");
  fs.mkdirSync(hindsightDir, { recursive: true });
  const dumpPath = path.join(hindsightDir, `bank-${paths.hindsightBankId}.sql`);
  await dumpHindsight(paths, dumpPath);

  const gbrainStrategy: "rebuild" | "include" = options.includeGbrain ? "include" : "rebuild";
  if (gbrainStrategy === "include" && fs.existsSync(paths.gbrainHome)) {
    copyDirSync(paths.gbrainHome, path.join(staging, "gbrain"));
  }

  let manifest: SnapshotManifest = {
    schemaVersion: 1,
    snapshotId,
    label: options.label,
    createdAt: new Date().toISOString(),
    releaseVersion: loadReleaseVersion(paths.releaseJson),
    joshuArozUser: paths.arozUser,
    gbrainStrategy,
    components: [],
  };

  fs.mkdirSync(paths.snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const archivePath = path.join(paths.snapshotDir, `${snapshotId}.tar.gz`);
  await execFileAsync("tar", ["-czf", archivePath, "-C", staging, "."]);

  const { sha256, bytes } = sha256File(archivePath);
  manifest.components.push({
    name: "archive",
    path: `${snapshotId}.tar.gz`,
    sha256,
    bytes,
  });

  const targetBoxId = options.shared
    ? process.env.JOSHU_SNAPSHOT_SHARED_BOX_ID?.trim() || "shared"
    : storage.config.boxId;

  manifest = await persistSnapshot(storage, manifest, archivePath, { targetBoxId });

  fs.rmSync(staging, { recursive: true, force: true });
  return { snapshotId, manifest, archivePath };
}

export interface RestoreSnapshotOptions {
  /** GCS box prefix when restoring a snapshot from another box (e.g. shared). */
  sourceBoxId?: string;
}

export async function restoreSnapshot(
  paths: BoxPaths,
  snapshotId: string,
  options: RestoreSnapshotOptions = {},
): Promise<{ snapshotId: string }> {
  const storage = resolveSnapshotStorage(paths);
  const { archivePath, manifest: meta } = await ensureArchiveLocal(
    storage,
    snapshotId,
    options.sourceBoxId,
  );

  const staging = path.join(paths.snapshotDir, `.restore-${snapshotId}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", staging]);

  const arozSrc = path.join(staging, "arozos", "files", "users", meta.joshuArozUser);
  if (fs.existsSync(arozSrc)) {
    fs.mkdirSync(path.dirname(paths.userHome), { recursive: true });
    fs.rmSync(paths.userHome, { recursive: true, force: true });
    copyDirSync(arozSrc, paths.userHome);
  }

  const hermesSrc = path.join(staging, "hermes");
  if (fs.existsSync(hermesSrc)) {
    for (const entry of fs.readdirSync(hermesSrc)) {
      const src = path.join(hermesSrc, entry);
      const dest = path.join(paths.hermesHome, entry);
      fs.rmSync(dest, { recursive: true, force: true });
      copyPathSync(src, dest);
    }
  }

  const sqlCandidates = [
    path.join(staging, "hindsight", `bank-${paths.hindsightBankId}.sql`),
    ...(fs.existsSync(path.join(staging, "hindsight"))
      ? fs.readdirSync(path.join(staging, "hindsight")).map((f) =>
          path.join(staging, "hindsight", f),
        )
      : []),
  ];
  for (const sqlFile of sqlCandidates) {
    if (fs.existsSync(sqlFile) && sqlFile.endsWith(".sql")) {
      await restoreHindsight(paths, sqlFile);
      break;
    }
  }

  if (meta.gbrainStrategy === "include") {
    const gbrainSrc = path.join(staging, "gbrain");
    if (fs.existsSync(gbrainSrc)) {
      fs.rmSync(paths.gbrainHome, { recursive: true, force: true });
      copyDirSync(gbrainSrc, paths.gbrainHome);
    }
  }

  fs.rmSync(staging, { recursive: true, force: true });
  return { snapshotId };
}

export async function listSnapshots(paths: BoxPaths): Promise<SnapshotManifest[]> {
  const storage = resolveSnapshotStorage(paths);
  return listAllSnapshots(storage);
}

export function listSnapshotsSync(paths: BoxPaths): SnapshotManifest[] {
  if (!fs.existsSync(paths.snapshotDir)) return [];
  return fs
    .readdirSync(paths.snapshotDir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(fs.readFileSync(path.join(paths.snapshotDir, n), "utf8")) as SnapshotManifest)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
