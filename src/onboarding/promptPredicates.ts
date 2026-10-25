/**
 * Named onboarding completion predicates — no string eval.
 */
import { readConnectorsRegistry } from "../connectors/registry.js";
import { isValidIanaTimezone } from "../ianaTimezone.js";
import { readAgentProfile } from "../nylas/profile.js";
import { RealtimeGoalStore } from "../realtimeGoals/store.js";
import { readTelephoneStatus, resolveOwnerCaller } from "../telephoneSettings/resolve.js";
import type { OnboardingPredicateId } from "./promptRegistry.js";

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  const left = a?.trim().toLowerCase();
  return Boolean(left) && left === b?.trim().toLowerCase();
}

/** Owner profile: owner name, a valid time zone, and the primary work email. */
export function ownerProfileComplete(projectRoot = process.cwd()): boolean {
  const profile = readAgentProfile(projectRoot);
  const timezone = profile?.timezone?.trim();
  return Boolean(
    profile?.ownerName?.trim() &&
      timezone &&
      isValidIanaTimezone(timezone) &&
      profile.primaryWorkEmail?.trim(),
  );
}

/** Composio Gmail connected (work mail sync via Connectors). */
export async function workGmailConnected(projectRoot = process.cwd()): Promise<boolean> {
  const registry = await readConnectorsRegistry(projectRoot);
  if (!registry) return false;
  return registry.gmail.accounts.length >= 1;
}

/** At least one Google Calendar account is connected. */
export async function calendarConnected(projectRoot = process.cwd()): Promise<boolean> {
  const registry = await readConnectorsRegistry(projectRoot);
  return (registry?.googleCalendar.accounts.length ?? 0) >= 1;
}

/** Owner mobile for SMS/voice — same resolution as proactive SMS and action guard. */
export function ownerMobileConfigured(projectRoot = process.cwd()): boolean {
  return Boolean(resolveOwnerCaller(projectRoot));
}

/** At least one Gmail or Google Calendar account is connected. */
export async function anyGoogleAccountConnected(projectRoot = process.cwd()): Promise<boolean> {
  const registry = await readConnectorsRegistry(projectRoot);
  if (!registry) return false;
  return registry.gmail.accounts.length + registry.googleCalendar.accounts.length >= 1;
}

/** The primary work email is one of the connected Gmail or Google Calendar accounts. */
export async function workAccountConnected(projectRoot = process.cwd()): Promise<boolean> {
  const work = readAgentProfile(projectRoot)?.primaryWorkEmail;
  if (!work?.trim()) return false;
  const registry = await readConnectorsRegistry(projectRoot);
  if (!registry) return false;
  return [...registry.gmail.accounts, ...registry.googleCalendar.accounts].some((account) =>
    sameAddress(account.email, work),
  );
}

/** The Telephone settings have a voice PIN. */
export function voicePinSet(projectRoot = process.cwd()): boolean {
  return readTelephoneStatus(projectRoot).pinConfigured;
}

/** The owner presence of the owner outbox has a phone call of the owner. */
export async function ownerCalledBox(projectRoot = process.cwd()): Promise<boolean> {
  const state = await new RealtimeGoalStore(projectRoot).read();
  return Boolean(state.owner?.presence.lastByChannel?.pstn_voice);
}

/** The owner completes the card; the box cannot check the step. */
function manual(): boolean {
  return false;
}

const PREDICATES: Record<
  OnboardingPredicateId,
  (projectRoot: string) => boolean | Promise<boolean>
> = {
  ownerProfileComplete,
  workGmailConnected,
  calendarConnected,
  ownerMobileConfigured,
  anyGoogleAccountConnected,
  workAccountConnected,
  voicePinSet,
  ownerCalledBox,
  manual,
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
