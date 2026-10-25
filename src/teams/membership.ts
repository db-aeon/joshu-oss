/**
 * Team memberships of this box (spec team-room, design decisions 1 and 2).
 *
 * `<teams dir>/memberships.json` lists each team of the box: the team boss URL,
 * the member token, and the cursor of the last read. The file is outside the owner
 * files root, because member tokens are secrets. A team that this box hosts has no
 * team boss URL: the box reads and posts through its own team room store.
 */
import path from "node:path";

import { joshuStateDir } from "../joshuStateDir.js";
import { JsonStateStore } from "../jsonStateStore.js";
import { isTeamSlug, NOT_FOUND, type TeamCardOp, type TeamRoomStore } from "./roomStore.js";
import type { TeamResult, TeamRoomRead } from "./types.js";

export type TeamMembership = {
  /** Local team slug: the name of the team on this box (board `team-<slug>`, folder `Teams/<slug>`). */
  slug: string;
  /** Team slug on the team boss. */
  remoteSlug: string;
  /** Public base URL of the team boss (`https://<box>/joshu`); null when this box is the team boss. */
  bossUrl: string | null;
  memberId: string;
  token: string;
  isBoss: boolean;
  joinedAt: string;
  /** Hermes schedule of the team stand-up. */
  schedule: string;
  cronJobId?: string;
  /** Id of the last message or event that the team stand-up read. */
  lastReadId?: string;
  lastOkAt?: string;
  /** First failed call to the team boss since the last good call. */
  unreachableSince?: string;
  /** The team boss rejected the member token (removed). */
  rejectedAt?: string;
  /** Owner-local day and count of the texts that `team_tell_owner` sent for this team. */
  tellOwnerDay?: string;
  tellOwnerCount?: number;
  /** Ids of messages that the companion reported to the owner as suspicious (newest last). */
  flaggedMessageIds?: string[];
  /** Ids of the last messages that this box posted (newest last), to find answers to them. */
  ownMessageIds?: string[];
  /** Highest sequence number of a team room entry that started an early team stand-up. */
  wakeSeq?: number;
  /** Owner-local day and count of the early team stand-ups of this team. */
  wakeDay?: string;
  wakeCount?: number;
  /** Time of the last early team stand-up. */
  lastWakeAt?: string;
  /** Texts of drafts and questions over the daily limit, oldest first (sent on the next workday). */
  pendingTexts?: PendingOwnerText[];
};

/** A text to the owner that waits for the next workday (change boss-mode-promise-fixes). */
export type PendingOwnerText = { taskId: string; sms: string; emailSubject: string; emailBody: string; title: string; queuedAt: string };

export type MembershipState = { version: 1; teams: TeamMembership[] };

export function teamsDir(projectRoot: string): string {
  const explicit = process.env.JOSHU_TEAMS_DIR?.trim();
  return explicit ? path.resolve(explicit) : path.join(joshuStateDir(projectRoot), "teams");
}

export class MembershipStore extends JsonStateStore<MembershipState> {
  constructor(dir: string) {
    super(
      path.join(dir, "memberships.json"),
      (raw) => {
        const parsed = (raw ?? {}) as Partial<MembershipState>;
        return { version: 1, teams: Array.isArray(parsed.teams) ? parsed.teams : [] };
      },
      "team membership",
    );
  }

  async find(slug: string): Promise<TeamMembership | undefined> {
    return (await this.read()).teams.find((t) => t.slug === slug);
  }

  /** Patch one membership; returns the new record. */
  update(slug: string, patch: Partial<TeamMembership>): Promise<TeamMembership | undefined> {
    return this.transaction((state) => {
      const found = state.teams.find((t) => t.slug === slug);
      if (!found) return { result: undefined, changed: false };
      Object.assign(found, patch);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete (found as Record<string, unknown>)[key];
      }
      return { result: structuredClone(found), changed: true };
    });
  }
}

/** A local team slug that no other membership uses: `family`, then `family-2`, `family-3`. */
export function freeLocalSlug(taken: string[], wanted: string): string {
  if (!taken.includes(wanted)) return wanted;
  for (let i = 2; ; i += 1) {
    const candidate = `${wanted.slice(0, 36)}-${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Public base URL of this box, for invite links: `https://<CUSTOMER_DOMAIN><PUBLIC_BASE_PATH>`. */
export function boxPublicBaseUrl(): string | undefined {
  const explicit = process.env.JOSHU_PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = process.env.CUSTOMER_DOMAIN?.trim();
  if (!domain) return undefined;
  const base = (process.env.PUBLIC_BASE_PATH ?? "").trim().replace(/\/+$/, "");
  return `https://${domain}${base}`;
}

export function inviteLink(baseUrl: string, code: string): string {
  return `${baseUrl}/teams/join/${code}`;
}

/**
 * Parse an invite link (glossary "Invite link"). The team boss must be https, except
 * a loopback address for local tests.
 */
export function parseInviteLink(link: unknown): { bossUrl: string; code: string } | undefined {
  const text = typeof link === "string" ? link.trim() : "";
  const match = /^(https?:\/\/[^\s]+?)\/teams\/join\/([A-Za-z0-9_-]{16,64})\/?$/.exec(text);
  if (!match) return undefined;
  let url: URL;
  try {
    url = new URL(match[1]!);
  } catch {
    return undefined;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
  if (url.username || url.password) return undefined;
  return { bossUrl: match[1]!.replace(/\/+$/, ""), code: match[2]! };
}

/** How the box reaches the team room of one membership. */
export type TeamReadOptions = { seen?: boolean; days?: number };

/** Message fields that a team member sends to the team boss. */
export type TeamPostInput = { text?: unknown; inReplyTo?: unknown; cards?: unknown; viaOwner?: unknown };

export type TeamRoomClient = {
  /** `seen`: the read of the team stand-up, which moves the read position on the team boss. */
  read(since?: string, opts?: TeamReadOptions): Promise<TeamResult<{ room: TeamRoomRead }>>;
  post(input: TeamPostInput): Promise<TeamResult>;
  card(input: TeamCardOp): Promise<TeamResult>;
  leave(): Promise<TeamResult>;
};

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

const BOSS_TIMEOUT_MS = 15_000;

/** Call the team boss over HTTPS with the member token. Network errors give status 502. */
export async function callBoss(
  fetchImpl: FetchLike,
  bossUrl: string,
  method: "GET" | "POST",
  pathAndQuery: string,
  token: string | undefined,
  body?: unknown,
): Promise<TeamResult> {
  try {
    const res = await fetchImpl(`${bossUrl}/api/teams${pathAndQuery}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(BOSS_TIMEOUT_MS),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 200 && res.status < 300 && parsed.ok === true) {
      return { status: res.status === 201 ? 201 : 200, body: parsed as { ok: true } };
    }
    const status = [400, 403, 404, 409, 413, 429].includes(res.status) ? (res.status as 400) : 502;
    return { status, body: { ok: false, error: String(parsed.error ?? `team boss answered ${res.status}`) } };
  } catch (error) {
    return { status: 502, body: { ok: false, error: `team boss not reachable: ${(error as Error).message}` } };
  }
}

export function roomClient(m: TeamMembership, store: TeamRoomStore, fetchImpl: FetchLike): TeamRoomClient {
  if (!m.bossUrl) {
    return {
      read: (since, opts) => store.read(m.remoteSlug, m.memberId, since, opts),
      post: (input) => store.post(m.remoteSlug, m.memberId, input),
      card: (input) => store.card(m.remoteSlug, m.memberId, input),
      leave: async () => NOT_FOUND,
    };
  }
  const slug = encodeURIComponent(m.remoteSlug);
  const boss = m.bossUrl;
  return {
    read: (since, opts) => {
      const query = new URLSearchParams();
      if (since) query.set("since", since);
      if (opts?.seen) query.set("seen", "1");
      if (opts?.days) query.set("days", String(opts.days));
      const qs = query.toString();
      return callBoss(fetchImpl, boss, "GET", `/${slug}/room${qs ? `?${qs}` : ""}`, m.token) as Promise<TeamResult<{ room: TeamRoomRead }>>;
    },
    post: (input) => callBoss(fetchImpl, boss, "POST", `/${slug}/messages`, m.token, input),
    card: (input) => callBoss(fetchImpl, boss, "POST", `/${slug}/cards`, m.token, input),
    leave: () => callBoss(fetchImpl, boss, "POST", `/${slug}/leave`, m.token, {}),
  };
}

export { isTeamSlug };
