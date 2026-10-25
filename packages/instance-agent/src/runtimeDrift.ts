/**
 * Runtime drift of a box (change image-owned-box-runtime, requirement "Instance agent
 * reports runtime drift"). The instance agent sees the host install directory and can
 * inspect the stack container through the Docker socket. The stack container cannot.
 * Informational only: runtime drift never changes `healthy` or `readyForUpdate`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 20;
/** The one host path that compose may mount into the stack container at or below /opt/joshu. */
const HOTFIX_OVERLAY_MOUNT = "/opt/joshu/hotfix/scripts";

export type RuntimeDriftKind = "host_mount" | "host_checkout" | "hotfix_file" | "host_bundle_version";

export type RuntimeDriftItem = { kind: RuntimeDriftKind; detail: string };

export type RuntimeDriftReport = {
  ok: boolean;
  checkedAt: string;
  items: RuntimeDriftItem[];
  /** Set when a scan step failed (the item list may be partial). */
  scanError?: string;
};

export type StackMount = { Type?: string; Source?: string; Destination?: string };

export type RuntimeDriftFacts = {
  /** Mounts of the stack container, or null when the container was not found. */
  stackMounts: StackMount[] | null;
  hostCheckout: boolean;
  /** Paths relative to the hotfix overlay. */
  hotfixFiles: string[];
  /** Version in deploy/.host-bundle.json, or null when the file is missing or invalid. */
  hostBundleVersion: string | null;
  releaseVersion: string;
};

function underOptJoshu(destination: string): boolean {
  const clean = path.posix.normalize(destination).replace(/\/+$/, "");
  return clean === "/opt/joshu" || clean.startsWith("/opt/joshu/");
}

/** Pure: list each item of runtime drift from the facts. */
export function evaluateRuntimeDrift(facts: RuntimeDriftFacts): RuntimeDriftItem[] {
  const items: RuntimeDriftItem[] = [];
  for (const mount of facts.stackMounts ?? []) {
    const destination = mount.Destination ?? "";
    if (mount.Type !== "bind" || !underOptJoshu(destination)) continue;
    if (path.posix.normalize(destination).replace(/\/+$/, "") === HOTFIX_OVERLAY_MOUNT) continue;
    items.push({ kind: "host_mount", detail: `${mount.Source ?? "?"} -> ${destination}` });
  }
  if (facts.hostCheckout) {
    items.push({ kind: "host_checkout", detail: "/opt/joshu/.git exists" });
  }
  for (const file of facts.hotfixFiles) {
    items.push({ kind: "hotfix_file", detail: file });
  }
  if (facts.hostBundleVersion === null) {
    items.push({ kind: "host_bundle_version", detail: "deploy/.host-bundle.json missing" });
  } else if (facts.hostBundleVersion !== facts.releaseVersion) {
    items.push({
      kind: "host_bundle_version",
      detail: `host bundle ${facts.hostBundleVersion}, release ${facts.releaseVersion || "?"}`,
    });
  }
  return items;
}

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, child)));
    else if (entry.name !== ".gitkeep") out.push(child);
  }
  return out.sort();
}

async function readHostBundleVersion(installDir: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(installDir, "deploy", ".host-bundle.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

async function inspectStackMounts(project: string): Promise<StackMount[] | null> {
  const { stdout: ids } = await execFileAsync(
    "docker",
    [
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      "label=com.docker.compose.service=joshu-stack",
    ],
    { timeout: 30_000 },
  );
  const id = ids.trim().split("\n").find(Boolean);
  if (!id) return null;
  const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{json .Mounts}}", id], {
    timeout: 30_000,
  });
  return JSON.parse(stdout) as StackMount[];
}

async function scanRuntimeDrift(opts: {
  installDir: string;
  releaseVersion: string;
  composeProject: string;
}): Promise<RuntimeDriftReport> {
  const errors: string[] = [];
  let stackMounts: StackMount[] | null = [];
  try {
    stackMounts = await inspectStackMounts(opts.composeProject);
    if (stackMounts === null) errors.push("stack container not found");
  } catch (err) {
    errors.push(`docker inspect: ${err instanceof Error ? err.message : String(err)}`);
  }
  const items = evaluateRuntimeDrift({
    stackMounts,
    hostCheckout: existsSync(path.join(opts.installDir, ".git")),
    hotfixFiles: await listFiles(path.join(opts.installDir, "hotfix", "scripts")),
    hostBundleVersion: await readHostBundleVersion(opts.installDir),
    releaseVersion: opts.releaseVersion,
  });
  return {
    ok: items.length === 0 && errors.length === 0,
    checkedAt: new Date().toISOString(),
    items: items.slice(0, MAX_ITEMS),
    ...(errors.length ? { scanError: errors.join("; ").slice(0, 400) } : {}),
  };
}

let cached: { at: number; key: string; report: RuntimeDriftReport } | null = null;

/** Cached for 10 minutes: the heartbeat runs every 30 seconds. */
export async function getRuntimeDrift(opts: {
  installDir: string;
  releaseVersion: string;
  composeProject?: string;
}): Promise<RuntimeDriftReport> {
  const scanOpts = { composeProject: "deploy", ...opts };
  const key = `${scanOpts.installDir}|${scanOpts.releaseVersion}`;
  if (cached && cached.key === key && Date.now() - cached.at < CACHE_TTL_MS) return cached.report;
  const report = await scanRuntimeDrift(scanOpts);
  cached = { at: Date.now(), key, report };
  return report;
}
