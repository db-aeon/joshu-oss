/**
 * Single-container mode (change single-container-mode): the instance agent runs as a
 * process inside the stack container, on a host with no Docker.
 *
 * - Commands that need no Docker run as on a Compose host: they call the Joshu API or send
 *   mail, and the diagnostics command reads files and processes of this container.
 * - Commands that need a restart of the box (restart, rotate_secrets, set_aroz_password) run
 *   with a restart in place: process 1 stops the other processes of the container and starts
 *   the box again (change sandbox-box-commands, file inPlaceRestart.ts).
 * - A release update, a rollback, and a deprovision need the API of the host of the sandbox,
 *   which the box has no key for. The agent answers each of them with an error.
 */

/** Commands that run as on a Compose host. */
export const SINGLE_CONTAINER_COMMANDS: ReadonlySet<string> = new Set([
  "sync_companion_identity",
  "send_owner_email",
  "desktop_login",
  "diagnostics",
]);

/** Commands that run with a restart of the box in place. */
export const IN_PLACE_RESTART_COMMANDS: ReadonlySet<string> = new Set(["restart", "rotate_secrets", "set_aroz_password"]);

export const UNSUPPORTED_IN_SINGLE_CONTAINER_MODE = "unsupported_in_single_container_mode";

/** The start script sets JOSHU_SINGLE_CONTAINER=1 when JOSHU_DATA_ROOT is set. */
export function singleContainerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JOSHU_SINGLE_CONTAINER?.trim() === "1";
}

/**
 * Throws before a command that single-container mode cannot run, so the command changes
 * nothing on the box and the control plane gets the error in the command ack.
 */
export function assertCommandSupported(type: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!singleContainerMode(env) || SINGLE_CONTAINER_COMMANDS.has(type) || IN_PLACE_RESTART_COMMANDS.has(type)) return;
  throw new Error(
    `${UNSUPPORTED_IN_SINGLE_CONTAINER_MODE}: command ${type} needs the API of the host of the sandbox, and this box runs in single-container mode. ` +
      "An operator runs it from outside the box, for example a release update with scripts/deploy-release.mjs",
  );
}
