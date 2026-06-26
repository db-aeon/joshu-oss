import type { SnapshotManifest } from "../snapshot.js";

export interface SnapshotObjectMeta {
  snapshotId: string;
  storageKey: string;
  bytes?: number;
  updatedAt?: string;
}

export interface SnapshotStorage {
  readonly id: string;
  isConfigured: boolean;
  describe(): Record<string, string | boolean | undefined>;
  putArchive(snapshotId: string, localArchivePath: string, boxId: string): Promise<SnapshotObjectMeta>;
  putManifest(manifest: SnapshotManifest, boxId: string): Promise<void>;
  getManifest(snapshotId: string, boxId: string): Promise<SnapshotManifest | null>;
  downloadArchive(snapshotId: string, destPath: string, boxId: string): Promise<void>;
  list(boxId: string): Promise<SnapshotManifest[]>;
}

export interface SnapshotStorageConfig {
  mode: "local" | "gcs" | "auto";
  boxId: string;
  localCacheDir: string;
  localCacheEnabled: boolean;
  gcsBucket?: string;
  gcsPrefix: string;
  gcsKeyFile?: string;
}
