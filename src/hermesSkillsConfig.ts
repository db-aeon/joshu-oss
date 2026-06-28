import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

/** Product skill allowlist — only file committed in repo (no generated denylist). */
export const DEFAULT_HERMES_SKILLS_ENABLED_FILE = path.resolve(
  process.cwd(),
  "integrations/hermes/skills-enabled.yaml",
);

/** Bundled Hermes skills Joshu keeps enabled (not under integrations/hermes/skills). */
export const JOSHU_ESSENTIAL_HERMES_SKILLS = [
  "hermes-agent",
  "native-mcp",
  "mcporter",
  "joshu-browser",
  "kanban-worker",
] as const;

function normalizeSkillNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  return names
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim())
    .filter(Boolean);
}

function parseSkillNameFromFrontmatter(raw: string): string | null {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const nameMatch = fmMatch[1]?.match(/^name:\s*(.+)$/m);
  if (!nameMatch?.[1]) return null;
  return nameMatch[1].trim().replace(/^["']|["']$/g, "");
}

const SKIP_SKILL_DIR_NAMES = new Set(["node_modules", ".git", "__pycache__"]);

/** Walk a skills tree and collect `name:` values from SKILL.md frontmatter. */
export async function discoverSkillNamesInDir(dir: string): Promise<string[]> {
  const names: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_SKILL_DIR_NAMES.has(ent.name)) continue;
        await walk(full);
        continue;
      }
      if (ent.name !== "SKILL.md") continue;
      try {
        const raw = await readFile(full, "utf8");
        const name = parseSkillNameFromFrontmatter(raw);
        if (name) names.push(name);
      } catch {
        // ignore unreadable skill files
      }
    }
  }

  await walk(dir);
  return names;
}

/** Load product allowlist from integrations/hermes/skills-enabled.yaml. */
export async function loadProductEnabledSkills(
  filePath = process.env.JOSHU_HERMES_SKILLS_ENABLED_FILE?.trim() || DEFAULT_HERMES_SKILLS_ENABLED_FILE,
): Promise<string[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const doc = YAML.parse(raw) as { enabled?: unknown } | null;
    return normalizeSkillNames(doc?.enabled);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Optional comma-separated extras (instance.env / Joshu .env). */
export function parseExtraEnabledSkillsFromEnv(): string[] {
  const raw = process.env.JOSHU_HERMES_SKILLS_ENABLED?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Optional comma-separated extras (instance.env / Joshu .env). */
export function parseExtraDisabledSkillsFromEnv(): string[] {
  const raw = process.env.JOSHU_HERMES_SKILLS_DISABLED?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function mergeEnabledSkillNames(...groups: string[][]): string[] {
  const set = new Set<string>();
  for (const group of groups) {
    for (const name of group) set.add(name);
  }
  return [...set].sort();
}

export function mergeDisabledSkillNames(...groups: string[][]): string[] {
  const set = new Set<string>();
  for (const group of groups) {
    for (const name of group) set.add(name);
  }
  return [...set].sort();
}

export function computeDisabledFromAllowlist(allNames: string[], enabledNames: string[]): string[] {
  const enabled = new Set(enabledNames);
  return [...new Set(allNames.filter((name) => !enabled.has(name)))].sort();
}

export type ProductSkillsPolicyOptions = {
  externalSkillsDir: string;
  hermesAgentRoot?: string;
  /** Skills from installed apps (.joshu/app-skills.json + manifests). */
  appSkillNames?: string[];
};

/** Hermes checkout for bundled skill discovery (walk up from HERMES_BIN until skills/ exists). */
export function resolveHermesAgentRoot(): string | undefined {
  const explicit =
    process.env.HERMES_AGENT_ROOT?.trim() ||
    process.env.HERMES_DIR?.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (existsSync(path.join(resolved, "skills"))) return resolved;
  }

  const hermesBin = process.env.HERMES_BIN?.trim();
  if (hermesBin && hermesBin.includes(path.sep)) {
    let dir = path.resolve(path.dirname(hermesBin));
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(path.join(dir, "skills"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const vpsDefault = path.resolve("/opt/hermes-agent");
  return existsSync(path.join(vpsDefault, "skills")) ? vpsDefault : undefined;
}

/** Resolve dirs for bundled-skill discovery at gateway sync. */
export function resolveProductSkillsDirs(cwd = process.cwd()): ProductSkillsPolicyOptions {
  const externalSkillsDir = path.resolve(
    process.env.JOSHU_HERMES_SKILLS_DIR?.trim() || path.join(cwd, "integrations/hermes/skills"),
  );
  return { externalSkillsDir, hermesAgentRoot: resolveHermesAgentRoot() };
}

export type ProductSkillsPolicyResult = {
  /** Bunded Hermes skills to disable in config.yaml (computed from allowlist). */
  disabled: string[];
  /** Effective enabled set (allowlist + repo skills + essentials + env). */
  enabled: string[];
  discovered: string[];
};

/**
 * Runtime policy: small repo allowlist + computed bundled denylist.
 * Agent-created skills in ~/.hermes/skills/ are never in `discovered` and stay enabled.
 */
export async function computeProductSkillsPolicy(
  options: ProductSkillsPolicyOptions,
): Promise<ProductSkillsPolicyResult> {
  const scanDirs: string[] = [options.externalSkillsDir];
  if (options.hermesAgentRoot) {
    scanDirs.push(
      path.join(options.hermesAgentRoot, "skills"),
      path.join(options.hermesAgentRoot, "optional-skills"),
    );
  }

  const discovered = new Set<string>();
  for (const dir of scanDirs) {
    for (const name of await discoverSkillNamesInDir(dir)) {
      discovered.add(name);
    }
  }

  const enabled = mergeEnabledSkillNames(
    await loadProductEnabledSkills(),
    await discoverSkillNamesInDir(options.externalSkillsDir),
    [...JOSHU_ESSENTIAL_HERMES_SKILLS],
    parseExtraEnabledSkillsFromEnv(),
    options.appSkillNames ?? [],
  );
  const enabledSet = new Set(enabled);
  const disabled = mergeDisabledSkillNames(
    [...discovered].filter((name) => !enabledSet.has(name)).sort(),
    parseExtraDisabledSkillsFromEnv(),
  );

  return { disabled, enabled, discovered: [...discovered].sort() };
}

/** Gateway sync entrypoint. */
export async function loadProductSkillsPolicy(cwd = process.cwd()): Promise<ProductSkillsPolicyResult> {
  const { loadDevAppSkillNames } = await import("./appSkillsRegistry.js");
  const { loadAppManifests, collectAppSkillNames } = await import("./appRegistry.js");
  await loadAppManifests(cwd);
  const appSkillNames = [
    ...new Set([...(await loadDevAppSkillNames(cwd)), ...collectAppSkillNames()]),
  ];
  return computeProductSkillsPolicy({ ...resolveProductSkillsDirs(cwd), appSkillNames });
}

/** @deprecated Alias for sync script — use computeProductSkillsPolicy. */
export type ProductDisabledSkillsOptions = {
  hermesHome: string;
  externalSkillsDir: string;
  hermesCheckoutDir?: string;
};

/** @deprecated Alias for sync script — use computeProductSkillsPolicy. */
export async function suggestProductDisabledSkills(
  options: ProductDisabledSkillsOptions,
): Promise<{ disabled: string[]; kept: string[]; discovered: string[] }> {
  const result = await computeProductSkillsPolicy({
    externalSkillsDir: options.externalSkillsDir,
    hermesAgentRoot: options.hermesCheckoutDir,
  });
  return { disabled: result.disabled, kept: result.enabled, discovered: result.discovered };
}
