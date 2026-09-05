/**
 * Channel-agnostic coordination scope — one owner-facing ask mutexed across EA workers.
 * Mail is phase 1; SMS / Slack / voice adapters plug in later.
 */

export type CoordinationChannel = "mail" | "sms" | "slack" | "voice";

/** Channel-specific key used to link the same ask across mirrors / providers / channels. */
export type CoordinationFacet = {
  channel: CoordinationChannel;
  /** mail: thread id; sms: messageSid; slack: channel+ts; voice: session id */
  key: string;
  provider?: string;
  sourcePath?: string;
  rfcMessageId?: string;
};

export type CoordinationScope = {
  /** Stable hash of canonical ask identity (participants + topic + linked facets). */
  scopeId: string;
  channel: CoordinationChannel;
  facets: CoordinationFacet[];
  participants: string[];
  topic?: string;
  projectSlug?: string;
  /** Union of mail thread ids (for Kanban matching). */
  threadIds: string[];
  /** Mirror paths tied to this ask. */
  sourcePaths: string[];
  rfcMessageId?: string;
};

export type CoordinationCapability =
  | "meeting_negotiation"
  | "owner_deliverable"
  | "project_filing";

export type ActiveCoordination = {
  scopeId: string;
  capability: CoordinationCapability;
  board: string;
  task_id: string;
  channel: CoordinationChannel;
  created_at: string;
};

export type ChannelScopeInput =
  | MailScopeInput
  | SmsScopeInput;

export type MailScopeInput = {
  channel: "mail";
  filesRoot: string;
  threadId: string;
  provider?: string;
  sourcePath?: string;
  subject?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  projectSlug?: string;
  /** Joshu app root for agent email resolution (defaults to process.cwd()). */
  projectRoot?: string;
};

/** Phase 2 — stub type for cross-channel merge tests. */
export type SmsScopeInput = {
  channel: "sms";
  filesRoot: string;
  ownerPhone: string;
  body: string;
  messageSid?: string;
  counterpartyHint?: string;
  topic?: string;
};

export type SpawnAllowedResult =
  | { ok: true }
  | {
      ok: false;
      conflict: {
        board: string;
        task_id: string;
        capability: CoordinationCapability;
        reason: string;
        scopeId: string;
      };
    };

export const EA_SCHEDULING_BOARD = "ea-scheduling";
export const EA_OWNER_REPLY_BOARD = "ea-owner-reply";

export function capabilityForBoard(board: string): CoordinationCapability | null {
  if (board === EA_SCHEDULING_BOARD) return "meeting_negotiation";
  if (board === EA_OWNER_REPLY_BOARD) return "owner_deliverable";
  return null;
}

export function boardForCapability(capability: CoordinationCapability): string | null {
  if (capability === "meeting_negotiation") return EA_SCHEDULING_BOARD;
  if (capability === "owner_deliverable") return EA_OWNER_REPLY_BOARD;
  return null;
}
