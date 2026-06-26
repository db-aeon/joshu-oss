/**
 * Post-wipe hooks for hard factory reset (Hindsight memory + gbrain reinit).
 */

import { restoreArozosDesktopFactory, type ArozosDesktopRestoreResult } from "./arozosDesktopRestore.js";
import { wipeConnectorsCloud } from "./connectorsWipe.js";
import { restartGbrainStack } from "./gbrainRestart.js";
import { wipeHindsightMemories } from "./hindsight.js";
import type { BoxPaths } from "./paths.js";

export interface HardResetPostResult {
  composio: Awaited<ReturnType<typeof wipeConnectorsCloud>>;
  desktop: ArozosDesktopRestoreResult;
  hindsight: Awaited<ReturnType<typeof wipeHindsightMemories>>;
  gbrain: Awaited<ReturnType<typeof restartGbrainStack>>;
}

/** Disconnect Composio OAuth before local wipe so mail cannot immediately re-sync. */
export async function runHardResetPreflight(paths: BoxPaths): Promise<HardResetPostResult["composio"]> {
  return wipeConnectorsCloud(paths.projectRoot);
}

/** Restore ArozOS desktop + shortcuts, clear Hindsight, rebuild gbrain after wipe. */
export async function runHardResetPostSteps(
  paths: BoxPaths,
): Promise<Omit<HardResetPostResult, "composio">> {
  const desktop = await restoreArozosDesktopFactory(paths);
  const hindsight = await wipeHindsightMemories(paths);
  const gbrain = await restartGbrainStack(paths.projectRoot, paths.gbrainHome);
  return { desktop, hindsight, gbrain };
}
