/**
 * Joshu state folder: the files that Joshu keeps for itself (not owner files), such as
 * the team memberships and team rooms, the proactive state, browser handoffs, SMS
 * sessions, and the metered provider keys.
 *
 * `JOSHU_STATE_DIR` sets the folder. The sandbox image sets it to
 * `/var/lib/arozos/joshu-state`, in volume `joshu_arozos`, so the state survives a
 * recreate of the stack container. Without the variable (local development, tests)
 * the folder is `<projectRoot>/.joshu`, as before.
 *
 * Before change joshu-state-volume the state was in `/opt/joshu/.joshu`, in the
 * writable layer of the container. The instance agent copies it into the volume
 * before it recreates the stack (packages/instance-agent/src/stateCarryOver.ts).
 * `migrateLegacyJoshuState` copies what is still in the old folder at boot.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Entries of `<projectRoot>/.joshu` that are Joshu state. Keep the same list in
 * packages/instance-agent/src/stateCarryOver.ts (a test checks it).
 */
export const JOSHU_STATE_ENTRIES = ["teams", "proactive", "browser-handoff", "sms", "connectors-providers.env"] as const;

export function legacyJoshuStateDir(projectRoot: string): string {
  return path.join(projectRoot, ".joshu");
}

export function joshuStateDir(projectRoot = process.cwd()): string {
  const explicit = process.env.JOSHU_STATE_DIR?.trim();
  return explicit ? path.resolve(explicit) : legacyJoshuStateDir(projectRoot);
}

function isEmptyDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

/**
 * Copy each Joshu state entry from `<projectRoot>/.joshu` to the Joshu state folder when
 * the Joshu state folder does not have it (or has only an empty folder). Never
 * overwrites state that is already in the Joshu state folder. Leaves the old copy.
 * Returns the names of the copied entries.
 */
export function migrateLegacyJoshuState(projectRoot: string): string[] {
  const from = legacyJoshuStateDir(projectRoot);
  const to = joshuStateDir(projectRoot);
  if (path.resolve(from) === path.resolve(to) || !fs.existsSync(from)) return [];
  const copied: string[] = [];
  for (const name of JOSHU_STATE_ENTRIES) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    try {
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest) && !isEmptyDir(dest)) continue;
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      fs.rmSync(dest, { recursive: true, force: true });
      const tmp = `${dest}.migrate-${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(src, tmp, { recursive: true, preserveTimestamps: true });
      fs.renameSync(tmp, dest);
      copied.push(name);
    } catch (err) {
      console.warn(`[joshu-state] could not copy ${src} to ${dest}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (copied.length > 0) console.info(`[joshu-state] copied ${copied.join(", ")} from ${from} to ${to}`);
  return copied;
}
