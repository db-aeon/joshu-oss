import { readFileSync } from "node:fs";

/**
 * Snapshot GCS credential validation for the agent.
 *
 * NOTE: intentionally a small, self-contained mirror of
 * `@joshu/box-state`'s `evaluateSnapshotCredStatus`. The instance-agent is built as
 * an isolated artifact (see deploy/Dockerfile.instance-agent — it copies ONLY
 * packages/instance-agent and has no workspace deps), so it can't import box-state.
 * Keep the two in sync if the resolution order or validation changes.
 */

/** Env vars that can point at the GCS service-account key, in resolution order. */
export const SNAPSHOT_GCS_KEY_FILE_ENV_VARS = [
  "JOSHU_SNAPSHOT_GCS_KEY_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "HINDSIGHT_API_RERANKER_GOOGLE_SERVICE_ACCOUNT_KEY",
] as const;

export interface SnapshotCredStatus {
  /** A GCS bucket is configured, so a pre-update/backup snapshot will actually run. */
  configured: boolean;
  /** Snapshot credentials are usable (or no snapshot is needed). */
  ok: boolean;
  reason?: string;
}

export type EnvGetter = (name: string) => string | undefined;

function firstConfigured(get: EnvGetter, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Cheap, side-effect-free check of whether a GCS snapshot is likely to succeed.
 * - No bucket → not configured; ok:true (nothing to snapshot).
 * - Bucket, no SA key path → ambient/ADC creds we can't verify; ok:true.
 * - Bucket + SA key path missing/unreadable/invalid JSON/missing fields → ok:false.
 */
export function evaluateSnapshotCredStatus(get: EnvGetter): SnapshotCredStatus {
  const bucket = get("JOSHU_SNAPSHOT_GCS_BUCKET")?.trim();
  if (!bucket) {
    return { configured: false, ok: true, reason: "no JOSHU_SNAPSHOT_GCS_BUCKET (snapshot skipped)" };
  }

  const keyFile = firstConfigured(get, SNAPSHOT_GCS_KEY_FILE_ENV_VARS);
  if (!keyFile) {
    return { configured: true, ok: true, reason: "no SA key path set; relying on ambient credentials" };
  }

  try {
    const raw = readFileSync(keyFile, "utf8");
    const json = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown };
    if (typeof json.client_email !== "string" || typeof json.private_key !== "string") {
      return { configured: true, ok: false, reason: `SA key ${keyFile} is missing client_email/private_key` };
    }
    return { configured: true, ok: true };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      reason: `SA key ${keyFile} unreadable or not valid JSON: ${(err as Error).message}`,
    };
  }
}
