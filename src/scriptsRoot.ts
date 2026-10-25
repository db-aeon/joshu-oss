/**
 * Scripts root of the sandbox image (change image-owned-box-runtime).
 *
 * vps-start.sh copies /opt/joshu/.image/scripts and the hotfix overlay to
 * JOSHU_SCRIPTS_ROOT (/run/joshu-boot-scripts). Code that runs a script uses
 * that copy first, so the hotfix overlay applies and a host path cannot win.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** Path of `script` in JOSHU_SCRIPTS_ROOT when the file is there, else in `fallbackDir`. */
export function resolveScriptPath(fallbackDir: string, script: string): string {
  const root = process.env.JOSHU_SCRIPTS_ROOT?.trim();
  if (root) {
    const candidate = path.join(root, script);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(fallbackDir, script);
}
