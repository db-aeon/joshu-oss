export {
  createTriageStubAfterMirror,
  type AfterMirrorThreadInput,
  type TriageProvider,
} from "./triageStub.js";
export { gmailIngestSkipLabel, isGmailJunk, isGmailJunkThread } from "./gmailJunk.js";
export {
  classifySchedulingEmail,
  classifyInboundMail,
  shouldQueueScheduling,
  shouldActOnMailClassification,
  normalizeForIngressRouting,
  isSchedulingCategoryHint,
  type InboundMailClassification,
} from "./classifier.js";
export {
  buildMailDedupKey,
  checkMailDedup,
  markMailDedupProcessed,
  prepareMailIngestDedup,
  mailIngressCanonicalId,
  mailIngressTaskIdempotencyKey,
  mailTrackTaskIdempotencyKey,
} from "./mailDedup.js";
export {
  forwardSchedulingMail,
  readSchedulingIngressEvents,
  markSchedulingIngressProcessed,
  countPendingIngressEvents,
  buildIngressEventId,
  type SchedulingIngressEvent,
} from "./schedulingIngress.js";
export { forwardTrackMail } from "./mailIngress.js";
export {
  queueSchedulingIngressTask,
  /** @deprecated */ queueSchedulingInboxProcessor,
  queueMeetingTaskHandler,
  meetingSidecarPath,
} from "./schedulingCron.js";
export {
  queueMailIngressTask,
  queueMailTrackTask,
  listMailTrackTasks,
  handoffMailToTrackTask,
  queueMailTrackTaskHandler,
} from "./mailCron.js";
export {
  EA_SCHED_INGRESS_BOARD,
  EA_SCHEDULING_BOARD,
  EA_SCHEDULING_SKILL,
  ingressTaskIdempotencyKey,
  meetingTaskIdempotencyKey,
  /** @deprecated */ SCHEDULING_INBOX_IDEMPOTENCY_KEY,
} from "./schedulingTypes.js";
export {
  EA_MAIL_INGRESS_BOARD,
  EA_PLAYBOOK_SKILL as EA_MAIL_PLAYBOOK_SKILL,
  projectBoardSlug,
  normalizeProjectSlug,
} from "./mailTypes.js";
export { readMeetingSidecar, writeMeetingSidecar, type MeetingSidecar } from "./schedulingMeetingSidecar.js";

/** @deprecated Legacy MD scheduling cases — read-only. */
export {
  findSchedulingCaseById,
  listSchedulingCaseRecords,
  readSchedulingCase,
  type SchedulingCaseRecord,
} from "./schedulingCase.js";

/** @deprecated */
export { queueSchedulingCaseHandler } from "./schedulingCron.js";
