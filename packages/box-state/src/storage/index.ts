import fs from "node:fs";
import path from "node:path";
import type { BoxPaths } from "../paths.js";
import type { SnapshotManifest } from "../snapshot.js";
import { gcsObjectPrefix, resolveSnapshotBoxId, resolveSnapshotStorageConfig } from "./config.js";
import { GcsSnapshotStorage } from "./gcs.js";
import { LocalSnapshotStorage } from "./local.js";
import type { SnapshotStorage, SnapshotStorageConfig } from "./types.js";

export interface ResolvedSnapshotStorage {
  config: SnapshotStorageConfig;
  primary: SnapshotStorage;
  local: LocalSnapshotStorage;
  gcs: GcsSnapshotStorage | null;
  /** Extra box ids to search when listing/restoring (e.g. shared templates). */
  searchBoxIds: string[];
}

export function resolveSnapshotStorage(paths: BoxPaths): ResolvedSnapshotStorage {
  const config = resolveSnapshotStorageConfig(paths);
  const local = new LocalSnapshotStorage(config.localCacheDir);
  const gcs = config.gcsBucket ? new GcsSnapshotStorage(config) : null;
  const primary = config.mode === "gcs" && gcs ? gcs : local;

  const searchBoxIds = [config.boxId];
  const shared = process.env.JOSHU_SNAPSHOT_SHARED_BOX_ID?.trim() || "shared";
  if (!searchBoxIds.includes(shared)) searchBoxIds.push(shared);

  return { config, primary, local, gcs, searchBoxIds };
}

export function describeSnapshotStorage(resolved: ResolvedSnapshotStorage): Record<string, unknown> {
  return {
    mode: resolved.config.mode,
    boxId: resolved.config.boxId,
    localCacheDir: resolved.config.localCacheDir,
    localCacheEnabled: resolved.config.localCacheEnabled,
    primary: resolved.primary.describe(),
    sharedBoxId: resolved.searchBoxIds.find((id) => id !== resolved.config.boxId),
  };
}

async function findManifest(
  resolved: ResolvedSnapshotStorage,
  snapshotId: string,
  preferredBoxId?: string,
): Promise<{ manifest: SnapshotManifest; boxId: string } | null> {
  const boxIds = preferredBoxId
    ? [preferredBoxId, ...resolved.searchBoxIds.filter((id) => id !== preferredBoxId)]
    : resolved.searchBoxIds;

  for (const boxId of boxIds) {
    const localMeta = await resolved.local.getManifest(snapshotId, boxId);
    if (localMeta) return { manifest: localMeta, boxId };

    if (resolved.gcs) {
      const remoteMeta = await resolved.gcs.getManifest(snapshotId, boxId);
      if (remoteMeta) return { manifest: remoteMeta, boxId };
    }
  }
  return null;
}

export async function persistSnapshot(
  resolved: ResolvedSnapshotStorage,
  manifest: SnapshotManifest,
  archivePath: string,
  options: { targetBoxId?: string } = {},
): Promise<SnapshotManifest> {
  const boxId = options.targetBoxId ?? resolved.config.boxId;
  const archiveMeta = await resolved.primary.putArchive(manifest.snapshotId, archivePath, boxId);

  const enriched: SnapshotManifest = {
    ...manifest,
    storageBoxId: boxId,
    storageBackend: resolved.primary.id,
    storageKey: archiveMeta.storageKey,
    components: [
      ...manifest.components.filter((c) => c.name !== "archive"),
      {
        name: "archive",
        path: `${manifest.snapshotId}.tar.gz`,
        sha256:
          manifest.components.find((c) => c.name === "archive")?.sha256 ?? "",
        bytes: archiveMeta.bytes ?? 0,
      },
    ],
  };

  await resolved.primary.putManifest(enriched, boxId);

  if (resolved.config.localCacheEnabled && resolved.primary.id !== "local") {
    await resolved.local.putArchive(manifest.snapshotId, archivePath, boxId);
    await resolved.local.putManifest(enriched, boxId);
  }

  return enriched;
}

export async function ensureArchiveLocal(
  resolved: ResolvedSnapshotStorage,
  snapshotId: string,
  preferredBoxId?: string,
): Promise<{ archivePath: string; manifest: SnapshotManifest; boxId: string }> {
  const found = await findManifest(resolved, snapshotId, preferredBoxId);
  if (!found) {
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  const archivePath = path.join(resolved.config.localCacheDir, `${snapshotId}.tar.gz`);
  if (fs.existsSync(archivePath)) {
    return { archivePath, manifest: found.manifest, boxId: found.boxId };
  }

  fs.mkdirSync(resolved.config.localCacheDir, { recursive: true });

  if (resolved.gcs) {
    await resolved.gcs.downloadArchive(snapshotId, archivePath, found.boxId);
    return { archivePath, manifest: found.manifest, boxId: found.boxId };
  }

  await resolved.local.downloadArchive(snapshotId, archivePath, found.boxId);
  return { archivePath, manifest: found.manifest, boxId: found.boxId };
}

export async function listAllSnapshots(resolved: ResolvedSnapshotStorage): Promise<SnapshotManifest[]> {
  const byId = new Map<string, SnapshotManifest>();

  if (resolved.gcs && resolved.config.mode === "gcs") {
    for (const boxId of resolved.searchBoxIds) {
      for (const m of await resolved.gcs.list(boxId)) {
        byId.set(`${m.storageBoxId ?? boxId}:${m.snapshotId}`, { ...m, storageBoxId: m.storageBoxId ?? boxId });
      }
    }
  }

  for (const boxId of resolved.searchBoxIds) {
    for (const m of await resolved.local.list(boxId)) {
      const key = `${m.storageBoxId ?? boxId}:${m.snapshotId}`;
      if (!byId.has(key)) byId.set(key, { ...m, storageBoxId: m.storageBoxId ?? boxId });
    }
  }

  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export { gcsObjectPrefix, resolveSnapshotBoxId, resolveSnapshotStorageConfig };
