/**
 * The production objects of recurring reports on a box: the service, the runner, and the
 * dependencies of a run (the Exa key, the router access, the relays, and the senders of the box).
 */

import { sourceSearchClient } from "../pipeline/sourceSearch.js";
import { boxWebClient, webSourceLabel } from "../pipeline/you.js";
import { boxSenders } from "./delivery.js";
import { RecurringRunner, type RunDeps } from "./run.js";
import { recurringService, type RecurringService } from "./service.js";

export type RecurringRuntime = { service: RecurringService; runner: RecurringRunner; runDeps: () => RunDeps };

let runtime: RecurringRuntime | undefined;

function webOfBox(projectRoot: string): Pick<RunDeps, "exa" | "webLabel"> {
  const web = boxWebClient(projectRoot);
  return web.client ? { exa: web.client, webLabel: webSourceLabel(web.provider) } : { exa: null };
}

/** The runtime of this box, or null while the box has no owner files folder. */
export function recurringRuntime(projectRoot: string): RecurringRuntime | null {
  if (runtime) return runtime;
  const service = recurringService(projectRoot);
  if (!service) return null;
  // Read the keys on each run, so a key that the control plane adds later is used.
  const runDeps = (): RunDeps => ({
    projectRoot,
    // The web client of the box: You.com when the box can reach You.com, or else Exa (change you-web-provider).
    ...webOfBox(projectRoot),
    sourceSearch: sourceSearchClient(projectRoot),
    senders: boxSenders(projectRoot),
    now: () => new Date(),
  });
  runtime = { service, runner: new RecurringRunner(service.store, runDeps), runDeps };
  return runtime;
}
