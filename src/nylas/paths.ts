import path from "node:path";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";

/** Per-user Joshu config under ArozOS (Nylas grants, agent profile). */
export function joshuConfigDir(projectRoot = process.cwd()): string | null {
  const paths = resolveJoshuFilesPaths(projectRoot);
  if (!paths) return null;
  return path.join(paths.arozData, "files", "users", paths.arozUser, ".joshu");
}
