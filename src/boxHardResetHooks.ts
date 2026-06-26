/**
 * Cloud-side personal state cleared during hard factory reset.
 */
import { disconnectAllComposioConnections } from "./composioApi.js";

export type WipeConnectorCloudStateResult = Awaited<ReturnType<typeof disconnectAllComposioConnections>>;

/** Disconnect Composio OAuth connections so cron cannot re-sync mail after local wipe. */
export async function wipeConnectorCloudState(
  projectRoot = process.cwd(),
): Promise<WipeConnectorCloudStateResult> {
  return disconnectAllComposioConnections(projectRoot);
}
