import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

export type LocalEnvOverrides = Record<string, string>;

function localEnvPath(projectRoot = process.cwd()): string | null {
  const base = joshuConfigDir(projectRoot);
  if (!base) return null;
  return path.join(base, "safety-settings", "local-env.json");
}

function ensureDir(projectRoot: string): string | null {
  const file = localEnvPath(projectRoot);
  if (!file) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return file;
}

export function readLocalEnvOverrides(projectRoot = process.cwd()): LocalEnvOverrides {
  const file = localEnvPath(projectRoot);
  if (!file || !fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LocalEnvOverrides;
    if (!parsed || typeof parsed !== "object") return {};
    const out: LocalEnvOverrides = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function readLocalEnv(key: string, projectRoot = process.cwd()): string | undefined {
  return readLocalEnvOverrides(projectRoot)[key];
}

export function writeLocalEnvOverrides(
  updates: LocalEnvOverrides,
  projectRoot = process.cwd(),
): void {
  const file = ensureDir(projectRoot);
  if (!file) throw new Error("Could not resolve safety-settings local-env path");
  const current = readLocalEnvOverrides(projectRoot);
  const next = { ...current, ...updates };
  for (const [key, value] of Object.entries(updates)) {
    if (!value.trim()) delete next[key];
  }
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

/** Process env → local-env.json → undefined */
export function resolveEnvWithLocalFallback(name: string, projectRoot = process.cwd()): string {
  const fromProcess = process.env[name]?.trim() ?? "";
  if (fromProcess) return fromProcess;
  return readLocalEnv(name, projectRoot) ?? "";
}
