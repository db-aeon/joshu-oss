import fs from "node:fs";
import path from "node:path";
import type { SnapshotManifest } from "../snapshot.js";
import type { SnapshotObjectMeta, SnapshotStorage } from "./types.js";

/** Local directory cache (fast restore; optional when GCS is primary). */
export class LocalSnapshotStorage implements SnapshotStorage {
  readonly id = "local";

  constructor(private readonly rootDir: string) {}

  get isConfigured(): boolean {
    return true;
  }

  describe(): Record<string, string | boolean | undefined> {
    return { type: "local", path: this.rootDir };
  }

  putArchive(snapshotId: string, localArchivePath: string, _boxId: string): Promise<SnapshotObjectMeta> {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const dest = path.join(this.rootDir, `${snapshotId}.tar.gz`);
    if (path.resolve(localArchivePath) !== path.resolve(dest)) {
      fs.copyFileSync(localArchivePath, dest);
    }
    const bytes = fs.statSync(dest).size;
    return Promise.resolve({
      snapshotId,
      storageKey: dest,
      bytes,
      updatedAt: new Date().toISOString(),
    });
  }

  putManifest(manifest: SnapshotManifest, _boxId: string): Promise<void> {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.rootDir, `${manifest.snapshotId}.json`),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return Promise.resolve();
  }

  getManifest(snapshotId: string, _boxId: string): Promise<SnapshotManifest | null> {
    const metaPath = path.join(this.rootDir, `${snapshotId}.json`);
    if (!fs.existsSync(metaPath)) return Promise.resolve(null);
    return Promise.resolve(JSON.parse(fs.readFileSync(metaPath, "utf8")) as SnapshotManifest);
  }

  downloadArchive(snapshotId: string, destPath: string, _boxId: string): Promise<void> {
    const src = path.join(this.rootDir, `${snapshotId}.tar.gz`);
    if (!fs.existsSync(src)) {
      throw new Error(`Local snapshot archive not found: ${src}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(src, destPath);
    return Promise.resolve();
  }

  list(_boxId: string): Promise<SnapshotManifest[]> {
    if (!fs.existsSync(this.rootDir)) return Promise.resolve([]);
    return Promise.resolve(
      fs
        .readdirSync(this.rootDir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => JSON.parse(fs.readFileSync(path.join(this.rootDir, n), "utf8")) as SnapshotManifest)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }
}
