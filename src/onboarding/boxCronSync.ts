/**
 * Install the Hermes cron jobs that every box needs, idempotently.
 *
 * Finish setup and each start of the Joshu API call syncBoxCronJobs, so a box that finished
 * setup on an older release, or that never finished setup, gets the jobs after an upgrade.
 */
import { readJsonFile, onboardingStatePath } from "./paths.js";
import { resolveEaCronDraft } from "./resyncEaCronFromBox.js";
import type { OnboardingState } from "./types.js";

type CronSyncOutcome = "created" | "updated" | "skipped";

export type BoxCronSyncResult = {
  setupFinished: boolean;
  /** Outcome of each job, or the error text, or undefined when the job does not apply to the box. */
  onboardingReconcile?: CronSyncOutcome | string;
  proactiveTick?: CronSyncOutcome | string;
  proactiveHygiene?: CronSyncOutcome | string;
};

function isSetupFinished(projectRoot: string): boolean {
  return readJsonFile<OnboardingState>(onboardingStatePath(projectRoot))?.completed === true;
}

async function runSync(
  label: string,
  logPrefix: string,
  sync: () => Promise<CronSyncOutcome>,
): Promise<CronSyncOutcome | string> {
  try {
    const outcome = await sync();
    console.info(`${logPrefix} ${label} cron: ${outcome}`);
    return outcome;
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`${logPrefix} ${label} cron sync skipped: ${message}`);
    return `error: ${message}`;
  }
}

/**
 * Every box gets the onboarding reconcile job: it only updates the setup board.
 * The proactive tick and proactive hygiene jobs send nudges to the owner and use the owner
 * timezone and working hours, so they need a finished setup. The hygiene job also needs an
 * owner name and timezone from the onboarding draft or the Nylas profile.
 */
export async function syncBoxCronJobs(
  projectRoot: string,
  logPrefix = "[box-cron]",
): Promise<BoxCronSyncResult> {
  const result: BoxCronSyncResult = { setupFinished: isSetupFinished(projectRoot) };

  result.onboardingReconcile = await runSync("onboarding reconcile", logPrefix, async () => {
    const { syncOnboardingReconcileCron } = await import("./onboardingCronJobs.js");
    return syncOnboardingReconcileCron(projectRoot);
  });

  if (!result.setupFinished) return result;

  result.proactiveTick = await runSync("proactive tick", logPrefix, async () => {
    const { syncProactiveCron } = await import("../proactive/proactiveCronJobs.js");
    return syncProactiveCron(projectRoot);
  });

  const draft = resolveEaCronDraft(projectRoot);
  if (draft) {
    result.proactiveHygiene = await runSync("proactive hygiene", logPrefix, async () => {
      const { syncProactiveHygieneCron } = await import("../proactive/hygieneCronJobs.js");
      return syncProactiveHygieneCron(draft);
    });
  }

  return result;
}
