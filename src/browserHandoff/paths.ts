import fs from "node:fs";
import path from "node:path";

import { joshuStateDir } from "../joshuStateDir.js";

/** Persist browser handoff records under `browser-handoff/` in the Joshu state folder (src/joshuStateDir.ts). */
export function browserHandoffDir(projectRoot = process.cwd()): string {
  return path.join(joshuStateDir(projectRoot), "browser-handoff");
}

export function ensureBrowserHandoffDir(projectRoot = process.cwd()): string {
  const dir = browserHandoffDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function handoffRecordPath(projectRoot: string, id: string): string {
  return path.join(browserHandoffDir(projectRoot), `${id}.json`);
}
