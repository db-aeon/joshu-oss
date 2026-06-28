/**
 * Installed app skills registry — merged into Hermes allowlist at gateway sync.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

export type AppSkillsRegistry = {
  skills: string[];
};

const REGISTRY_REL = ".joshu/app-skills.json";

export function resolveAppSkillsRegistryPath(projectRoot: string, arozData?: string): string {
  const dataRoot = arozData?.trim() || process.env.AROZ_DATA?.trim() || path.join(projectRoot, ".local", "arozos-data");
  return path.join(dataRoot, "files", "users", resolveArozUser(), ".joshu", "app-skills.json");
}

function resolveArozUser(): string {
  const fromEnv = process.env.JOSHU_AROZ_USER?.trim();
  if (fromEnv) return fromEnv;
  return "admin";
}

export async function loadAppSkillNames(projectRoot: string): Promise<string[]> {
  const registryPath = resolveAppSkillsRegistryPath(projectRoot);
  if (!existsSync(registryPath)) return [];
  try {
    const raw = await readFile(registryPath, "utf8");
    const doc = JSON.parse(raw) as AppSkillsRegistry;
    return Array.isArray(doc.skills) ? doc.skills.filter((s) => typeof s === "string" && s.trim()) : [];
  } catch {
    return [];
  }
}

export async function registerAppSkill(projectRoot: string, skillName: string): Promise<void> {
  const name = skillName.trim();
  if (!name) return;
  const registryPath = resolveAppSkillsRegistryPath(projectRoot);
  await mkdir(path.dirname(registryPath), { recursive: true });
  const existing = new Set(await loadAppSkillNames(projectRoot));
  existing.add(name);
  await writeFile(registryPath, `${JSON.stringify({ skills: [...existing].sort() }, null, 2)}\n`, "utf8");
}

/** Fallback registry path under project .local for dev without ArozOS user. */
export async function loadDevAppSkillNames(projectRoot: string): Promise<string[]> {
  const devPath = path.join(projectRoot, REGISTRY_REL.replace(/^\//, ""));
  if (!existsSync(devPath)) return loadAppSkillNames(projectRoot);
  try {
    const raw = await readFile(devPath, "utf8");
    const doc = JSON.parse(raw) as AppSkillsRegistry;
    const fromDev = Array.isArray(doc.skills) ? doc.skills : [];
    const fromUser = await loadAppSkillNames(projectRoot);
    return [...new Set([...fromDev, ...fromUser])];
  } catch {
    return loadAppSkillNames(projectRoot);
  }
}
