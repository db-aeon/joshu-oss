import fs from "node:fs";
import path from "node:path";
import {
  applyFactorySeeds,
  applyFactoryStructure,
  loadFactoryManifest,
  loadReleaseVersion,
  writeLocationHint,
} from "./manifest.js";
import type { BoxPaths } from "./paths.js";
import { hermesUserSnapshotPaths } from "./paths.js";
import { describeSnapshotStorage, resolveSnapshotStorage } from "./storage/index.js";

export interface BoxStatus {
  releaseVersion: string;
  factoryManifest: string;
  paths: BoxPaths;
  storage: Record<string, unknown>;
  factory: {
    seedsInRepo: string[];
    structureDirs: string[];
  };
  personal: {
    userHome: string;
    hermesUserPaths: string[];
    hindsightEnabled: boolean;
    gbrainHome: string;
    snapshots: string[];
  };
}

export function getBoxStatus(paths: BoxPaths): BoxStatus {
  const manifest = loadFactoryManifest(paths.factoryManifest);
  const snapshots: string[] = [];
  if (fs.existsSync(paths.snapshotDir)) {
    for (const name of fs.readdirSync(paths.snapshotDir)) {
      if (name.endsWith(".json")) snapshots.push(name.replace(/\.json$/, ""));
    }
  }
  snapshots.sort().reverse();

  return {
    releaseVersion: loadReleaseVersion(paths.releaseJson),
    factoryManifest: paths.factoryManifest,
    paths,
    storage: describeSnapshotStorage(resolveSnapshotStorage(paths)),
    factory: {
      seedsInRepo: manifest.seeds.map((s) => s.from),
      structureDirs: manifest.structure.map((s) =>
        s.replace("{files_root}", paths.filesRoot),
      ),
    },
    personal: {
      userHome: paths.userHome,
      hermesUserPaths: hermesUserSnapshotPaths(paths.hermesHome),
      hindsightEnabled: Boolean(paths.hindsightDatabaseUrl),
      gbrainHome: paths.gbrainHome,
      snapshots,
    },
  };
}

export interface FactoryApplyResult {
  seeded: string[];
  skipped: string[];
  structureCreated: string[];
}

/** Soft factory apply — seed missing files and dirs; does not wipe user data. */
export function factoryApplySoft(paths: BoxPaths): FactoryApplyResult {
  const manifest = loadFactoryManifest(paths.factoryManifest);
  fs.mkdirSync(paths.filesRoot, { recursive: true });
  writeLocationHint(paths.filesRoot);

  const { seeded, skipped } = applyFactorySeeds(paths.projectRoot, paths.filesRoot, manifest.seeds);
  const structureCreated = applyFactoryStructure(manifest.structure, paths.filesRoot);

  return { seeded, skipped, structureCreated };
}

/** Remove personal state paths before soft re-apply (hard reset). */
export function factoryWipePersonal(paths: BoxPaths, manifestPath: string): string[] {
  const removed: string[] = [];
  const manifest = loadFactoryManifest(manifestPath);

  const wipePath = (target: string) => {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  };

  /** GBRAIN_HOME is a Docker volume mount on VPS — wipe contents, not the mount root. */
  const wipeGbrainHome = (gbrainHome: string) => {
    if (!fs.existsSync(gbrainHome)) return;
    for (const entry of fs.readdirSync(gbrainHome)) {
      wipePath(path.join(gbrainHome, entry));
    }
  };

  // Wipe every ArozOS sandbox user (local dev may have admin + owner accounts).
  const usersRoot = path.join(paths.arozData, "files", "users");
  if (fs.existsSync(usersRoot)) {
    for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const userHome = path.join(usersRoot, entry.name);
      for (const child of fs.readdirSync(userHome)) {
        wipePath(path.join(userHome, child));
      }
    }
  } else if (fs.existsSync(paths.userHome)) {
    for (const entry of fs.readdirSync(paths.userHome)) {
      wipePath(path.join(paths.userHome, entry));
    }
  }

  for (const p of hermesUserSnapshotPaths(paths.hermesHome)) {
    wipePath(p);
  }
  wipePath(path.join(paths.hermesHome, "config.user.yaml"));

  if (manifest.gbrain.rebuild_on_restore) {
    wipeGbrainHome(paths.gbrainHome);
  }

  // Identity defaults restored by caller if needed
  return removed;
}

export function writeDefaultIdentity(paths: BoxPaths, manifestPath: string): void {
  const manifest = loadFactoryManifest(manifestPath);
  const identityDir = path.join(paths.userHome, ".joshu");
  fs.mkdirSync(identityDir, { recursive: true });
  const identityPath = path.join(identityDir, "identity.json");
  const payload = {
    schemaVersion: 1,
    ...manifest.identity.defaults,
    updatedAt: new Date().toISOString(),
    source: "factory-reset",
  };
  fs.writeFileSync(identityPath, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
}
