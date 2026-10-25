import fs from "node:fs";
import path from "node:path";

import { joshuStateDir } from "../joshuStateDir.js";

/** `proactive/` in the Joshu state folder (src/joshuStateDir.ts). */
export function proactiveConfigDir(projectRoot = process.cwd()): string {
  return path.join(joshuStateDir(projectRoot), "proactive");
}

export function proactiveStatePath(projectRoot = process.cwd()): string {
  return path.join(proactiveConfigDir(projectRoot), "state.json");
}

export function hygienePlanPath(projectRoot = process.cwd()): string {
  return path.join(proactiveConfigDir(projectRoot), "hygiene-plan.json");
}

export function ensureProactiveConfigDir(projectRoot = process.cwd()): string {
  const dir = proactiveConfigDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
