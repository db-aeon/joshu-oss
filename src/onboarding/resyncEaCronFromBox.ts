/**
 * Repair helper: rebuild EA cron windows from saved Welcome draft or Nylas profile.
 */
import { readAgentProfile } from "../nylas/profile.js";
import { resolveJoshuIdentity } from "../joshuIdentity.js";
import { syncHermesOwnerTimezone } from "../hermesOwnerTimezone.js";
import { syncEaCronJobs, type SyncEaCronJobsResult } from "./eaCronJobs.js";
import { onboardingDraftPath, readJsonFile } from "./paths.js";
import type { OnboardingDraft } from "./types.js";

export type ResyncEaCronFromBoxResult = {
  ok: boolean;
  timezone?: string;
  timezoneChanged?: boolean;
  cron?: SyncEaCronJobsResult;
  proactiveCron?: string;
  proactiveHygieneCron?: string;
  error?: string;
};

/** Prefer onboarding draft; fall back to Nylas profile + identity for fleet repair. */
export function resolveEaCronDraft(projectRoot: string): OnboardingDraft | null {
  const fromFile = readJsonFile<OnboardingDraft>(onboardingDraftPath(projectRoot));
  if (fromFile?.ownerName && fromFile.assistantName && fromFile.timezone?.trim()) {
    return fromFile;
  }

  const profile = readAgentProfile(projectRoot);
  const identity = resolveJoshuIdentity(projectRoot);
  const ownerName = profile?.ownerName ?? identity.owner.displayName;
  const assistantName = profile?.assistantName ?? identity.name;
  const timezone = profile?.timezone?.trim();
  if (!ownerName?.trim() || !assistantName?.trim() || !timezone) {
    return null;
  }

  return {
    ownerName: ownerName.trim(),
    assistantName: assistantName.trim(),
    timezone,
    workingHoursStart: profile?.workingHoursStart,
    workingHoursEnd: profile?.workingHoursEnd,
    primaryWorkEmail: profile?.primaryWorkEmail,
    personalEmail: profile?.personalEmail,
    urgentChannel: profile?.urgentChannel,
    spendingThreshold: profile?.spendingThreshold,
  };
}

/** Set Hermes owner timezone, then upsert EA morning/evening/weekly crons. */
export async function resyncEaCronFromBox(projectRoot: string): Promise<ResyncEaCronFromBoxResult> {
  const draft = resolveEaCronDraft(projectRoot);
  if (!draft) {
    return {
      ok: false,
      error: "no onboarding draft or Nylas profile with timezone + owner/assistant names",
    };
  }

  const tzResult = await syncHermesOwnerTimezone(draft.timezone);
  if (!tzResult.ok) {
    return { ok: false, error: tzResult.error ?? "timezone sync failed" };
  }

  const cron = await syncEaCronJobs(draft);
  if (!cron.ok) {
    return {
      ok: false,
      timezone: tzResult.timezone,
      timezoneChanged: tzResult.changed,
      cron,
      error: cron.error ?? "EA cron sync failed",
    };
  }

  let proactiveCron: string | undefined;
  try {
    const { syncProactiveCron } = await import("../proactive/proactiveCronJobs.js");
    proactiveCron = await syncProactiveCron(projectRoot);
  } catch (err) {
    console.warn(`[ea-cron] proactive cron sync: ${(err as Error).message}`);
  }

  let proactiveHygieneCron: string | undefined;
  try {
    const { syncProactiveHygieneCron } = await import("../proactive/hygieneCronJobs.js");
    proactiveHygieneCron = await syncProactiveHygieneCron(draft);
  } catch (err) {
    console.warn(`[ea-cron] proactive hygiene cron sync: ${(err as Error).message}`);
  }

  return {
    ok: true,
    timezone: tzResult.timezone,
    timezoneChanged: tzResult.changed,
    cron,
    proactiveCron,
    proactiveHygieneCron,
  };
}
