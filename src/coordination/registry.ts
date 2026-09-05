import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { connectorStatePath } from "../connectors/paths.js";
import type { ActiveCoordination, CoordinationCapability, CoordinationChannel } from "./types.js";

const REGISTRY_NAME = "coordination-active.json";

type CoordinationRegistryState = {
  entries: ActiveCoordination[];
};

function registryPath(filesRoot: string): string {
  return connectorStatePath(filesRoot, REGISTRY_NAME);
}

async function readRegistry(filesRoot: string): Promise<CoordinationRegistryState> {
  try {
    const raw = await readFile(registryPath(filesRoot), "utf8");
    const parsed = JSON.parse(raw) as CoordinationRegistryState;
    return parsed?.entries ? parsed : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

async function writeRegistry(filesRoot: string, state: CoordinationRegistryState): Promise<void> {
  const filePath = registryPath(filesRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Persist active coordination after successful task create. */
export async function registerCoordination(opts: {
  filesRoot: string;
  scopeId: string;
  capability: CoordinationCapability;
  board: string;
  task_id: string;
  channel: CoordinationChannel;
}): Promise<void> {
  const state = await readRegistry(opts.filesRoot);
  const created_at = new Date().toISOString();
  const withoutDup = state.entries.filter(
    (e) => !(e.board === opts.board && e.task_id === opts.task_id),
  );
  withoutDup.push({
    scopeId: opts.scopeId,
    capability: opts.capability,
    board: opts.board,
    task_id: opts.task_id,
    channel: opts.channel,
    created_at,
  });
  await writeRegistry(opts.filesRoot, { entries: withoutDup });
}

/** Remove registry entry when task completes (best-effort). */
export async function unregisterCoordination(opts: {
  filesRoot: string;
  board: string;
  task_id: string;
}): Promise<void> {
  const state = await readRegistry(opts.filesRoot);
  const next = state.entries.filter(
    (e) => !(e.board === opts.board && e.task_id === opts.task_id),
  );
  if (next.length === state.entries.length) return;
  await writeRegistry(opts.filesRoot, { entries: next });
}

export async function listRegistryForScope(
  filesRoot: string,
  scopeId: string,
): Promise<ActiveCoordination[]> {
  const state = await readRegistry(filesRoot);
  return state.entries.filter((e) => e.scopeId === scopeId);
}

export async function listAllRegistryEntries(filesRoot: string): Promise<ActiveCoordination[]> {
  const state = await readRegistry(filesRoot);
  return state.entries;
}
