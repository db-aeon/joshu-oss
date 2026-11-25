/**
 * Restart of the box in place, for single-container mode (change sandbox-box-commands).
 *
 * A box on a sandbox has no Docker, so the agent cannot recreate a container. Process 1 of
 * the container is the start script. When the agent sends it SIGUSR1, the start script stops
 * every other process of the box, starts itself again with the environment that the
 * container started with, and so reads the instance config again. The data root stays.
 *
 * The agent stops with the other processes, so it cannot acknowledge the command before the
 * restart. It writes the command to a pending file under /etc/joshu/secrets (on the data
 * root) first. The agent of the new start reads the file, waits until the box is healthy,
 * and acknowledges the command.
 *
 * A password reset of the desktop (set_aroz_password) also writes the hash of the new
 * password to a second pending file. The start script writes it into the ArozOS database
 * before ArozOS starts, because ArozOS holds the database while it runs, and writes the
 * result to a third file.
 */

/** The start script makes this file when it can restart in place: it is process 1 and has the SIGUSR1 handler. */
export const RESTART_READY_PATH = "/run/joshu-restart-ready";
export const PENDING_RESTART_PATH = "/etc/joshu/secrets/pending-restart-command.json";
export const PENDING_AROZ_PASSWORD_PATH = "/etc/joshu/secrets/pending-aroz-password.json";
export const AROZ_PASSWORD_RESULT_PATH = "/etc/joshu/secrets/aroz-password-result.json";
/** The start script writes the time of each start here (Unix seconds). */
export const STARTED_AT_PATH = "/run/joshu-started-at";

export type PendingRestart = {
  commandId: string;
  commandType: string;
  issuedAt: string;
  requestedAt: string;
};

export type RestartCommand = { id: string; type: string; issuedAt: string };

export type RestartDeps = {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  /** Write a file that only root can read. */
  writePrivate(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Send SIGUSR1 to process 1. */
  signalRestart(): void;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

/**
 * Ask process 1 for a restart in place. Process 1 stops this agent within seconds, so the
 * function returns only when the restart did not start within `waitMs`; it then removes the
 * pending files and throws. The start script runs the restart at the next step of its start,
 * so a box that is still starting can take some minutes.
 */
export async function requestRestart(
  cmd: RestartCommand,
  deps: RestartDeps,
  opts: { waitMs: number; password?: { user: string; hash: string }; before?: () => Promise<void> },
): Promise<never> {
  if (!(await deps.exists(RESTART_READY_PATH))) {
    throw new Error("this box cannot restart in place: its start script is not process 1 of the container, or it is from a release before this command");
  }
  // The changes of the command (for example the new secrets) come only after the check, so a
  // box that cannot restart in place keeps its state.
  await opts.before?.();
  await deps.remove(AROZ_PASSWORD_RESULT_PATH);
  if (opts.password) {
    await deps.writePrivate(PENDING_AROZ_PASSWORD_PATH, `${JSON.stringify({ user: opts.password.user, hash: opts.password.hash })}\n`);
  }
  const record: PendingRestart = {
    commandId: cmd.id,
    commandType: cmd.type,
    issuedAt: cmd.issuedAt,
    requestedAt: deps.now().toISOString(),
  };
  await deps.writePrivate(PENDING_RESTART_PATH, `${JSON.stringify(record)}\n`);
  deps.signalRestart();
  return waitThenCancel(deps, opts.waitMs);
}

/**
 * Wait for the restart; process 1 stops this agent when it starts. When this agent still runs
 * after `waitMs`, cancel: remove the pending files, so the start script ignores a signal that it
 * runs late, and fail the command.
 */
async function waitThenCancel(deps: Pick<RestartDeps, "sleep" | "remove">, waitMs: number): Promise<never> {
  await deps.sleep(Math.max(0, waitMs));
  await deps.remove(PENDING_RESTART_PATH);
  await deps.remove(PENDING_AROZ_PASSWORD_PATH);
  throw new Error(`the box did not restart within ${Math.round(waitMs / 1000)} seconds; the restart is cancelled`);
}

export async function hasPendingRestart(deps: Pick<RestartDeps, "readText">): Promise<boolean> {
  return (await deps.readText(PENDING_RESTART_PATH)) !== null;
}

export type RestartOutcome = { commandId: string; commandType: string; status: "succeeded" | "failed"; error?: string };

/**
 * Finish a command after the restart in place: wait until the box is healthy, and for a
 * password reset read the result that the start script wrote. Returns null when no command
 * is pending. The pending file is removed first, so a crash of this agent does not run the
 * same command again.
 */
export async function finishPendingRestart(
  deps: Pick<RestartDeps, "readText" | "remove" | "sleep" | "now">,
  waitHealthy: () => Promise<void>,
  opts: { waitMs: number },
): Promise<RestartOutcome | null> {
  const raw = await deps.readText(PENDING_RESTART_PATH);
  if (raw === null) return null;
  let pending: PendingRestart;
  try {
    pending = JSON.parse(raw) as PendingRestart;
  } catch {
    await deps.remove(PENDING_RESTART_PATH);
    return null;
  }
  if (!pending?.commandId || !pending.commandType) {
    await deps.remove(PENDING_RESTART_PATH);
    return null;
  }
  const requestedAt = Date.parse(pending.requestedAt);
  const startedAt = Number((await deps.readText(STARTED_AT_PATH))?.trim()) * 1000;
  if (!(Number.isFinite(startedAt) && Number.isFinite(requestedAt) && startedAt >= requestedAt)) {
    // This agent started again before the box restarted (for example after a crash): the
    // restart is still to come, so wait for it as the agent that asked for it would.
    const remaining = (Number.isFinite(requestedAt) ? requestedAt : 0) + opts.waitMs - deps.now().getTime();
    try {
      await waitThenCancel(deps, remaining);
    } catch (err) {
      return {
        commandId: pending.commandId,
        commandType: pending.commandType,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  await deps.remove(PENDING_RESTART_PATH);
  const outcome = (status: "succeeded" | "failed", error?: string): RestartOutcome => ({
    commandId: pending.commandId,
    commandType: pending.commandType,
    status,
    ...(error ? { error } : {}),
  });
  try {
    await waitHealthy();
  } catch (err) {
    return outcome("failed", `the box is not healthy after the restart: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (pending.commandType !== "set_aroz_password") return outcome("succeeded");
  const resultRaw = await deps.readText(AROZ_PASSWORD_RESULT_PATH);
  await deps.remove(AROZ_PASSWORD_RESULT_PATH);
  // The start script removes the pending password after it used it; a file that is still there was not used.
  await deps.remove(PENDING_AROZ_PASSWORD_PATH);
  if (resultRaw === null) return outcome("failed", "the start script wrote no result for the new desktop password");
  try {
    const result = JSON.parse(resultRaw) as { ok?: boolean; error?: string };
    return result.ok === true ? outcome("succeeded") : outcome("failed", `the new desktop password was not saved: ${result.error || "no reason"}`);
  } catch {
    return outcome("failed", "the result of the new desktop password cannot be read");
  }
}
