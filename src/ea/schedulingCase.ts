/**
 * @deprecated Re-exports — scheduling state now lives on Kanban tasks.
 * Use schedulingTypes.ts, schedulingIngress.ts, schedulingCron.ts.
 */
export {
  EA_SCHEDULING_BOARD,
  EA_SCHEDULING_SKILL,
  meetingTaskIdempotencyKey,
  parseEmailAddress,
  SCHEDULING_INBOX_IDEMPOTENCY_KEY,
} from "./schedulingTypes.js";

export {
  legacyBuildCaseId as buildCaseId,
  legacySchedulingCaseIdempotencyKey as schedulingCaseIdempotencyKey,
} from "./schedulingIngress.js";

export type {
  LegacySchedulingCaseFrontmatter as SchedulingCaseFrontmatter,
  LegacySchedulingCaseRecord as SchedulingCaseRecord,
  LegacySchedulingCaseState as SchedulingCaseState,
  LegacyLinkedThread as LinkedThread,
} from "./schedulingCaseLegacy.js";

export {
  findLegacySchedulingCaseById as findSchedulingCaseById,
  isLegacyCaseTerminal as isCaseTerminal,
  listLegacySchedulingCaseRecords as listSchedulingCaseRecords,
  readLegacySchedulingCase as readSchedulingCase,
} from "./schedulingCaseLegacy.js";

import type { AfterMirrorThreadInput } from "./triageTypes.js";
import type { LegacySchedulingCaseRecord } from "./schedulingCaseLegacy.js";

/** @deprecated No longer creates MD cases. */
export async function createSchedulingCase(
  _filesRoot: string,
  _input: AfterMirrorThreadInput,
): Promise<LegacySchedulingCaseRecord> {
  throw new Error("createSchedulingCase removed — use Kanban meeting tasks via scheduling ingress");
}

/** @deprecated */
export async function resolveSchedulingCaseForThread(
  _input: AfterMirrorThreadInput,
): Promise<{ record: LegacySchedulingCaseRecord; created: boolean }> {
  throw new Error("resolveSchedulingCaseForThread removed — use scheduling ingress");
}

/** @deprecated */
export async function findOpenCaseForThread(
  _filesRoot: string,
  _provider: string,
  _threadId: string,
  _accountKey?: string,
): Promise<LegacySchedulingCaseRecord | null> {
  return null;
}

/** @deprecated */
export async function appendThreadToCase(
  record: LegacySchedulingCaseRecord,
  _input: AfterMirrorThreadInput,
): Promise<{ record: LegacySchedulingCaseRecord; shouldRequeue: boolean; reason: string }> {
  return { record, shouldRequeue: false, reason: "deprecated" };
}

/** @deprecated */
export async function patchCaseHandlerQueuedFlag(): Promise<void> {}

/** @deprecated */
export async function patchStubSchedulingFields(): Promise<void> {}

/** @deprecated */
export async function isCaseHandlerRecentlyQueued(): Promise<boolean> {
  return false;
}

/** @deprecated */
export async function markCaseHandlerQueued(): Promise<void> {}
