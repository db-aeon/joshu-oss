import os from "node:os";
import type { BoxPaths } from "../paths.js";
import { SNAPSHOT_GCS_KEY_FILE_ENV_VARS } from "../snapshotCreds.js";
import type { SnapshotStorageConfig } from "./types.js";

function envTrim(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

function parseMode(raw: string | undefined): "local" | "gcs" | "auto" {
  const mode = (raw ?? "auto").toLowerCase();
  if (mode === "local" || mode === "gcs" || mode === "auto") return mode;
  return "auto";
}

/** Box id used as GCS prefix segment — same owner can restore on a new VPS. */
export function resolveSnapshotBoxId(paths: BoxPaths): string {
  return (
    envTrim("JOSHU_SNAPSHOT_BOX_ID") ||
    envTrim("JOSHU_AROZ_USER") ||
    envTrim("JOSHU_OWNER_EMAIL") ||
    paths.arozUser ||
    envTrim("JOSHU_INSTANCE_ID") ||
    `local-${os.hostname()}`
  );
}

export function resolveSnapshotStorageConfig(paths: BoxPaths): SnapshotStorageConfig {
  const bucket = envTrim("JOSHU_SNAPSHOT_GCS_BUCKET");
  const mode = parseMode(envTrim("JOSHU_SNAPSHOT_STORAGE"));
  const resolvedMode =
    mode === "auto" ? (bucket ? "gcs" : "local") : mode === "gcs" && !bucket ? "local" : mode;

  return {
    mode: resolvedMode,
    boxId: resolveSnapshotBoxId(paths),
    localCacheDir: paths.snapshotDir,
    localCacheEnabled: envTrim("JOSHU_SNAPSHOT_LOCAL_CACHE") !== "false",
    gcsBucket: bucket,
    gcsPrefix: envTrim("JOSHU_SNAPSHOT_GCS_PREFIX") ?? "boxes/",
    gcsKeyFile: SNAPSHOT_GCS_KEY_FILE_ENV_VARS.map((name) => envTrim(name)).find(Boolean),
  };
}

export function gcsObjectPrefix(config: SnapshotStorageConfig, boxId: string): string {
  const base = config.gcsPrefix.endsWith("/") ? config.gcsPrefix : `${config.gcsPrefix}/`;
  return `${base}${boxId}/`;
}
