import fs from "node:fs";

/**
 * Env vars that can point at the GCS service-account key, in resolution order.
 * Shared with `storage/config.ts` so the "which key file?" logic lives in one place.
 */
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
  /** Human-readable explanation, always set for the non-trivial cases. */
  reason?: string;
}

/** Getter over an env source (process.env, a parsed instance.env, etc.). */
export type EnvGetter = (name: string) => string | undefined;

function firstConfigured(get: EnvGetter, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Cheap, side-effect-free check of whether a GCS snapshot is likely to succeed —
 * deliberately mirrors the philosophy of the registry-auth probe (validate config,
 * don't perform the operation). Callers pass their own env source so this works
 * from the joshu app (process.env / instance.env) and the agent alike.
 *
 * Semantics:
 * - No bucket → snapshots are not configured; `ok:true` (nothing to block on).
 * - Bucket set, no SA key path → relying on ambient/ADC creds we can't verify
 *   cheaply; `ok:true` (don't block; the actual snap will surface real failures).
 * - Bucket set + SA key path that is missing/unreadable/not valid JSON/missing
 *   client_email or private_key → `ok:false` (this is the exact misconfiguration
 *   that silently blocked a managed update: a key path pointing at a nonexistent file).
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
    const raw = fs.readFileSync(keyFile, "utf8");
    const json = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown };
    if (typeof json.client_email !== "string" || typeof json.private_key !== "string") {
      return {
        configured: true,
        ok: false,
        reason: `SA key ${keyFile} is missing client_email/private_key`,
      };
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
