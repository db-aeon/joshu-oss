import { execFile as execFileCb } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * The command line of process `pid`, with a space between the arguments, or "" when the
 * process does not exist. Reads /proc on Linux and uses `ps` on macOS (local development).
 */
export async function processCommandLine(pid: number): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    return raw.toString("utf8").split("\0").join(" ").trim();
  } catch {
    // No /proc entry: macOS, or the process does not exist.
  }
  try {
    const { stdout } = await execFile("ps", ["-ww", "-p", String(pid), "-o", "command="]);
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * True when process `pid` runs `command`. A PID file on a persistent volume can name a PID that
 * now belongs to a different process, so check this before a signal to a PID from a PID file.
 * The shell scripts use `pid_runs_command` in scripts/lib/pid-file.sh for the same check.
 */
export async function pidRunsCommand(pid: number, command: RegExp): Promise<boolean> {
  const cmdline = await processCommandLine(pid);
  return cmdline.length > 0 && command.test(cmdline);
}
