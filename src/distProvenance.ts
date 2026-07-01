/**
 * Host bind-mounted dist/ provenance — written by instance-agent after image sync.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";

export const DIST_PROVENANCE_FILENAME = ".release-provenance.json";

export type DistProvenanceSource = "image-sync" | "artifact" | "manual";

export interface DistProvenance {
  version: string;
  imageRef: string;
  imageDigest?: string;
  distSource: DistProvenanceSource;
  syncedAt: string;
  gitRef?: string;
}

export function distProvenancePath(projectRoot = process.cwd()): string {
  return path.join(projectRoot, "dist", DIST_PROVENANCE_FILENAME);
}

export async function readDistProvenance(projectRoot = process.cwd()): Promise<DistProvenance | null> {
  try {
    const raw = await readFile(distProvenancePath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as DistProvenance;
    if (typeof parsed.version !== "string" || typeof parsed.syncedAt !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export interface DistProvenanceStatus {
  ok: boolean;
  status: "unknown" | "synced" | "drift" | "updating";
  version?: string;
  expected?: string;
  syncedAt?: string;
  imageRef?: string;
}

/** Compare host dist provenance to JOSHU_RELEASE_VERSION. Missing provenance is ok (legacy boxes). */
export function evaluateDistProvenance(
  provenance: DistProvenance | null,
  expectedVersion: string,
): DistProvenanceStatus {
  if (!provenance) {
    return { ok: true, status: "unknown" };
  }
  if (provenance.version === expectedVersion) {
    return {
      ok: true,
      status: "synced",
      version: provenance.version,
      expected: expectedVersion,
      syncedAt: provenance.syncedAt,
      imageRef: provenance.imageRef,
    };
  }
  return {
    ok: false,
    status: "drift",
    version: provenance.version,
    expected: expectedVersion,
    syncedAt: provenance.syncedAt,
    imageRef: provenance.imageRef,
  };
}

export async function distRoutesPresent(projectRoot = process.cwd()): Promise<boolean> {
  try {
    await access(path.join(projectRoot, "dist", "nylas", "routes.js"));
    return true;
  } catch {
    return false;
  }
}
