import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";

export const EA_LAYOUT_VERSION = "2.0.0";

export function onboardingStatePath(projectRoot: string): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, "onboarding.json");
}

export function onboardingDraftPath(projectRoot: string): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, "onboarding.draft.json");
}

export function joshuFilesRoot(projectRoot: string): string | null {
  return resolveJoshuFilesPaths(projectRoot)?.filesRoot ?? null;
}

export function projectsRoot(projectRoot: string): string | null {
  const filesRoot = joshuFilesRoot(projectRoot);
  if (!filesRoot) return null;
  return path.join(filesRoot, "Projects");
}

/** @deprecated EA v1 — use projectsRoot() */
export function workspaceRoot(projectRoot: string): string | null {
  const filesRoot = joshuFilesRoot(projectRoot);
  if (!filesRoot) return null;
  return path.join(filesRoot, "workspace");
}

export function eaVersionPath(projectRoot: string): string | null {
  const filesRoot = joshuFilesRoot(projectRoot);
  if (!filesRoot) return null;
  return path.join(filesRoot, ".joshu-ea-version");
}

export function readJsonFile<T>(file: string | null): T | null {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
