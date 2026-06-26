/**
 * Disconnect Composio cloud OAuth during hard factory reset.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

export type WipeConnectorsCloudResult = {
  ok: boolean;
  skipped?: boolean;
  userId?: string;
  disconnected?: string[];
  errors?: string[];
  error?: string;
};

type WipeHook = {
  wipeConnectorCloudState: (projectRoot: string) => Promise<WipeConnectorsCloudResult>;
};

/** Load compiled Joshu hook (Docker ships dist/, not src/). */
async function loadWipeHook(projectRoot: string): Promise<WipeHook> {
  const distHook = path.join(projectRoot, "dist/boxHardResetHooks.js");
  return (await import(pathToFileURL(distHook).href)) as WipeHook;
}

export async function wipeConnectorsCloud(projectRoot: string): Promise<WipeConnectorsCloudResult> {
  try {
    const { wipeConnectorCloudState } = await loadWipeHook(projectRoot);
    return wipeConnectorCloudState(projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, disconnected: [], errors: [], error: message };
  }
}
