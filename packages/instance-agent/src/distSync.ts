/**
 * Sync host bind-mounted dist/ from a pulled Joshu sandbox image.
 * Host ../dist overrides image dist in compose — this keeps them aligned after release updates.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export function shouldSyncDistFromImage(payload: Record<string, unknown>): boolean {
  return payload.syncDistFromImage !== false;
}

async function dockerCreate(imageRef: string): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["create", imageRef], { timeout: 120_000 });
  const cid = stdout.trim();
  if (!cid) throw new Error(`docker create returned empty id for ${imageRef}`);
  return cid;
}

async function dockerRemove(cid: string): Promise<void> {
  await execFileAsync("docker", ["rm", "-f", cid], { timeout: 60_000 });
}

async function dockerCp(cid: string, containerPath: string, hostDir: string): Promise<void> {
  await mkdir(hostDir, { recursive: true });
  await execFileAsync("docker", ["cp", `${cid}:${containerPath}/.`, `${hostDir}/`], {
    timeout: 600_000,
  });
}

async function inspectImageDigest(imageRef: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "--format", "{{index .RepoDigests 0}}", imageRef],
      { timeout: 60_000 },
    );
    const digest = stdout.trim();
    return digest || undefined;
  } catch {
    return undefined;
  }
}

async function readGitHead(installDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", installDir, "rev-parse", "HEAD"], {
      timeout: 30_000,
    });
    const ref = stdout.trim();
    return ref || undefined;
  } catch {
    return undefined;
  }
}

export async function syncDistFromImage(opts: {
  installDir: string;
  imageRef: string;
  version: string;
  gitRef?: string;
}): Promise<DistProvenance> {
  const { installDir, imageRef, version } = opts;
  const distDir = path.join(installDir, "dist");
  const boxStateDistDir = path.join(installDir, "packages", "box-state", "dist");

  console.info(`[instance-agent] syncing dist from ${imageRef} -> ${distDir}`);

  const cid = await dockerCreate(imageRef);
  try {
    await dockerCp(cid, "/opt/joshu/dist", distDir);
    try {
      await dockerCp(cid, "/opt/joshu/packages/box-state/dist", boxStateDistDir);
    } catch (err) {
      console.warn(
        `[instance-agent] box-state dist sync skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } finally {
    await dockerRemove(cid);
  }

  const provenance: DistProvenance = {
    version,
    imageRef,
    imageDigest: await inspectImageDigest(imageRef),
    distSource: "image-sync",
    syncedAt: new Date().toISOString(),
    gitRef: opts.gitRef ?? (await readGitHead(installDir)),
  };

  await writeFile(
    path.join(distDir, DIST_PROVENANCE_FILENAME),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { mode: 0o644 },
  );

  console.info(
    `[instance-agent] dist sync complete version=${version} gitRef=${provenance.gitRef ?? "unknown"}`,
  );
  return provenance;
}

export async function assertDistProvenanceMatches(
  installDir: string,
  expectedVersion: string,
): Promise<void> {
  const provenancePath = path.join(installDir, "dist", DIST_PROVENANCE_FILENAME);
  let raw: string;
  try {
    raw = await readFile(provenancePath, "utf8");
  } catch {
    throw new Error(`dist provenance missing at ${provenancePath} after sync`);
  }

  const provenance = JSON.parse(raw) as DistProvenance;
  if (provenance.version !== expectedVersion) {
    throw new Error(
      `dist provenance drift after sync: got ${provenance.version}, expected ${expectedVersion}`,
    );
  }

  const routesPath = path.join(installDir, "dist", "nylas", "routes.js");
  try {
    await readFile(routesPath, "utf8");
  } catch {
    throw new Error(`dist sync incomplete: missing ${routesPath}`);
  }
}
