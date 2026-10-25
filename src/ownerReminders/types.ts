/** Owner reminder records (openspec/glossary.md "Owner reminder"). */

export type OwnerReminderRetireReason =
  | "owner_done"
  | "stopped"
  | "task_closed"
  | "ended"
  | "one_time"
  | "one_time_failed";

export type OwnerReminderRun = {
  at: string;
  result: "delivered" | "failed" | "skipped";
  channel?: "sms" | "email";
  error?: string;
  /** Why a run sent nothing (retire reason). */
  reason?: string;
};

export type OwnerReminder = {
  id: string;
  title: string;
  /** Owner-facing text, fixed at creation. */
  text: string;
  /** Hermes schedule string. */
  schedule: string;
  kind: "recurring" | "one_time";
  createdAt: string;
  /** ISO time; a run after this time retires the owner reminder. */
  endsAt?: string;
  linkedTask?: { board: string; taskId: string };
  cronJobId?: string;
  /** File name in ~/.hermes/scripts/. */
  scriptName: string;
  status: "active" | "retired";
  retiredAt?: string;
  retiredReason?: OwnerReminderRetireReason;
  /** Newest last; at most MAX_RUNS. */
  runs: OwnerReminderRun[];
};

export type OwnerReminderState = {
  version: 1;
  reminders: OwnerReminder[];
};
