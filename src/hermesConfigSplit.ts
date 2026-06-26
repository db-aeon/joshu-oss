/**
 * Split Hermes config into product-managed keys (config.yaml) and user keys (config.user.yaml).
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export type ConfigRecord = Record<string, unknown>;

export const HERMES_USER_CONFIG_FILE = "config.user.yaml";

/** Top-level keys owned by the user / personal snapshot. */
export const HERMES_USER_TOP_LEVEL_KEYS = [
  "voice",
  "stt",
  "tts",
  "profiles",
  "personalities",
  "messaging",
] as const;

function asRecord(value: unknown): ConfigRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigRecord) : {};
}

/** Serialize for stable semantic equality checks (YAML round-trip normalization). */
function configRecordsEqual(a: ConfigRecord, b: ConfigRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

let configWriteChain: Promise<void> = Promise.resolve();

async function withHermesConfigWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = configWriteChain.then(fn, fn);
  configWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

export function extractUserConfig(full: ConfigRecord): ConfigRecord {
  const user: ConfigRecord = {};
  for (const key of HERMES_USER_TOP_LEVEL_KEYS) {
    if (key in full && full[key] !== undefined) {
      user[key] = full[key];
    }
  }
  return user;
}

export function stripUserConfig(full: ConfigRecord): ConfigRecord {
  const managed = { ...full };
  for (const key of HERMES_USER_TOP_LEVEL_KEYS) {
    delete managed[key];
  }
  return managed;
}

export function mergeUserIntoConfig(managed: ConfigRecord, user: ConfigRecord): ConfigRecord {
  const merged = { ...managed };
  for (const key of HERMES_USER_TOP_LEVEL_KEYS) {
    if (key in user && user[key] !== undefined) {
      merged[key] = user[key];
    }
  }
  return merged;
}

export async function readHermesUserConfig(hermesHome: string): Promise<ConfigRecord> {
  const userPath = path.join(hermesHome, HERMES_USER_CONFIG_FILE);
  try {
    return asRecord(YAML.parse(await readFile(userPath, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Read product-managed keys from config.yaml; recover with {} when YAML is corrupt. */
export async function readManagedHermesConfig(hermesHome: string): Promise<{
  managed: ConfigRecord;
  recoveredFromCorrupt: boolean;
}> {
  const configPath = path.join(hermesHome, "config.yaml");
  try {
    const parsed = asRecord(YAML.parse(await readFile(configPath, "utf8")));
    return { managed: stripUserConfig(parsed), recoveredFromCorrupt: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { managed: {}, recoveredFromCorrupt: false };
    }
    return { managed: {}, recoveredFromCorrupt: true };
  }
}

export async function writeHermesUserConfig(hermesHome: string, user: ConfigRecord): Promise<void> {
  const userPath = path.join(hermesHome, HERMES_USER_CONFIG_FILE);
  if (Object.keys(user).length === 0) return;
  await withHermesConfigWriteLock(async () => {
    await atomicWriteText(userPath, YAML.stringify(user));
  });
}

/** One-time migration: move user keys from config.yaml to config.user.yaml. */
export async function migrateHermesUserConfig(hermesHome: string): Promise<boolean> {
  const configPath = path.join(hermesHome, "config.yaml");
  const userPath = path.join(hermesHome, HERMES_USER_CONFIG_FILE);
  let full: ConfigRecord = {};
  try {
    full = asRecord(YAML.parse(await readFile(configPath, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  const extracted = extractUserConfig(full);
  if (Object.keys(extracted).length === 0) return false;

  let existingUser: ConfigRecord = {};
  try {
    existingUser = asRecord(YAML.parse(await readFile(userPath, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const mergedUser = { ...existingUser, ...extracted };
  const managedOnly = stripUserConfig(full);

  await withHermesConfigWriteLock(async () => {
    await atomicWriteText(userPath, YAML.stringify(mergedUser));
    await atomicWriteText(configPath, YAML.stringify(managedOnly));
  });
  return true;
}

/**
 * Merge managed + config.user.yaml and write config.yaml when content differs.
 * Uses an in-process lock and atomic replace (temp + rename).
 */
export async function writeMergedHermesConfig(
  hermesHome: string,
  managed: ConfigRecord,
): Promise<boolean> {
  return withHermesConfigWriteLock(async () => {
    const user = await readHermesUserConfig(hermesHome);
    const merged = mergeUserIntoConfig(managed, user);
    const configPath = path.join(hermesHome, "config.yaml");
    const nextYaml = YAML.stringify(merged);

    try {
      const existing = asRecord(YAML.parse(await readFile(configPath, "utf8")));
      if (configRecordsEqual(merged, existing)) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // New file — fall through to write.
      } else {
        // Corrupt or unreadable — rewrite merged config.
      }
    }

    await atomicWriteText(configPath, nextYaml);
    return true;
  });
}
