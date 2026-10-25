/** Team records (openspec/glossary.md "Teams"; spec team-room). */

export type TeamCardState = "todo" | "doing" | "waiting" | "done";

export const TEAM_CARD_STATE_LABELS: Record<TeamCardState, string> = {
  todo: "To do",
  doing: "Doing",
  waiting: "Waiting on a person",
  done: "Done",
};

export type TeamAvatar = { mime: "image/png" | "image/jpeg"; base64: string };

/** One team member, as the team boss keeps it. */
export type TeamMember = {
  id: string;
  ownerName: string;
  companionName: string;
  avatar?: TeamAvatar;
  /** sha256 hex of the member token. */
  tokenHash: string;
  isBoss: boolean;
  joinedAt: string;
  removedAt?: string;
  leftAt?: string;
  /** Sequence number of the newest entry that the team stand-up of this member read ("Seen by"). */
  seenSeq?: number;
};

export type TeamInvite = {
  /** sha256 hex of the invite code. */
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  usedBy?: string;
};

export type TeamProject = { code: string; name: string; note?: string };

export type TeamCard = {
  id: string;
  title: string;
  project: string;
  state: TeamCardState;
  /** Team member who does the work. */
  doer: string;
  /** Team member who asked for the work. */
  asker: string;
  due?: string;
  waitingOn?: string;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
};

/** The JSON file of one team room on the team boss. */
export type TeamRoomState = {
  version: 1;
  slug: string;
  charter: string;
  createdAt: string;
  members: TeamMember[];
  invites: TeamInvite[];
  projects: TeamProject[];
  cards: TeamCard[];
  /** Last sequence number of the log. */
  seq: number;
  /** Next card number for each project code. */
  cardNumbers: Record<string, number>;
};

/** A team card as it was when a message named it (change boss-mode-group-chat). */
export type TeamCardCopy = Pick<TeamCard, "id" | "title" | "state" | "doer"> & { waitingOn?: string };

/** One line of the log of a team room: a message or a team card event. */
export type TeamRoomEntry =
  | {
      kind: "message";
      id: string;
      seq: number;
      author: string;
      at: string;
      text: string;
      inReplyTo?: string;
      /** The team cards that the message names, as they were at the time of the post. */
      cards?: TeamCardCopy[];
      /** The companion posted the message for a reply of its owner in the Multiplayer app. */
      viaOwner?: true;
    }
  | { kind: "event"; id: string; seq: number; author: string; at: string; card: string; text: string };

/** What a team member sees of another team member. */
export type TeamMemberView = {
  id: string;
  ownerName: string;
  companionName: string;
  /** "Sam's Joshu (Otto)" */
  label: string;
  avatar?: TeamAvatar;
  isBoss: boolean;
  /** False after the team member left or was removed (old messages keep the name). */
  active: boolean;
};

export type TeamRoomRead = {
  slug: string;
  charter: string;
  you: string;
  entries: TeamRoomEntry[];
  cards: TeamCard[];
  projects: TeamProject[];
  members: TeamMemberView[];
  /** Read position of the team stand-up of each team member: member id to message id. */
  seen: Record<string, string>;
};

/** HTTP-shaped result: the routes send `body` with `status`. */
export type TeamResult<T extends Record<string, unknown> = Record<string, unknown>> =
  | { status: 200 | 201; body: { ok: true } & T }
  | { status: 400 | 403 | 404 | 409 | 413 | 429 | 502; body: { ok: false; error: string } };

export type TeamFailure = Extract<TeamResult, { body: { ok: false } }>;

/** The failed result `out` as a result of any success shape. */
export function asFailure(out: { status: number; body: { ok: boolean; error?: string } }): TeamFailure {
  const status = [400, 403, 404, 409, 413, 429].includes(out.status) ? (out.status as TeamFailure["status"]) : 502;
  return { status, body: { ok: false, error: String(out.body.error ?? "failed") } };
}
