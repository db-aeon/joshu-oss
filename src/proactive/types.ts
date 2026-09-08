/** Proactive Joshu — shared types for Kanban owner nudges. */

export type ProactivePreferences = {
  allowMorePerDay: boolean;
  allowEvenings: boolean;
  allowWeekends: boolean;
  offHoursAskedAt: string | null;
  notes: string[];
};

export type ProactiveLastNudge = {
  taskId: string;
  board: string;
  title?: string;
  blockReason?: string | null;
  sentAt: string;
  channel: string;
  /** Composed SMS/email body (debug). */
  body?: string;
};

export type ProactiveHygieneSummary = {
  closed: number;
  ambiguous: number;
  skipped: number;
  ranAt: string;
};

export type ProactiveState = {
  /** Local date YYYY-MM-DD in owner timezone when sentCount applies. */
  date: string;
  dailyCap: number;
  sentCount: number;
  lastNudge: ProactiveLastNudge | null;
  feedbackPending: boolean;
  /** Task ids nudged on `date` — dedupe same-day re-nudge. */
  nudgedTaskIds: string[];
  preferences: ProactivePreferences;
  hygieneLastRunAt?: string | null;
  hygieneClosedTaskIds?: string[];
  lastHygieneSummary?: ProactiveHygieneSummary | null;
};

export type ProactiveCandidate = {
  taskId: string;
  board: string;
  title: string;
  status: string;
  blockReason: string | null;
  body?: string;
  projectSlug?: string;
  /** Lower = higher priority. */
  rankScore: number;
  rankSignals: {
    dueDate?: string | null;
    urgency?: number | null;
    taskPriority?: number;
    ageHours?: number;
  };
};

export type ProactiveTickResult = {
  ok: boolean;
  action: "skipped" | "sent" | "error";
  reason?: string;
  candidate?: ProactiveCandidate;
  channel?: string;
  nudge?: ProactiveLastNudge;
};

export type ProactiveFeedbackResult = {
  ok: boolean;
  message: string;
  state?: ProactiveState;
};
