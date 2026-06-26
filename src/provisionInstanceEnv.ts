/**
 * Read JOSHU_* values from the VPS provision file (/etc/joshu/instance.env).
 * Instance-agent updates this file at runtime; the Node process env from boot stays stale.
 */
import fs from "node:fs";

const DEFAULT_INSTANCE_ENV_PATH = "/etc/joshu/instance.env";

let cached: { path: string; mtimeMs: number; vars: Record<string, string> } | null = null;

function instanceEnvPath(): string | null {
  const configured = process.env.JOSHU_COMPOSE_ENV_FILE?.trim();
  const path = configured || DEFAULT_INSTANCE_ENV_PATH;
  return fs.existsSync(path) ? path : null;
}

/** Parse KEY=VALUE lines (no export, no quotes required). */
export function readProvisionInstanceEnv(): Record<string, string> {
  const path = instanceEnvPath();
  if (!path) return {};

  try {
    const stat = fs.statSync(path);
    if (cached && cached.path === path && cached.mtimeMs === stat.mtimeMs) {
      return cached.vars;
    }

    const vars: Record<string, string> = {};
    const text = fs.readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }

    cached = { path, mtimeMs: stat.mtimeMs, vars };
    return vars;
  } catch {
    return {};
  }
}

/** Trimmed value from provision file, then process.env. */
export function provisionEnvTrim(name: string): string | undefined {
  const fromFile = readProvisionInstanceEnv()[name]?.trim();
  if (fromFile) return fromFile;
  const fromProcess = process.env[name]?.trim();
  return fromProcess || undefined;
}
