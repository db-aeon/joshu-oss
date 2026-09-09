/**
 * Named onboarding completion predicates — no string eval.
 */
import { readConnectorsRegistry } from "../connectors/registry.js";
import { resolveOwnerCaller } from "../telephoneSettings/resolve.js";
import type { OnboardingPredicateId } from "./promptRegistry.js";

/** Composio Gmail connected (work mail sync via Connectors). */
export async function workGmailConnected(projectRoot = process.cwd()): Promise<boolean> {
  const registry = await readConnectorsRegistry(projectRoot);
  if (!registry) return false;
  return registry.gmail.accounts.length >= 1;
}

/** Owner mobile for SMS/voice — same resolution as proactive SMS and action guard. */
export function ownerMobileConfigured(projectRoot = process.cwd()): boolean {
  return Boolean(resolveOwnerCaller(projectRoot));
}

const PREDICATES: Record<
  OnboardingPredicateId,
  (projectRoot: string) => boolean | Promise<boolean>
> = {
  workGmailConnected,
  ownerMobileConfigured,
};

export async function evaluateOnboardingPredicate(
  predicateId: OnboardingPredicateId,
  projectRoot = process.cwd(),
): Promise<boolean> {
  const fn = PREDICATES[predicateId];
  if (!fn) return false;
  return Boolean(await fn(projectRoot));
}

/** Count required prompts still incomplete (for proactive rank boost). */
export async function countOpenRequiredOnboardingPrompts(
  projectRoot: string,
  promptIds: Array<{ id: string; completeWhen: OnboardingPredicateId; required: boolean }>,
): Promise<number> {
  let open = 0;
  for (const p of promptIds) {
    if (!p.required) continue;
    const done = await evaluateOnboardingPredicate(p.completeWhen, projectRoot);
    if (!done) open += 1;
  }
  return open;
}
