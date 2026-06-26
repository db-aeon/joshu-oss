/**
 * Resolve paths for box snapshot / factory operations (local dev + VPS).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BoxPaths {
  projectRoot: string;
  arozData: string;
  arozUser: string;
  userHome: string;
  desktopRoot: string;
  filesRoot: string;
  hermesHome: string;
  gbrainHome: string;
  factoryManifest: string;
  releaseJson: string;
  snapshotDir: string;
  hindsightDatabaseUrl: string;
  /** Local dev pg0 data dir (~/.pg0/instances/hindsight) when embedded Hindsight is used. */
  hindsightPg0Dir: string | null;
  hindsightBankId: string;
}

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function isVpsArozData(arozData: string): boolean {
  return path.resolve(arozData) === "/var/lib/arozos";
}

function listUserDirs(usersRoot: string, overrideUser: string): string[] {
  if (overrideUser) return [overrideUser];
  if (!fs.existsSync(usersRoot)) return [];
  const names = fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name !== "admin")
    .sort();
  if (names.length > 0) return names;
  return fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function resolveArozUser(arozData: string): { user: string; userHome: string } | null {
  const usersRoot = path.join(arozData, "files", "users");
  const overrideUser = envTrim("JOSHU_AROZ_USER");
  if (isVpsArozData(arozData) && !overrideUser) return null;

  for (const user of listUserDirs(usersRoot, overrideUser)) {
    const userHome = path.join(usersRoot, user);
    const desktop = path.join(userHome, "Desktop");
    if (fs.existsSync(desktop)) return { user, userHome };
  }

  if (!isVpsArozData(arozData)) {
    const adminHome = path.join(usersRoot, "admin");
    const adminDesktop = path.join(adminHome, "Desktop");
    fs.mkdirSync(adminDesktop, { recursive: true });
    return { user: "admin", userHome: adminHome };
  }

  return null;
}

interface Pg0InstanceMeta {
  port?: number;
  username?: string;
  password?: string;
  database?: string;
}

/** Local dev uses pg0 embedded Postgres (~/.pg0/instances/hindsight on port 5433). */
function resolveHindsightDatabaseUrl(): { url: string; pg0Dir: string | null } {
  const fromEnv = envTrim("HINDSIGHT_API_DATABASE_URL");
  if (fromEnv) return { url: fromEnv, pg0Dir: null };

  const pg0Meta = path.join(os.homedir(), ".pg0", "instances", "hindsight", "instance.json");
  if (fs.existsSync(pg0Meta)) {
    try {
      const meta = JSON.parse(fs.readFileSync(pg0Meta, "utf8")) as Pg0InstanceMeta;
      const port = meta.port ?? 5433;
      const user = meta.username ?? "hindsight";
      const pass = meta.password ?? "hindsight";
      const db = meta.database ?? "hindsight";
      return {
        url: `postgresql://${user}:${pass}@127.0.0.1:${port}/${db}`,
        pg0Dir: path.join(os.homedir(), ".pg0", "instances", "hindsight"),
      };
    } catch {
      /* fall through */
    }
  }

  return {
    url: "postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight",
    pg0Dir: null,
  };
}

export function resolveBoxPaths(projectRoot = process.cwd()): BoxPaths {
  const arozData = path.resolve(
    envTrim("AROZ_DATA") || path.join(projectRoot, ".local", "arozos-data"),
  );
  const joshuFilesDirName = envTrim("JOSHU_FILES_DIR_NAME", "joshu's files");
  const userInfo = resolveArozUser(arozData);
  const arozUser = userInfo?.user ?? envTrim("JOSHU_AROZ_USER", "admin");
  const userHome = userInfo?.userHome ?? path.join(arozData, "files", "users", arozUser);
  const desktopRoot = path.join(userHome, "Desktop");
  const filesRoot = path.join(desktopRoot, joshuFilesDirName);

  const hermesHome = path.resolve(envTrim("HERMES_HOME") || path.join(os.homedir(), ".hermes"));
  const gbrainResolved =
    envTrim("GBRAIN_HOME") ||
    (isVpsArozData(arozData) ? "/root/.gbrain" : path.join(projectRoot, ".local", "gbrain"));

  const snapshotDir = path.resolve(
    envTrim("JOSHU_SNAPSHOT_DIR") || path.join(projectRoot, ".local", "snapshots"),
  );

  const factoryInImage = path.join(projectRoot, "factory", "manifest.yaml");
  const factoryManifest = fs.existsSync(factoryInImage)
    ? factoryInImage
    : path.join("/opt/joshu", "factory", "manifest.yaml");

  const releaseJson = fs.existsSync(path.join(projectRoot, "deploy", "RELEASE.json"))
    ? path.join(projectRoot, "deploy", "RELEASE.json")
    : path.join(projectRoot, "RELEASE.json");

  const hindsight = resolveHindsightDatabaseUrl();

  return {
    projectRoot: path.resolve(projectRoot),
    arozData,
    arozUser,
    userHome,
    desktopRoot,
    filesRoot,
    hermesHome,
    gbrainHome: path.resolve(gbrainResolved),
    factoryManifest,
    releaseJson,
    snapshotDir,
    hindsightDatabaseUrl: hindsight.url,
    hindsightPg0Dir: hindsight.pg0Dir,
    hindsightBankId: envTrim("HINDSIGHT_BANK_ID", "joshu"),
  };
}

/** Hermes personal paths captured in snapshots and wiped on hard factory reset. */
export function hermesUserSnapshotPaths(hermesHome: string): string[] {
  const candidates = [
    path.join(hermesHome, "config.user.yaml"),
    path.join(hermesHome, "sessions"),
    path.join(hermesHome, "personalities"),
    path.join(hermesHome, "profiles"),
    path.join(hermesHome, "skills"),
    path.join(hermesHome, "cron"),
    path.join(hermesHome, "memories"),
  ];
  return candidates.filter((p) => fs.existsSync(p));
}
