/**
 * Deterministic ingest gates for Phase 1 EA (after mirror, before/at triage stub).
 */
import { readAgentProfile } from "../nylas/profile.js";
import { readAgentGrant } from "../nylas/store.js";
import { parseEmailAddress } from "./schedulingTypes.js";

const DEFAULT_SCHEDULING_MAX_AGE_MS = 36 * 60 * 60 * 1000;

function schedulingMaxAgeMs(): number {
  const hoursRaw = process.env.JOSHU_EA_SCHEDULING_MAX_AGE_HOURS?.trim();
  if (hoursRaw) {
    const hours = Number(hoursRaw);
    if (Number.isFinite(hours) && hours >= 0) return hours * 60 * 60 * 1000;
  }
  const msRaw = process.env.JOSHU_EA_SCHEDULING_MAX_AGE_MS?.trim();
  if (msRaw) {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  return DEFAULT_SCHEDULING_MAX_AGE_MS;
}

/** Agent mailbox addresses — grant file + profile assistantEmail. */
export function resolveJoshuAgentEmails(projectRoot = process.cwd()): Set<string> {
  const emails = new Set<string>();
  const grant = readAgentGrant(projectRoot);
  if (grant?.email?.trim()) emails.add(grant.email.trim().toLowerCase());
  const profile = readAgentProfile(projectRoot);
  if (profile?.assistantEmail?.trim()) {
    emails.add(profile.assistantEmail.trim().toLowerCase());
  }
  return emails;
}

/** True when the latest message sender is the Joshu agent mailbox. */
export function isFromJoshuAgent(from: string | undefined, projectRoot = process.cwd()): boolean {
  const addr = parseEmailAddress(from);
  if (!addr) return false;
  return resolveJoshuAgentEmails(projectRoot).has(addr);
}

/**
 * Backfill guard: skip scheduling classify/queue for mail older than the incremental window.
 * Full sync / Day 0 recovery otherwise re-classifies stale meeting threads.
 */
export function isStaleForScheduling(receivedAt?: string): boolean {
  if (!receivedAt?.trim()) return false;
  const ts = Date.parse(receivedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts > schedulingMaxAgeMs();
}

export function shouldSkipTriageStub(input: {
  from?: string;
  projectRoot?: string;
}): boolean {
  return isFromJoshuAgent(input.from, input.projectRoot);
}

export function shouldSkipSchedulingIngest(input: {
  from?: string;
  receivedAt?: string;
  projectRoot?: string;
}): boolean {
  if (isFromJoshuAgent(input.from, input.projectRoot)) return true;
  return isStaleForScheduling(input.receivedAt);
}
