/**
 * Ingress sweep: archives each stale ingress task (openspec/glossary.md).
 * Spec: openspec/specs/ingress-sweep/spec.md.
 */
import {
  callKanbanBridge,
  EA_MAIL_INGRESS_KANBAN_BOARD,
  type KanbanBridgeCall,
} from "../hermesKanbanBridge.js";

export const INGRESS_SWEEP_DEFAULT_AGE_HOURS = 48;
/** One run archives at most this many tasks. */
export const INGRESS_SWEEP_RUN_LIMIT = 100;
export const INGRESS_SWEEP_INTERVAL_SECONDS = 3600;

/** Age limit in hours from JOSHU_INGRESS_SWEEP_HOURS. 0 turns the ingress sweep off. */
export function ingressSweepAgeHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JOSHU_INGRESS_SWEEP_HOURS?.trim();
  if (!raw) return INGRESS_SWEEP_DEFAULT_AGE_HOURS;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours >= 0 ? Math.floor(hours) : INGRESS_SWEEP_DEFAULT_AGE_HOURS;
}

export type IngressSweepResult = { off: boolean; archived: number; remaining: number };

/** Run the ingress sweep once. Throws when the Kanban bridge fails. */
export async function sweepStaleIngressTasks(
  call: KanbanBridgeCall = callKanbanBridge,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IngressSweepResult> {
  const hours = ingressSweepAgeHours(env);
  if (hours === 0) return { off: true, archived: 0, remaining: 0 };
  const result = await call({
    action: "archive_stale_blocked",
    board: EA_MAIL_INGRESS_KANBAN_BOARD,
    max_age_seconds: hours * 3600,
    limit: INGRESS_SWEEP_RUN_LIMIT,
  });
  if (!result.success) {
    throw new Error(result.error ?? "archive_stale_blocked failed");
  }
  return { off: false, archived: result.archived?.length ?? 0, remaining: result.remaining ?? 0 };
}

let inFlight = false;

/**
 * One run for the timer of the Joshu API. Skips when the previous run is still going,
 * logs only a count, and never throws.
 */
export async function runIngressSweepOnce(
  call: KanbanBridgeCall = callKanbanBridge,
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, "warn"> = console,
): Promise<IngressSweepResult | null> {
  if (inFlight) return null;
  inFlight = true;
  try {
    const result = await sweepStaleIngressTasks(call, env);
    if (result.archived > 0) {
      log.warn(`[hermes-api] ingress sweep archived ${result.archived} task(s), ${result.remaining} left`);
    }
    return result;
  } catch (err) {
    log.warn(`[hermes-api] ingress sweep failed: ${(err as Error).message}`);
    return null;
  } finally {
    inFlight = false;
  }
}
