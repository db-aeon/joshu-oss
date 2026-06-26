/**
 * Reinstall factory ArozOS desktop shortcuts after hard reset wipes user Desktop trees.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoxPaths } from "./paths.js";

const execFileAsync = promisify(execFile);

export interface ArozosDesktopRestoreResult {
  ok: boolean;
  error?: string;
}

/** Recreate Desktop/joshu's files and install Joshu shortcut set (same as vps-start). */
export async function restoreArozosDesktopFactory(
  paths: BoxPaths,
): Promise<ArozosDesktopRestoreResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_DIR: paths.projectRoot,
    AROZ_DATA: paths.arozData,
  };
  try {
    await execFileAsync("bash", [`${paths.projectRoot}/scripts/bootstrap-joshu-files.sh`], {
      cwd: paths.projectRoot,
      env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    await execFileAsync(
      "bash",
      [
        "-c",
        `source "${paths.projectRoot}/scripts/lib/arozos-desktop-shortcuts.sh" && install_all_joshu_desktop_shortcuts`,
      ],
      { cwd: paths.projectRoot, env, timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error && "stderr" in err
        ? `${err.message}\n${String((err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "")}`.trim()
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: message };
  }
}
