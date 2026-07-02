import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

/** Keys Welcome may persist for standalone self-host (not provision-locked). */
export const BOX_SECRETS_UI_KEYS = [
  "OPENROUTER_API_KEY",
  "HINDSIGHT_API_LLM_API_KEY",
  "GEMINI_API_KEY",
  /** gbrain + Hindsight embeddings when HINDSIGHT_API_EMBEDDINGS_PROVIDER=google */
  "HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY",
] as const;

export type BoxSecretsUiKey = (typeof BOX_SECRETS_UI_KEYS)[number];

export type BoxSecretsOverrides = Partial<Record<BoxSecretsUiKey, string>>;

function localEnvPath(projectRoot = process.cwd()): string | null {
  const base = joshuConfigDir(projectRoot);
  if (!base) return null;
  return path.join(base, "box-secrets", "local-env.json");
}

function ensureDir(projectRoot: string): string | null {
  const file = localEnvPath(projectRoot);
  if (!file) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return file;
}

export function readBoxSecretsOverrides(projectRoot = process.cwd()): BoxSecretsOverrides {
  const file = localEnvPath(projectRoot);
  if (!file || !fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: BoxSecretsOverrides = {};
    for (const key of BOX_SECRETS_UI_KEYS) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function writeBoxSecretsOverrides(
  updates: BoxSecretsOverrides,
  projectRoot = process.cwd(),
): void {
  const file = ensureDir(projectRoot);
  if (!file) throw new Error("Could not resolve box-secrets local-env path");
  const current = readBoxSecretsOverrides(projectRoot);
  const next: BoxSecretsOverrides = { ...current, ...updates };
  for (const key of BOX_SECRETS_UI_KEYS) {
    const value = updates[key];
    if (value !== undefined && !value.trim()) delete next[key];
  }
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
