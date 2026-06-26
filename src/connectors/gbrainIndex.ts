/**
 * Queue gbrain reindex after connector mirror writes. The MCP bridge auto-commits
 * `${AROZ_DATA}/files/users/` (git add -A) before each sync_brain — see gbrain-desktop-git.mjs.
 */
import { requestBrainReindex } from "../brainApi.js";

/** After connector sync writes markdown, nudge debounced sync_brain via MCP touch file. */
export async function finalizeConnectorSyncForGbrain(
  _projectRoot: string,
  result: { ok: boolean; skipped?: boolean; threadsWritten: number; eventsWritten: number },
): Promise<{ ok: boolean } | null> {
  if (!result.ok || result.skipped) return null;
  if (result.threadsWritten === 0 && result.eventsWritten === 0) return null;

  const reindex = requestBrainReindex();
  if (!reindex.ok) {
    console.warn(`[connectors/gbrain] reindex touch failed: ${reindex.error}`);
    return { ok: false };
  }
  return { ok: true };
}
