import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SyncState = {
  lastSyncAt?: string;
  lastError?: string;
  threadsWritten?: number;
  eventsWritten?: number;
  /** Gmail API historyId for GMAIL_LIST_HISTORY incremental sync (Composio). */
  historyId?: string;
  cursor?: string;
  connectedAccountId?: string;
  email?: string;
};

export async function readSyncState(filePath: string): Promise<SyncState> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as SyncState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function writeSyncState(filePath: string, state: SyncState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
