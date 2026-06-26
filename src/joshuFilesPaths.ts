/**
 * Resolve ArozOS Desktop / joshu's files paths for gbrain + Hermes file writes.
 * User-visible files must live under ArozOS data, not the host macOS ~/Desktop.
 */

import fs from "node:fs";
import path from "node:path";

export interface JoshuFilesPaths {
  arozData: string;
  desktopRoot: string;
  filesRoot: string;
  arozUser: string;
  /** gbrain source id for pages under sync.repo_path (joshu's files). */
  gbrainSource: "default";
  joshuFilesDirName: string;
}

function envTrim(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function isVpsArozData(arozData: string): boolean {
  return path.resolve(arozData) === "/var/lib/arozos";
}

function listUserDirs(usersRoot: string, overrideUser: string): string[] {
  if (overrideUser) return [overrideUser];
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

/** First ArozOS user Desktop, or JOSHU_AROZ_USER when set. VPS requires JOSHU_AROZ_USER. */
export function resolveJoshuFilesPaths(projectRoot = process.cwd()): JoshuFilesPaths | null {
  const arozData = path.resolve(
    envTrim("AROZ_DATA") || path.join(projectRoot, ".local", "arozos-data"),
  );
  const joshuFilesDirName = envTrim("JOSHU_FILES_DIR_NAME", "joshu's files");
  const usersRoot = path.join(arozData, "files", "users");
  if (!fs.existsSync(usersRoot)) return null;

  const overrideUser = envTrim("JOSHU_AROZ_USER");
  if (isVpsArozData(arozData) && !overrideUser) {
    console.warn(
      "[joshu-files] JOSHU_AROZ_USER is required on VPS (AROZ_DATA=/var/lib/arozos); gbrain/Hermes file paths unavailable",
    );
    return null;
  }

  const userDirs = listUserDirs(usersRoot, overrideUser);

  for (const user of userDirs) {
    const desktopRoot = path.join(usersRoot, user, "Desktop");
    if (!fs.existsSync(desktopRoot)) continue;
    const filesRoot = path.join(desktopRoot, joshuFilesDirName);
    return {
      arozData,
      desktopRoot: path.resolve(desktopRoot),
      filesRoot: path.resolve(filesRoot),
      arozUser: user,
      gbrainSource: "default",
      joshuFilesDirName,
    };
  }

  return null;
}

/** Env vars to inject into Hermes / gbrain MCP workers. */
export function joshuFilesPathEnv(paths: JoshuFilesPaths): Record<string, string> {
  return {
    AROZ_DATA: paths.arozData,
    JOSHU_AROZ_USER: paths.arozUser,
    JOSHU_DESKTOP_ROOT: paths.desktopRoot,
    JOSHU_FILES_ROOT: paths.filesRoot,
    GBRAIN_SOURCE: paths.gbrainSource,
    JOSHU_FILES_DIR_NAME: paths.joshuFilesDirName,
  };
}

export interface JoshuHermesWorkspaceScope {
  /** Hermes terminal.cwd — ArozOS Desktop working folder. */
  terminalCwd: string;
  /** Hermes HERMES_WRITE_SAFE_ROOT — blocks write_file/patch outside this tree. */
  writeSafeRoot: string;
}

/** Shell cwd + write sandbox for Hermes when ArozOS Desktop paths resolve. */
export function resolveJoshuHermesWorkspaceScope(paths: JoshuFilesPaths): JoshuHermesWorkspaceScope {
  return {
    terminalCwd: envTrim("JOSHU_HERMES_TERMINAL_CWD") || paths.desktopRoot,
    writeSafeRoot: envTrim("JOSHU_HERMES_WRITE_SAFE_ROOT") || paths.desktopRoot,
  };
}
