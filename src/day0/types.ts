/** Persistent Day 0 / sweep state under `.joshu/day0.json`. */
export type Day0Phase =
  | "idle"
  | "syncing"
  | "extracting"
  | "inferring"
  | "merging"
  | "completed"
  | "failed";

export interface Day0State {
  schemaVersion: 1;
  status: Day0Phase;
  startedAt?: string;
  completedAt?: string;
  lastSweepAt?: string;
  /** All Gmail accounts included in the last run (multi-mailbox Day 0). */
  connectedAccountIds?: string[];
  /** @deprecated Use connectedAccountIds — kept for older state files. */
  connectedAccountId?: string;
  threadsAnalyzed?: number;
  eventsAnalyzed?: number;
  model?: string;
  fieldsFilled?: string[];
  warnings?: string[];
  error?: string;
  /** Latest incremental sweep digest (markdown). */
  lastDigest?: string;
}

export const DEFAULT_DAY0_STATE: Day0State = {
  schemaVersion: 1,
  status: "idle",
};

/** One thread row for LLM chunking — headers literal, body truncated. */
export interface Day0ThreadRow {
  threadId: string;
  subject?: string;
  from?: string;
  to?: string[];
  date?: string;
  dateEpoch?: number;
  accountEmail?: string;
  bodySnippet: string;
  messageCount: number;
  /** Gmail label ids when present in mirror frontmatter. */
  labels?: string[];
}

/** Deterministic extract output (no LLM). */
export interface Day0ExtractResult {
  /** Primary/default mailbox (legacy single-account field). */
  accountEmail?: string;
  /** All connected mailboxes included in this extract. */
  accountEmails?: string[];
  /** Thread counts per mailbox address or account key. */
  accountThreadCounts?: Record<string, number>;
  /** Heuristic work vs personal split when multiple mailboxes are connected. */
  emailRoles?: { primaryWorkEmail?: string; personalEmail?: string };
  /** Threads after junk/newsletter filter (used for LLM). */
  signalThreads?: Day0ThreadRow[];
  noiseThreadCount?: number;
  threads: Day0ThreadRow[];
  topCorrespondents: Array<{ address: string; count: number; displayName?: string }>;
  urls: string[];
  sendHourHistogram: number[]; // 24 buckets UTC
  events: Array<{ title?: string; start?: string; end?: string; location?: string }>;
  workingHoursHint?: { start?: string; end?: string; timezone?: string };
}

/** LLM inference subset mapped to OnboardingDraft fields. */
export interface Day0InferResult {
  bigPicturePriorities?: string[];
  bigPictureNotes?: string;
  communicationChannels?: string[];
  communicationContacts?: Record<string, string>;
  communicationNotes?: string;
  onlineTools?: string[];
  onlineToolsNotes?: string;
  primaryWorkEmail?: string;
  personalEmail?: string;
  timezone?: string;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  vips?: Array<{ who: string; priority?: string; gatekeepNotes?: string }>;
  confidence?: Record<string, "high" | "medium" | "low">;
  warnings?: string[];
}

export interface Day0ColdStartResult {
  ok: boolean;
  skipped?: boolean;
  draft?: unknown;
  day0: Day0State;
  stats?: {
    threadsWritten: number;
    eventsWritten: number;
    threadsAnalyzed: number;
    eventsAnalyzed: number;
    accountsSynced?: number;
  };
  error?: string;
}

export interface Day0SweepResult {
  ok: boolean;
  digest?: string;
  day0: Day0State;
  error?: string;
}
