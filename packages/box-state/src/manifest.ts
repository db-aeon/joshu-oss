import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export interface FactorySeed {
  from: string;
  to: string;
  mode: "seed_if_missing" | "always";
}

export interface FactoryManifest {
  schemaVersion: number;
  release: string;
  seeds: FactorySeed[];
  structure: string[];
  hermes: {
    managed_keys: string[];
    user_keys: string[];
  };
  identity: {
    defaults: {
      name: string;
      imageUrl: string | null;
      voiceId: string | null;
      owner: { displayName: string };
    };
  };
  gbrain: { rebuild_on_restore: boolean };
  hindsight: { bank_id: string };
}

export function loadFactoryManifest(manifestPath: string): FactoryManifest {
  const raw = fs.readFileSync(manifestPath, "utf8");
  return YAML.parse(raw) as FactoryManifest;
}

export function loadReleaseVersion(releaseJsonPath: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(releaseJsonPath, "utf8")) as { version?: string };
    return data.version ?? "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

/** Copy seed files from repo template dirs (seed_if_missing). */
export function applyFactorySeeds(
  projectRoot: string,
  filesRoot: string,
  seeds: FactorySeed[],
): { seeded: string[]; skipped: string[] } {
  const seeded: string[] = [];
  const skipped: string[] = [];
  const vars = { files_root: filesRoot };

  for (const seed of seeds) {
    const fromDir = path.join(projectRoot, seed.from.replace(/\/$/, ""));
    const toDir = expandTemplate(seed.to, vars);
    if (!fs.existsSync(fromDir)) continue;
    fs.mkdirSync(toDir, { recursive: true });

    const walk = (src: string, dest: string) => {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(destPath, { recursive: true });
          walk(srcPath, destPath);
        } else if (entry.isFile()) {
          if (seed.mode === "seed_if_missing" && fs.existsSync(destPath)) {
            skipped.push(destPath);
            continue;
          }
          fs.copyFileSync(srcPath, destPath);
          seeded.push(destPath);
        }
      }
    };
    walk(fromDir, toDir);
  }

  return { seeded, skipped };
}

export function applyFactoryStructure(structure: string[], filesRoot: string): string[] {
  const created: string[] = [];
  const vars = { files_root: filesRoot };
  for (const item of structure) {
    const dir = expandTemplate(item, vars);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  return created;
}

/** EA v2: prefer FILING.md from factory seeds; legacy boxes may still have LOCATION.md. */
export function writeLocationHint(filesRoot: string): void {
  const filingPath = path.join(filesRoot, "FILING.md");
  if (fs.existsSync(filingPath)) return;
  const locationPath = path.join(filesRoot, "LOCATION.md");
  if (fs.existsSync(locationPath)) return;
  fs.mkdirSync(filesRoot, { recursive: true });
  fs.writeFileSync(
    filingPath,
    `# Joshu files

Agent writes live here: \`${filesRoot}\`

See FILING.md in repo templates/ea/ for Triage, Projects, and connectors layout.
`,
    "utf8",
  );
}
