/**
 * Replace the instance agent container in a release update (change agent-self-replace).
 *
 * Compose recreates a service in this order: create the new container, stop the old one,
 * remove it, rename and start the new one. When compose runs inside the old agent
 * container, the stop kills compose too, and the new container stays "Created". So the
 * agent starts the agent replace helper, a container outside the compose project, and the
 * helper runs the recreate.
 */

import path from "node:path";

export const AGENT_REPLACE_HELPER_NAME = "joshu-agent-replace";
const HELPER_TIMEOUT_MS = 5 * 60_000;
const HELPER_POLL_MS = 2_000;
const HELPER_LOG_LINES = 40;

export interface AgentReplaceOptions {
  /** Agent image of the target release; the prepare step has pulled it. */
  agentImageRef: string;
  composeFile: string;
  composeEnvFile: string;
  installDir: string;
  /** Compose variables of this agent that the helper needs. Never secrets. */
  composeProfiles?: string;
  composeProjectName?: string;
  timeoutMs?: number;
  pollMs?: number;
}

export interface AgentReplaceDeps {
  /** Runs `docker <args>` and returns stdout; throws when docker exits non-zero. */
  docker: (args: string[]) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

/** Arguments of `docker run` for the agent replace helper. */
export function agentReplaceRunArgs(opts: AgentReplaceOptions): string[] {
  // Same paths inside the helper, so compose reads the same compose file and instance.env.
  const mounts = new Set([opts.installDir, path.dirname(opts.composeFile), path.dirname(opts.composeEnvFile)]);
  for (const dir of [...mounts]) {
    if ([...mounts].some((other) => other !== dir && dir.startsWith(`${other}/`))) mounts.delete(dir);
  }
  const args = [
    "run",
    "-d",
    "--name",
    AGENT_REPLACE_HELPER_NAME,
    "--label",
    "joshu.role=agent-replace",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
  ];
  for (const dir of mounts) args.push("-v", `${dir}:${dir}:ro`);
  args.push("-e", `JOSHU_COMPOSE_ENV_FILE=${opts.composeEnvFile}`);
  if (opts.composeProfiles) args.push("-e", `COMPOSE_PROFILES=${opts.composeProfiles}`);
  if (opts.composeProjectName) args.push("-e", `COMPOSE_PROJECT_NAME=${opts.composeProjectName}`);
  args.push(
    "--entrypoint",
    "docker",
    opts.agentImageRef,
    "compose",
    "-f",
    opts.composeFile,
    "--env-file",
    opts.composeEnvFile,
    "up",
    "-d",
    "--no-deps",
    "--force-recreate",
    "instance-agent",
  );
  return args;
}

/** Remove the helper. Without force, docker refuses a helper that still runs. */
export async function removeAgentReplaceHelper(
  deps: Pick<AgentReplaceDeps, "docker" | "log">,
  force: boolean,
): Promise<void> {
  try {
    await deps.docker(["rm", ...(force ? ["-f"] : []), AGENT_REPLACE_HELPER_NAME]);
    deps.log(`removed the agent replace helper ${AGENT_REPLACE_HELPER_NAME}`);
  } catch {
    // No helper, or a helper that still runs (without force).
  }
}

async function helperLogTail(deps: AgentReplaceDeps): Promise<string> {
  try {
    const out = await deps.docker(["logs", "--tail", String(HELPER_LOG_LINES), AGENT_REPLACE_HELPER_NAME]);
    return out.trim() || "(no output)";
  } catch (err) {
    return `(no log: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Start the agent replace helper and wait until compose stops this agent.
 * On success this function never returns, because compose stops the container of the caller.
 * It throws when the helper exits or hangs while this agent still runs.
 */
export async function replaceAgentContainer(opts: AgentReplaceOptions, deps: AgentReplaceDeps): Promise<never> {
  const timeoutMs = opts.timeoutMs ?? HELPER_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? HELPER_POLL_MS;
  // A helper of an earlier update stays until the next agent removes it.
  await removeAgentReplaceHelper(deps, true);
  await deps.docker(agentReplaceRunArgs(opts));
  deps.log(`started agent replace helper ${AGENT_REPLACE_HELPER_NAME} (${opts.agentImageRef}); waiting for compose to stop this agent`);

  const deadline = deps.now() + timeoutMs;
  for (;;) {
    await deps.sleep(pollMs);
    let state = "";
    try {
      state = (await deps.docker(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", AGENT_REPLACE_HELPER_NAME])).trim();
    } catch {
      state = "missing";
    }
    const [status, exitCode] = state.split(/\s+/);
    if (status !== "running" && status !== "created") {
      const logs = await helperLogTail(deps);
      await removeAgentReplaceHelper(deps, true);
      throw new Error(
        `agent replace helper ended (${status}${exitCode ? `, exit ${exitCode}` : ""}) but this agent still runs: ${logs}`,
      );
    }
    if (deps.now() >= deadline) {
      const logs = await helperLogTail(deps);
      await removeAgentReplaceHelper(deps, true);
      throw new Error(`agent replace helper still ran after ${Math.round(timeoutMs / 1000)}s: ${logs}`);
    }
  }
}

export interface AgentStartSteps {
  hasPendingUpdate: () => Promise<boolean>;
  register: () => Promise<void>;
  /** Resumes and acks the pending update. */
  resumePendingUpdate: () => Promise<void>;
  removeHelper: () => Promise<void>;
  startHeartbeat: () => Promise<void>;
}

/**
 * Start order of the instance agent. With a pending update file, skip register: the control
 * plane sets status bootstrapping on register, and the deploy workflow reads that status on
 * the old release as a rollback while the update still runs.
 */
export async function startInstanceAgent(steps: AgentStartSteps): Promise<void> {
  if (await steps.hasPendingUpdate()) {
    await steps.resumePendingUpdate();
    await steps.removeHelper();
  } else {
    await steps.register();
  }
  await steps.startHeartbeat();
}
