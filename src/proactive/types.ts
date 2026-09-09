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
  active?: number;
  ranAt: string;
};

/** Card queued by hygiene for optional stale_review owner nudge (hourly tick). */
export type HygieneAmbiguousItem = {
  taskId: string;
  board: string;
  title: string;
  blockReason: string | null;
  queuedAt: string;
};

export type HygieneCandidateHints = {
  createdAtMs: number | null;
  isDateStale: boolean;
  latestHardDateMs: number | null;
  ageDays: number | null;
};

export type HygieneCandidate = {
  taskId: string;
  board: string;
  title: string;
  blockReason: string | null;
  projectSlug?: string;
  hints: HygieneCandidateHints;
};

export type HygienePlan = {
  planId: string;
  createdAt: string;
  candidateCount: number;
  totalBlocked: number;
  candidates: HygieneCandidate[];
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
  /** Ambiguous hygiene cards — hourly tick may send stale_review nudges. */
  hygieneAmbiguousQueue?: HygieneAmbiguousItem[];
  /** Owner-local date YYYY-MM-DD when last ea-onboarding nudge was sent. */
  lastOnboardingNudgeDate?: string | null;
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
