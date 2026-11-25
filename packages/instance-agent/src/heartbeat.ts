/**
 * Schedule of the heartbeat rounds of the instance agent.
 *
 * A round that fails must not end the loop. Before this module, a network error in a round
 * was an unhandled rejection that stopped the agent process, and a response that was not ok
 * returned before the next round was scheduled, so the agent stopped sending heartbeats
 * until it restarted.
 */

export interface HeartbeatLoopDeps {
  /**
   * One heartbeat round. Returns the delay in milliseconds before the next round, or
   * undefined to use the fallback delay. A thrown error counts as a failed round.
   */
  round: () => Promise<number | undefined>;
  /** Delay in milliseconds after a failed round, or when the round returns no delay. */
  fallbackMs: number;
  schedule: (fn: () => void, ms: number) => void;
  warn: (message: string) => void;
}

/**
 * Runs one round, then schedules the next round. The returned promise never rejects, so
 * the caller can await the first round.
 */
export async function runHeartbeatLoop(deps: HeartbeatLoopDeps): Promise<void> {
  let delayMs = deps.fallbackMs;
  try {
    const next = await deps.round();
    if (next !== undefined && Number.isFinite(next) && next > 0) delayMs = next;
  } catch (err) {
    deps.warn(`[instance-agent] heartbeat round failed: ${errorText(err)}`);
  }
  deps.schedule(() => void runHeartbeatLoop(deps), delayMs);
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return `${err.message} (${typeof code === "string" ? `${code}: ` : ""}${cause.message})`;
  }
  return err.message;
}
