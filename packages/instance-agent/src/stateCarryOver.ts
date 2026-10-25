/**
 * Carry the Joshu state over a recreate of the stack container (change joshu-state-volume).
 *
 * Releases before the change kept the Joshu state (team memberships and team rooms,
 * proactive state, browser handoffs, SMS sessions, metered provider keys) in
 * `/opt/joshu/.joshu`, in the writable layer of the stack container. A recreate
 * throws that layer away. The new release reads the state from the Joshu state
 * folder in volume `joshu_arozos` (src/joshuStateDir.ts in the sandbox image).
 *
 * Before the agent recreates the stack, it runs the host bundle script
 * `deploy/scripts/carry-over-joshu-state.sh` in the running (old) stack container. The
 * prepare step of the update installs the host bundle of the target release, so the
 * script is there. A failure does not stop the update.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const CARRY_OVER_SCRIPT_REL = path.join("deploy", "scripts", "carry-over-joshu-state.sh");

export type CarryOverResult = { ok: boolean; lines: string[]; error?: string };

/**
 * Read the script from the host install directory and run it with `exec` (for example
 * `docker compose exec -T joshu-stack sh -c <script>`). Never throws: the update goes
 * on when the script is missing, the old container is down, or a copy fails.
 */
export async function carryOverJoshuState(
  installDir: string,
  exec: (script: string) => Promise<string>,
): Promise<CarryOverResult> {
  let script: string;
  try {
    script = await readFile(path.join(installDir, CARRY_OVER_SCRIPT_REL), "utf8");
  } catch (err) {
    return { ok: false, lines: [], error: `no carry-over script: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const out = await exec(script);
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    return { ok: !lines.some((l) => l.startsWith("failed ")), lines };
  } catch (err) {
    return { ok: false, lines: [], error: err instanceof Error ? err.message : String(err) };
  }
}
