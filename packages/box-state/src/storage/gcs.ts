import fs from "node:fs";
import path from "node:path";
import { Storage } from "@google-cloud/storage";
import type { SnapshotManifest } from "../snapshot.js";
import { gcsObjectPrefix } from "./config.js";
import type { SnapshotObjectMeta, SnapshotStorage, SnapshotStorageConfig } from "./types.js";

export class GcsSnapshotStorage implements SnapshotStorage {
  readonly id = "gcs";
  private client: Storage | null = null;

  constructor(private readonly config: SnapshotStorageConfig) {}

  get isConfigured(): boolean {
    return Boolean(this.config.gcsBucket);
  }

  private storage(): Storage {
    if (!this.client) {
      const opts: ConstructorParameters<typeof Storage>[0] = {};
      if (this.config.gcsKeyFile && fs.existsSync(this.config.gcsKeyFile)) {
        opts.keyFilename = this.config.gcsKeyFile;
      }
      this.client = new Storage(opts);
    }
    return this.client;
  }

  private bucket() {
    if (!this.config.gcsBucket) throw new Error("JOSHU_SNAPSHOT_GCS_BUCKET is not set");
    return this.storage().bucket(this.config.gcsBucket);
  }

  private archiveKey(snapshotId: string, boxId: string): string {
    return `${gcsObjectPrefix(this.config, boxId)}${snapshotId}.tar.gz`;
  }

  private manifestKey(snapshotId: string, boxId: string): string {
    return `${gcsObjectPrefix(this.config, boxId)}${snapshotId}.json`;
  }

  describe(): Record<string, string | boolean | undefined> {
    return {
      type: "gcs",
      bucket: this.config.gcsBucket,
      prefix: this.config.gcsPrefix,
      boxId: this.config.boxId,
      keyFile: this.config.gcsKeyFile,
    };
  }

  async putArchive(
    snapshotId: string,
    localArchivePath: string,
    boxId: string,
  ): Promise<SnapshotObjectMeta> {
    const key = this.archiveKey(snapshotId, boxId);
    await this.bucket().upload(localArchivePath, {
      destination: key,
      metadata: { contentType: "application/gzip" },
    });
    const [meta] = await this.bucket().file(key).getMetadata();
    return {
      snapshotId,
      storageKey: `gs://${this.config.gcsBucket}/${key}`,
      bytes: meta.size ? Number(meta.size) : undefined,
      updatedAt: meta.updated ?? new Date().toISOString(),
    };
  }

  async putManifest(manifest: SnapshotManifest, boxId: string): Promise<void> {
    const key = this.manifestKey(manifest.snapshotId, boxId);
    await this.bucket()
      .file(key)
      .save(JSON.stringify(manifest, null, 2) + "\n", {
        contentType: "application/json",
      });
  }

  async getManifest(snapshotId: string, boxId: string): Promise<SnapshotManifest | null> {
    const file = this.bucket().file(this.manifestKey(snapshotId, boxId));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return JSON.parse(buf.toString("utf8")) as SnapshotManifest;
  }

  async downloadArchive(snapshotId: string, destPath: string, boxId: string): Promise<void> {
    const file = this.bucket().file(this.archiveKey(snapshotId, boxId));
    const [exists] = await file.exists();
    if (!exists) {
      throw new Error(`GCS snapshot not found: gs://${this.config.gcsBucket}/${this.archiveKey(snapshotId, boxId)}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await file.download({ destination: destPath });
  }

  async list(boxId: string): Promise<SnapshotManifest[]> {
    const prefix = gcsObjectPrefix(this.config, boxId);
    const [files] = await this.bucket().getFiles({ prefix });
    const manifests: SnapshotManifest[] = [];
    for (const file of files) {
      if (!file.name.endsWith(".json")) continue;
      const [buf] = await file.download();
      manifests.push(JSON.parse(buf.toString("utf8")) as SnapshotManifest);
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
