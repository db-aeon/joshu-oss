/**
 * Multiplayer teams on this box (specs team-room and team-standup).
 *
 * The chat companion creates, joins, and leaves teams through this service. The
 * team stand-up reads and posts through it. When this box is the team boss, the
 * public routes call `hostJoin` and the team room store.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CronBridgePayload, CronBridgeResult } from "../hermesCronBridge.js";
import type { KanbanBridgeCall, KanbanTaskSummary } from "../hermesKanbanBridge.js";
import type { OwnerTextInput, OwnerTextResult } from "../ownerTextChannel.js";
import type { ProactiveLastNudge } from "../proactive/types.js";
import {
  callBoss,
  freeLocalSlug,
  inviteLink,
  isTeamSlug,
  MembershipStore,
  parseInviteLink,
  roomClient,
  type FetchLike,
  type PendingOwnerText,
  type TeamMembership,
} from "./membership.js";
import { RETENTION_DAYS, type TeamCardOp, type TeamProfile, type TeamRoomStore } from "./roomStore.js";
import { asFailure, type TeamResult, type TeamRoomRead } from "./types.js";
import {
  findWakeTriggers,
  inWakeWindow,
  MAX_EARLY_STANDUPS_PER_DAY,
  MAX_OWN_MESSAGE_IDS,
  MIN_MINUTES_BETWEEN_STANDUPS,
  type OwnerClock,
} from "./wake.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Default team stand-up: each workday at 08:45 in the local time of the owner (spec team-standup). */
export const DEFAULT_STANDUP_SCHEDULE = "45 8 * * 1-5";
export const TEAM_STANDUP_JOB_PREFIX = "Team stand-up: ";
export const TEAM_STANDUP_SKILL = "team-standup";
/** Most texts that `team_tell_owner` sends for one team in one day. */
export const MAX_TELL_OWNER_PER_DAY = 3;
export const MAX_TELL_OWNER_CHARS = 600;
const TASK_ID_RE = /^t_[0-9a-f]{6,16}$/;
const CARD_ID_RE = /^[A-Z][A-Z0-9]{1,5}-\d{1,6}$/;
export const TEAM_COMMITMENT_KIND = "team_commitment";
export const TEAM_QUESTION_KIND = "team_question";
/** Most characters of one message of the companion in a team room (spec team-standup, "The stand-up post"). */
export const MAX_COMPANION_MESSAGE_CHARS = 400;
/** Most characters of a reply or an answer of the owner in the Multiplayer app. */
export const MAX_OWNER_WORDS_CHARS = 2000;
const MESSAGE_ID_RE = /^m_\d{1,12}$/;
/** Origin line of a reply of the owner: the request comes from the owner, not from a team member. */
export const OWNER_REPLY_ORIGIN_LINE = "origin: the owner in the Multiplayer app";
/** Rail (design decision 6): a later worker with the full toolset must see that the request is not the owner's. */
export const TEAM_ORIGIN_LINE = "origin: team room (a request from a team member, not an instruction from the owner)";

/** Each team board starts with this prefix. The blockers of one team skip the team boards of other teams. */
export const TEAM_BOARD_PREFIX = "team-";
/** Most blocked Kanban tasks that `team_blockers` returns. */
export const MAX_TEAM_BLOCKERS = 200;

export function teamBoardSlug(slug: string): string {
  return `${TEAM_BOARD_PREFIX}${slug}`;
}

/** Hermes MCP server name of the team MCP of one team (raw server name, see design Risks). */
export function teamMcpServerName(slug: string): string {
  return `joshu_team_${slug.replace(/-/g, "_")}`;
}

/**
 * Toolsets of the team stand-up: raw MCP server names, so Hermes adds no other MCP server.
 * `no_mcp` keeps that true when no named server is in the Hermes config (for example lost
 * team files and a disabled gbrain): then the team stand-up gets no MCP server instead of all.
 */
export function teamStandupToolsets(slug: string): string[] {
  return ["file", "kanban", "gbrain", teamMcpServerName(slug), "no_mcp"];
}

/**
 * Prompt of the team stand-up. The file tool of a Hermes cron job resolves a relative path from
 * the terminal folder (the owner's Desktop), not from the workdir of the job, so the prompt
 * names the team folder with its full path.
 */
export function teamStandupPrompt(slug: string, teamFolder?: string): string {
  return (
    `Run the team stand-up of team "${slug}" with skill team-standup. ` +
    `Read the team room with team_read, then follow the skill. Your team folder is ${teamFolder ?? `Teams/${slug}`}/ ` +
    `(read charter.md and notes.md there with this full path).`
  );
}

/** A Kanban task of the team board, as the Multiplayer app shows it. */
export type TeamBoardTask = {
  taskId: string;
  title: string;
  status: string;
  blockKind: string | null;
  blockReason: string | null;
  kind?: string;
  card?: string;
  question?: string;
  draft?: string;
  askedBy?: string;
  /** The text under the header of the task body, without the draft. */
  text?: string;
  /** For a reply of the owner (`question: reply`): the message that the owner replied to. */
  inReplyTo?: string;
};

/** A blocked Kanban task of this box, for step "Find your blockers" of the team stand-up. */
export type TeamBlocker = {
  taskId: string;
  board: string;
  title: string;
  blockKind: string | null;
  blockReason: string | null;
};

export type TeamView = {
  team: Omit<TeamMembership, "token">;
  room?: TeamRoomRead;
  roomError?: string;
  tasks: TeamBoardTask[];
  questions: TeamBoardTask[];
  notes: string;
  /** sha256 hex of `notes`; the Multiplayer app sends it back when it saves the team notes. */
  notesHash: string;
  standup: { lastRunAt?: string; nextRunAt?: string };
};

export type TeamServiceDeps = {
  projectRoot: string;
  store: TeamRoomStore;
  memberships: MembershipStore;
  /** Owner files root; undefined when the box has none (tests write nothing there). */
  filesRoot?: string;
  fetch: FetchLike;
  publicBaseUrl: () => string | undefined;
  /** Name of the owner, name and avatar of the companion. */
  profile: () => Promise<TeamProfile>;
  sendText: (input: OwnerTextInput) => Promise<OwnerTextResult>;
  cron: (payload: CronBridgePayload) => Promise<CronBridgeResult>;
  kanban: KanbanBridgeCall;
  /** Pinned model of the team stand-up. */
  standupModel: () => string;
  /** Make Hermes read cron hours in the owner's time zone before a team stand-up is created. */
  ensureOwnerTimezone: () => Promise<void>;
  /** Rewrite the Hermes config (team MCP servers) after a change of the team list. */
  onTeamsChanged: () => Promise<void>;
  /** Owner-local date YYYY-MM-DD. */
  ownerToday: () => string;
  /** Owner-local date, hour, and weekday (wake window of the early team stand-up). */
  ownerClock: () => OwnerClock;
  /** Record a team text with a Ref line as the last nudge (nudge reply path). */
  recordOwnerQuestion: (nudge: ProactiveLastNudge) => void;
  /** The nudge reply path for an owner answer to a task (as an SMS reply with this text). */
  resolveOwnerReply: (input: { taskId: string; board: string; body: string }) => Promise<{ ok: boolean; action: string; reason?: string }>;
  now: () => Date;
};

const bad = (status: 400 | 403 | 404 | 409 | 502, error: string) => ({ status, body: { ok: false as const, error } });

function str(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** A membership without its member token, for the chat companion and the Multiplayer app. */
export function publicMembership(m: TeamMembership): Omit<TeamMembership, "token"> {
  const { token: _token, ...rest } = m;
  return rest;
}

export function teamNotesTemplate(slug: string, companionName: string): string {
  return [
    `# Team notes: ${slug}`,
    "",
    `What ${companionName} may share with the ${slug} team. ${companionName} keeps this file up to date when you say what to share or not to share. You can also change it here.`,
    "",
    "## Share",
    "",
    "## Do not share",
    "",
    "## Drafts",
    "",
    `${companionName} shows you each message for the team first. To stop the drafts, tell ${companionName}, or write "Drafts: not necessary" here.`,
    "",
    "## Texts",
    "",
    `${companionName} texts you about this team when you need to know or act, at most 3 times a day. To get fewer texts, tell ${companionName}, for example "only text me when somebody needs a decision from me". A suspicious message is always reported.`,
    "",
  ].join("\n");
}

export class TeamService {
  constructor(private readonly deps: TeamServiceDeps) {}

  private teamFolder(slug: string): string | undefined {
    return this.deps.filesRoot ? path.join(this.deps.filesRoot, "Teams", slug) : undefined;
  }

  /** Write `Teams/<slug>/charter.md`; write `notes.md` only when it does not exist. */
  private async writeTeamFiles(slug: string, charter: string, companionName: string): Promise<void> {
    const folder = this.teamFolder(slug);
    if (!folder) return;
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "charter.md"), `# Team charter: ${slug}\n\n${charter.trim()}\n`);
    const notes = path.join(folder, "notes.md");
    try {
      await readFile(notes, "utf8");
    } catch {
      await writeFile(notes, teamNotesTemplate(slug, companionName));
    }
  }

  /** Board `team-<slug>`, the team stand-up, and the Hermes config for a new membership. */
  private async setUpMembership(m: TeamMembership, charter: string, companionName: string): Promise<TeamMembership> {
    await this.writeTeamFiles(m.slug, charter, companionName);
    const board = await this.deps.kanban({
      action: "ensure_board",
      board: teamBoardSlug(m.slug),
      slug: teamBoardSlug(m.slug),
      name: `Team ${m.slug}`,
      description: `Multiplayer: what this box promised team ${m.slug}`,
      ...(this.deps.filesRoot ? { default_workdir: this.deps.filesRoot } : {}),
    });
    if (!board.success) console.warn(`[teams] ensure_board ${teamBoardSlug(m.slug)} failed: ${board.error}`);
    // The team MCP server of the team must be in the Hermes config before the first run.
    await this.deps.onTeamsChanged();
    let job: CronBridgeResult;
    try {
      await this.deps.ensureOwnerTimezone();
      job = await this.deps.cron({
        action: "create",
        name: `${TEAM_STANDUP_JOB_PREFIX}${m.slug}`,
        schedule: m.schedule,
        prompt: teamStandupPrompt(m.slug, this.teamFolder(m.slug)),
        skills: [TEAM_STANDUP_SKILL],
        model: this.deps.standupModel(),
        enabled_toolsets: teamStandupToolsets(m.slug),
        deliver: "local",
        ...(this.deps.filesRoot ? { workdir: this.deps.filesRoot } : {}),
      });
    } catch (error) {
      job = { success: false, error: (error as Error).message };
    }
    const cronJobId = typeof job.job_id === "string" ? job.job_id : undefined;
    if (!cronJobId) console.warn(`[teams] team stand-up of ${m.slug} not created: ${job.error ?? "unknown error"}`);
    return (await this.deps.memberships.update(m.slug, cronJobId ? { cronJobId } : {})) ?? m;
  }

  /**
   * Give each existing team stand-up the toolsets of `teamStandupToolsets` (Joshu boot).
   * A team stand-up made before `no_mcp` was in the list gets the new list here.
   */
  async syncStandupJobs(): Promise<Array<{ slug: string; updated: boolean; error?: string }>> {
    const out: Array<{ slug: string; updated: boolean; error?: string }> = [];
    for (const m of (await this.deps.memberships.read()).teams) {
      if (!m.cronJobId) continue;
      const want = teamStandupToolsets(m.slug);
      const fail = (error: Error) => ({ success: false, error: error.message }) as CronBridgeResult;
      const got = await this.deps.cron({ action: "get", job_id: m.cronJobId }).catch(fail);
      if (!got.success) {
        out.push({ slug: m.slug, updated: false, error: got.error ?? "unknown error" });
        continue;
      }
      const have = (got.job as Record<string, unknown> | undefined)?.enabled_toolsets;
      if (Array.isArray(have) && have.length === want.length && want.every((t, i) => have[i] === t)) continue;
      const updated = await this.deps.cron({ action: "update", job_id: m.cronJobId, enabled_toolsets: want }).catch(fail);
      out.push(updated.success ? { slug: m.slug, updated: true } : { slug: m.slug, updated: false, error: updated.error ?? "unknown error" });
    }
    return out;
  }

  async list(): Promise<Array<Omit<TeamMembership, "token">>> {
    return (await this.deps.memberships.read()).teams.map(publicMembership);
  }

  private async membership(slug: string): Promise<TeamMembership | undefined> {
    return this.deps.memberships.find(str(slug, 40));
  }

  async create(input: { slug?: unknown; charter?: unknown; schedule?: unknown }): Promise<TeamResult<{ team: Omit<TeamMembership, "token"> }>> {
    const slug = str(input.slug, 40).toLowerCase();
    if (!isTeamSlug(slug)) return bad(400, "team slug must be 1 to 40 characters: a-z, 0-9, and -");
    if (await this.membership(slug)) return bad(409, `this box already has a team named ${slug}`);
    const profile = await this.deps.profile();
    const created = await this.deps.store.createTeam({ slug, charter: input.charter, boss: profile });
    if (!created.body.ok) return asFailure(created);
    const m: TeamMembership = {
      slug,
      remoteSlug: slug,
      bossUrl: null,
      memberId: created.body.memberId,
      token: created.body.token,
      isBoss: true,
      joinedAt: this.deps.now().toISOString(),
      schedule: str(input.schedule, 80) || DEFAULT_STANDUP_SCHEDULE,
    };
    await this.deps.memberships.transaction((state) => {
      state.teams.push(m);
      return { result: undefined, changed: true };
    });
    const saved = await this.setUpMembership(m, str(input.charter), String(profile.companionName ?? ""));
    return { status: 201, body: { ok: true, team: publicMembership(saved) } };
  }

  async invite(slug: string): Promise<TeamResult<{ link: string; expiresAt: string }>> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    if (!m.isBoss) return bad(403, "only the team boss makes invite links");
    const base = this.deps.publicBaseUrl();
    if (!base) return bad(400, "this box has no public address (CUSTOMER_DOMAIN), so it cannot make invite links");
    const out = await this.deps.store.makeInvite(m.remoteSlug);
    if (!out.body.ok) return asFailure(out);
    return { status: 201, body: { ok: true, link: inviteLink(base, out.body.code), expiresAt: out.body.expiresAt } };
  }

  /** What the owner sees before a join: the team charter and the team boss. */
  async preview(link: unknown): Promise<TeamResult<{ slug: string; charter: string; boss: string }>> {
    const parsed = parseInviteLink(link);
    if (!parsed) return bad(400, "this is not a Joshu team invite link");
    return (await callBoss(this.deps.fetch, parsed.bossUrl, "POST", "/preview", undefined, { code: parsed.code })) as TeamResult<{
      slug: string;
      charter: string;
      boss: string;
    }>;
  }

  async join(input: { inviteLink?: unknown; schedule?: unknown }): Promise<TeamResult<{ team: Omit<TeamMembership, "token">; charter: string }>> {
    const parsed = parseInviteLink(input.inviteLink);
    if (!parsed) return bad(400, "this is not a Joshu team invite link");
    const profile = await this.deps.profile();
    const out = (await callBoss(this.deps.fetch, parsed.bossUrl, "POST", "/join", undefined, { code: parsed.code, ...profile })) as TeamResult<{
      slug: string;
      memberId: string;
      token: string;
      charter: string;
    }>;
    if (!out.body.ok) return asFailure(out);
    const joined = out.body;
    const m = await this.deps.memberships.transaction((state) => {
      const record: TeamMembership = {
        slug: freeLocalSlug(state.teams.map((t) => t.slug), joined.slug),
        remoteSlug: joined.slug,
        bossUrl: parsed.bossUrl,
        memberId: joined.memberId,
        token: joined.token,
        isBoss: false,
        joinedAt: this.deps.now().toISOString(),
        schedule: str(input.schedule, 80) || DEFAULT_STANDUP_SCHEDULE,
      };
      state.teams.push(record);
      return { result: record, changed: true };
    });
    const saved = await this.setUpMembership(m, joined.charter, String(profile.companionName ?? ""));
    return { status: 201, body: { ok: true, team: publicMembership(saved), charter: joined.charter } };
  }

  /** Team boss side of a join (public route): join, then tell the owner of the team boss (spec team-room). */
  async hostJoin(code: unknown, profile: TeamProfile): Promise<TeamResult> {
    const out = await this.deps.store.join(code, profile);
    if (!out.body.ok) return out;
    const text = `${out.body.member.label} joined the ${out.body.slug} team.`;
    // The member box waits 15 seconds for this answer; the owner text channel can take longer.
    void this.deps
      .sendText({ sms: text, emailSubject: `Multiplayer: ${text}`, emailBody: `${text}\n\nIf you do not know this person, tell me to remove them from the team.` })
      .catch((error: Error) => ({ delivered: false, error: error.message }))
      .then((sent) => {
        if (!sent.delivered) console.warn(`[teams] join text to the owner failed: ${sent.error}`);
      });
    const { member: _member, ...body } = out.body;
    return { status: 201, body };
  }

  async leave(slug: string): Promise<TeamResult> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    if (m.isBoss) return bad(400, "the team boss cannot leave its own team");
    const out = await roomClient(m, this.deps.store, this.deps.fetch).leave();
    if (!out.body.ok && out.status !== 404) console.warn(`[teams] leave ${slug}: team boss answered ${out.body.error}`);
    if (m.cronJobId) {
      const removed = await this.deps.cron({ action: "remove", job_id: m.cronJobId }).catch((e: Error) => ({ success: false, error: e.message }));
      if (!removed.success) console.warn(`[teams] remove team stand-up ${m.cronJobId}: ${removed.error}`);
    }
    await this.deps.memberships.transaction((state) => {
      state.teams = state.teams.filter((t) => t.slug !== m.slug);
      return { result: undefined, changed: true };
    });
    await this.deps.onTeamsChanged();
    return { status: 200, body: { ok: true } };
  }

  async removeMember(slug: string, memberId: unknown): Promise<TeamResult> {
    const m = await this.membership(slug);
    if (!m?.isBoss) return bad(403, "only the team boss removes team members");
    return this.deps.store.removeMember(m.remoteSlug, str(memberId, 40));
  }

  async setCharter(slug: string, charter: unknown): Promise<TeamResult> {
    const m = await this.membership(slug);
    if (!m?.isBoss) return bad(403, "only the team boss changes the team charter");
    const out = await this.deps.store.setCharter(m.remoteSlug, charter);
    if (out.body.ok) await this.writeTeamFiles(m.slug, str(charter), "");
    return out;
  }

  /** Record the result of a call to the team boss (spec: tell the owner when the team room cannot be reached). */
  private async track(m: TeamMembership, out: TeamResult): Promise<void> {
    const at = this.deps.now().toISOString();
    if (out.body.ok) {
      if (m.unreachableSince || m.rejectedAt || !m.lastOkAt || at.slice(0, 13) !== m.lastOkAt.slice(0, 13)) {
        await this.deps.memberships.update(m.slug, { lastOkAt: at, unreachableSince: undefined, rejectedAt: undefined });
      }
    } else if (out.status === 502 && !m.unreachableSince) {
      await this.deps.memberships.update(m.slug, { unreachableSince: at });
    } else if (out.status === 404 && m.bossUrl && !m.rejectedAt) {
      await this.deps.memberships.update(m.slug, { rejectedAt: at });
    }
  }

  /**
   * Read the team room. Without `since`, read after the last read of the team
   * stand-up; with `advance`, move that cursor. Updates `Teams/<slug>/charter.md`
   * when the team boss has a new team charter.
   */
  async read(
    slug: string,
    opts: { since?: unknown; advance?: boolean; days?: number } = {},
  ): Promise<TeamResult<{ room: TeamRoomRead; team: Omit<TeamMembership, "token"> }>> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    const since = str(opts.since, 40) || (opts.advance ? m.lastReadId : undefined);
    // The read of the team stand-up (advance) is the read position for "Seen by" on the team boss.
    const out = await roomClient(m, this.deps.store, this.deps.fetch).read(since, { seen: opts.advance === true, ...(opts.days ? { days: opts.days } : {}) });
    await this.track(m, out);
    if (!out.body.ok) {
      const latest = (await this.membership(slug)) ?? m;
      const why = latest.rejectedAt
        ? "the team boss rejected the member token of this box (removed?)"
        : latest.unreachableSince
          ? `the team boss has not answered since ${latest.unreachableSince}`
          : out.body.error;
      return asFailure({ status: out.status, body: { ok: false, error: why } });
    }
    const room = out.body.room;
    await this.syncCharter(m, room.charter);
    const last = room.entries.at(-1)?.id;
    const updated = opts.advance && last ? await this.deps.memberships.update(m.slug, { lastReadId: last }) : undefined;
    return { status: 200, body: { ok: true, room, team: publicMembership(updated ?? m) } };
  }

  /**
   * The blocked Kanban tasks of this box on all boards, except the team boards of other
   * teams (spec team-standup). The team stand-up decides which ones wait on a team member.
   */
  async blockers(slug: string): Promise<TeamResult<{ tasks: TeamBlocker[]; truncated: boolean }>> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    const out = await this.deps.kanban({
      action: "list_blocked",
      exclude_prefix: TEAM_BOARD_PREFIX,
      include_boards: [teamBoardSlug(m.slug)],
      limit: MAX_TEAM_BLOCKERS,
    });
    if (!out.success) return bad(502, `Kanban: ${out.error ?? "list_blocked failed"}`);
    const tasks = (out.tasks ?? [])
      .filter((t) => t.task_id && t.board)
      .map((t) => ({
        taskId: String(t.task_id),
        board: String(t.board),
        title: String(t.title ?? "").slice(0, 160),
        blockKind: t.block_kind ?? null,
        blockReason: t.block_reason ? String(t.block_reason).slice(0, 240) : null,
      }));
    return { status: 200, body: { ok: true, tasks, truncated: out.truncated === true } };
  }

  private async syncCharter(m: TeamMembership, charter: string): Promise<void> {
    const folder = this.teamFolder(m.slug);
    if (!folder) return;
    const wanted = `# Team charter: ${m.slug}\n\n${charter.trim()}\n`;
    const current = await readFile(path.join(folder, "charter.md"), "utf8").catch(() => "");
    if (current !== wanted) {
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "charter.md"), wanted);
    }
  }

  /**
   * `team_post`: a message of the companion, at most MAX_COMPANION_MESSAGE_CHARS, with the team
   * cards that it names. `ownerTask` is the team question of a reply of the owner; the team boss
   * then marks the message as a reply of the owner (change boss-mode-group-chat).
   */
  async post(slug: string, input: { text?: unknown; inReplyTo?: unknown; cards?: unknown; ownerTask?: unknown }): Promise<TeamResult> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    const text = str(input.text, MAX_COMPANION_MESSAGE_CHARS + 1);
    if (text.length > MAX_COMPANION_MESSAGE_CHARS) {
      return bad(
        400,
        `a message has at most ${MAX_COMPANION_MESSAGE_CHARS} characters: write one matter in the first person, and name the team cards with cards instead of listing their states`,
      );
    }
    const ownerTask = str(input.ownerTask, 40);
    if (ownerTask && !TASK_ID_RE.test(ownerTask)) return bad(400, "ownerTask must be a Kanban task id such as t_3888bee9");
    const out = await roomClient(m, this.deps.store, this.deps.fetch).post({
      text: input.text,
      inReplyTo: input.inReplyTo,
      ...(input.cards !== undefined ? { cards: input.cards } : {}),
      ...(ownerTask ? { viaOwner: true } : {}),
    });
    await this.track(m, out);
    const entryId = out.body.ok ? (out.body as { entry?: { id?: unknown } }).entry?.id : undefined;
    if (typeof entryId === "string") {
      // Own message ids find answers to this box (early team stand-up, change boss-mode-promise-fixes).
      await this.deps.memberships.transaction((state) => {
        const found = state.teams.find((t) => t.slug === m.slug);
        if (!found) return { result: undefined, changed: false };
        found.ownMessageIds = [...(found.ownMessageIds ?? []), entryId].slice(-MAX_OWN_MESSAGE_IDS);
        return { result: undefined, changed: true };
      });
      if (ownerTask) {
        // The box closes the reply of the owner once it is posted, so a timed-out resolve turn
        // cannot leave the task for a worker that posts the reply a second time.
        const done = await this.deps
          .kanban({
            action: "complete",
            board: teamBoardSlug(m.slug),
            task_id: ownerTask,
            comment: `Posted to team ${m.slug} as ${entryId}.`,
            summary: `Reply of the owner posted as ${entryId}`,
          })
          .catch((error: Error) => ({ success: false, error: error.message }));
        if (!done.success) console.warn(`[teams] reply ${ownerTask} posted as ${entryId}, but not completed: ${done.error ?? "unknown error"}`);
      }
    }
    return out;
  }

  async card(slug: string, input: TeamCardOp): Promise<TeamResult> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    const out = await roomClient(m, this.deps.store, this.deps.fetch).card(input);
    await this.track(m, out);
    return out;
  }

  /**
   * `team_tell_owner` (spec team-standup): a short text to the owner on the owner text
   * channel, at most MAX_TELL_OWNER_PER_DAY for each team each owner-local day. With a
   * Kanban task id of the team board, the text ends with the Ref line of the nudge and the
   * owner reply goes to that Kanban task. Over the limit, a text with a Kanban task waits for
   * the next workday (`queued`); a text without a Kanban task is rejected.
   */
  async tellOwner(
    slug: string,
    input: { text?: unknown; taskId?: unknown; ask?: unknown; draft?: unknown; suspiciousMessageId?: unknown },
  ): Promise<TeamResult<{ channel: string; sentToday: number; taskId?: string; queued?: boolean }>> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    const text = str(input.text, MAX_TELL_OWNER_CHARS + 1).replace(/\s+/g, " ");
    if (!text) return bad(400, "text is required");
    if (text.length > MAX_TELL_OWNER_CHARS) return bad(400, `text has at most ${MAX_TELL_OWNER_CHARS} characters`);
    let taskId = str(input.taskId, 40);
    if (taskId && !TASK_ID_RE.test(taskId)) return bad(400, "taskId must be a Kanban task id such as t_3888bee9");
    const today = this.deps.ownerToday();
    const sentToday = m.tellOwnerDay === today ? (m.tellOwnerCount ?? 0) : 0;
    const overLimit = sentToday >= MAX_TELL_OWNER_PER_DAY;
    if (overLimit && input.ask !== true && !taskId) {
      return {
        status: 429,
        body: { ok: false, error: `at most ${MAX_TELL_OWNER_PER_DAY} texts for team ${m.slug} each day; send this text tomorrow, or combine it with a question` },
      };
    }
    if (input.ask === true && !taskId) {
      // A question to the owner (spec team-standup): a Kanban task with block kind needs_input.
      const draft = str(input.draft, 4000);
      const question = await this.createTeamTask(m, {
        kind: TEAM_QUESTION_KIND,
        title: draft ? `Draft for team ${m.slug}` : `Question for the owner: ${text.slice(0, 80)}`,
        header: { question: draft ? "draft" : "decision" },
        text: draft ? `${text}\n\n## Draft\n\n${draft}` : text,
        needsOwner: true,
        reason: `awaiting owner — ${text}`.slice(0, 200),
      });
      if (!question.ok) return bad(502, question.error);
      taskId = question.taskId;
    }
    const ref = taskId ? `\nRef: pj/${taskId}` : "";
    const sms = `[Team ${m.slug}] ${text}${ref}`;
    const emailSubject = `Multiplayer: team ${m.slug}`;
    const emailBody = `${text}${ref ? `\n${ref.trim()}` : ""}\n\nReply to this message to answer.`;
    if (overLimit && taskId) {
      // Spec team-standup (change boss-mode-promise-fixes): the Kanban task waits in the Multiplayer
      // app; the text goes out on the next workday, inside the limit of that day.
      const pending: PendingOwnerText = { taskId, sms, emailSubject, emailBody, title: text.slice(0, 120), queuedAt: this.deps.now().toISOString() };
      await this.deps.memberships.transaction((state) => {
        const found = state.teams.find((t) => t.slug === m.slug);
        if (!found) return { result: undefined, changed: false };
        found.pendingTexts = [...(found.pendingTexts ?? []).filter((p) => p.taskId !== taskId), pending];
        return { result: undefined, changed: true };
      });
      return { status: 200, body: { ok: true, channel: "queued", sentToday, taskId, queued: true } };
    }
    const sent = await this.deps.sendText({ sms, emailSubject, emailBody });
    if (!sent.delivered) return bad(502, `text not delivered: ${sent.error ?? "unknown error"}`);
    const flagged = str(input.suspiciousMessageId, 40);
    await this.deps.memberships.update(m.slug, {
      tellOwnerDay: today,
      tellOwnerCount: sentToday + 1,
      ...(flagged ? { flaggedMessageIds: [...(m.flaggedMessageIds ?? []).filter((id) => id !== flagged), flagged].slice(-200) } : {}),
    });
    if (taskId) {
      this.deps.recordOwnerQuestion({
        taskId,
        board: teamBoardSlug(m.slug),
        title: text.slice(0, 120),
        sentAt: this.deps.now().toISOString(),
        channel: sent.channel ?? "unknown",
        body: sms,
      });
    }
    return { status: 200, body: { ok: true, channel: sent.channel ?? "unknown", sentToday: sentToday + 1, ...(taskId ? { taskId } : {}) } };
  }

  /** A Kanban task on the team board, made by code so that the body format and the block kind are right. */
  private async createTeamTask(
    m: TeamMembership,
    input: { kind: string; title: string; header: Record<string, string>; text: string; needsOwner: boolean; reason: string; origin?: string },
  ): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
    const board = teamBoardSlug(m.slug);
    const header = Object.entries(input.header)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v.replace(/\s+/g, " ")}`);
    const body = [`kind: ${input.kind}`, `team: ${m.slug}`, ...header, input.origin ?? TEAM_ORIGIN_LINE, "", input.text.trim(), ""].join("\n");
    const created = await this.deps.kanban({
      action: "create",
      board,
      title: input.title,
      body,
      assignee: process.env.JOSHU_HERMES_KANBAN_ASSIGNEE?.trim() || "default",
      skills: [TEAM_STANDUP_SKILL],
      ...(this.deps.filesRoot ? { workspace_kind: "dir", workspace_path: this.deps.filesRoot } : {}),
    });
    if (!created.success || !created.task_id) return { ok: false, error: created.error ?? "kanban create failed" };
    if (input.needsOwner) {
      const blocked = await this.deps.kanban({ action: "block", board, task_id: created.task_id, kind: "needs_input", reason: input.reason });
      if (!blocked.success) return { ok: false, error: `task ${created.task_id} created but not blocked: ${blocked.error}` };
    }
    return { ok: true, taskId: created.task_id };
  }

  /**
   * `team_commit` (spec team-standup): the Kanban task of a team commitment on the team board,
   * `ready`, or blocked with `needs_input` when the work needs the owner. When the box does the
   * work of the team card, the team card gets the matching state.
   */
  async commit(
    slug: string,
    input: { card?: unknown; title?: unknown; details?: unknown; askedBy?: unknown; messageId?: unknown; needsOwner?: unknown; waitingOn?: unknown },
  ): Promise<TeamResult<{ taskId: string; board: string; cardUpdate?: string }>> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    const card = str(input.card, 20).toUpperCase();
    if (!CARD_ID_RE.test(card)) return bad(400, "card must be a team card id such as HAR-4");
    const title = str(input.title, 200);
    const details = str(input.details, 4000);
    if (!title || !details) return bad(400, "title and details are required");
    const needsOwner = input.needsOwner === true;
    const waitingOn = str(input.waitingOn, 80);
    const task = await this.createTeamTask(m, {
      kind: TEAM_COMMITMENT_KIND,
      title: `${card}: ${title}`,
      header: { team_card: card, asked_by: str(input.askedBy, 120), message_id: str(input.messageId, 40) },
      text: details,
      needsOwner,
      reason: `awaiting owner — ${waitingOn || title}`.slice(0, 200),
    });
    if (!task.ok) return bad(502, task.error);
    const update = await roomClient(m, this.deps.store, this.deps.fetch).card({
      op: "update",
      card,
      state: needsOwner ? "waiting" : "todo",
      ...(needsOwner ? { waitingOn: waitingOn || "the owner" } : {}),
    });
    return {
      status: 201,
      body: {
        ok: true,
        taskId: task.taskId,
        board: teamBoardSlug(m.slug),
        ...(update.body.ok ? {} : { cardUpdate: `team card not changed: ${update.body.error}` }),
      },
    };
  }

  /** Header fields and the draft of a Kanban task body on the team board. */
  static parseTeamTaskBody(body: string | undefined): {
    kind?: string;
    card?: string;
    question?: string;
    draft?: string;
    askedBy?: string;
    inReplyTo?: string;
    /** The text under the header, without the draft. */
    text?: string;
  } {
    const text = body ?? "";
    const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim();
    const draft = /^## Draft[ \t]*\n+([\s\S]*)$/m.exec(text)?.[1]?.trim();
    const afterHeader = text.split(/\n\s*\n/).slice(1).join("\n\n");
    const plain = afterHeader.split(/^## Draft[ \t]*$/m)[0]?.trim();
    return {
      ...(plain ? { text: plain } : {}),
      kind: field("kind"),
      card: field("team_card"),
      question: field("question"),
      askedBy: field("asked_by"),
      inReplyTo: field("in_reply_to"),
      ...(draft ? { draft } : {}),
    };
  }

  private async teamBoardTasks(m: TeamMembership): Promise<TeamBoardTask[]> {
    const listed = await this.deps.kanban({ action: "list", board: teamBoardSlug(m.slug), include_body: true, include_activity: true });
    const tasks = Array.isArray(listed.tasks) ? (listed.tasks as KanbanTaskSummary[]) : [];
    return tasks
      .filter((t) => t.task_id && t.status !== "archived")
      .map((t) => {
        const parsed = TeamService.parseTeamTaskBody(t.body);
        return {
          taskId: String(t.task_id),
          title: String(t.title ?? ""),
          status: String(t.status ?? ""),
          blockKind: t.block_kind ?? null,
          blockReason: t.block_reason ?? null,
          ...parsed,
        };
      });
  }

  /** Teams of this box for the Multiplayer app, with the number of open owner questions. */
  async appList(): Promise<TeamResult<{ teams: Array<Omit<TeamMembership, "token"> & { openQuestions: number }> }>> {
    const teams = (await this.deps.memberships.read()).teams;
    const out = [];
    for (const m of teams) {
      const tasks = await this.teamBoardTasks(m).catch(() => []);
      out.push({ ...publicMembership(m), openQuestions: tasks.filter((t) => t.status === "blocked" && t.blockKind === "needs_input").length });
    }
    return { status: 200, body: { ok: true, teams: out } };
  }

  /**
   * Everything the Multiplayer app shows for one team (design decision 10). The room comes from
   * the team boss each time and is not saved.
   */
  async view(slug: string): Promise<TeamResult<TeamView>> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    // All kept days, so "Earlier" needs no second call (design decision 4).
    const read = await this.read(m.slug, { days: RETENTION_DAYS });
    const latest = (await this.membership(m.slug)) ?? m;
    const tasks = await this.teamBoardTasks(m).catch((error: Error) => {
      console.warn(`[teams] view ${m.slug}: team board list failed: ${error.message}`);
      return [] as TeamBoardTask[];
    });
    const notesFile = this.teamFolder(m.slug);
    const notes = notesFile ? await readFile(path.join(notesFile, "notes.md"), "utf8").catch(() => "") : "";
    let standup: TeamView["standup"] = {};
    if (m.cronJobId) {
      const job = await this.deps.cron({ action: "get", job_id: m.cronJobId }).catch(() => ({ success: false }) as CronBridgeResult);
      const detail = (job.job ?? {}) as Record<string, unknown>;
      standup = {
        ...(typeof detail.last_run_at === "string" ? { lastRunAt: detail.last_run_at } : {}),
        ...(typeof detail.next_run_at === "string" ? { nextRunAt: detail.next_run_at } : {}),
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        team: publicMembership(latest),
        ...(read.body.ok ? { room: read.body.room } : { roomError: read.body.error }),
        tasks,
        questions: tasks.filter((t) => t.status === "blocked" && t.blockKind === "needs_input"),
        notes,
        notesHash: sha256(notes),
        standup,
      },
    };
  }

  /**
   * "OK, send it" in the Multiplayer app (spec team-room): only a Kanban task on board
   * team-<slug> that is blocked with needs_input. Then the same path as an SMS reply "OK".
   */
  async approveDraft(slug: string, taskId: string): Promise<TeamResult<{ taskId: string; board: string }>> {
    return this.ownerWords(slug, taskId, "OK", "approve");
  }

  /** "Answer <companion>" in the Multiplayer app: the same path as an SMS reply with these words. */
  async answer(slug: string, taskId: string, input: { text?: unknown }): Promise<TeamResult<{ taskId: string; board: string }>> {
    const text = str(input.text, MAX_OWNER_WORDS_CHARS);
    if (!text) return bad(400, "text is required");
    return this.ownerWords(slug, taskId, text, "answer");
  }

  /**
   * Reply in the Multiplayer app (spec team-room, design decision 2): a team question with
   * `question: reply` that the resolve turn of the companion posts in its own words.
   */
  async reply(slug: string, input: { text?: unknown; inReplyTo?: unknown }): Promise<TeamResult<{ taskId: string; board: string }>> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    const text = str(input.text, MAX_OWNER_WORDS_CHARS);
    if (!text) return bad(400, "text is required");
    const inReplyTo = str(input.inReplyTo, 20);
    if (!MESSAGE_ID_RE.test(inReplyTo)) return bad(400, "inReplyTo must be a message id such as m_42");
    const task = await this.createTeamTask(m, {
      kind: TEAM_QUESTION_KIND,
      title: `Reply of the owner: ${text.slice(0, 80)}`,
      header: { question: "reply", in_reply_to: inReplyTo },
      text,
      needsOwner: true,
      reason: `owner reply to ${inReplyTo}`,
      origin: OWNER_REPLY_ORIGIN_LINE,
    });
    if (!task.ok) return bad(502, task.error);
    return this.ownerWords(m.slug, task.taskId, text, "reply");
  }

  /** Give the words of the owner to a waiting Kanban task of the team board (owner reply path of the nudge). */
  private async ownerWords(slug: string, taskId: string, body: string, what: string): Promise<TeamResult<{ taskId: string; board: string }>> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    if (!TASK_ID_RE.test(taskId)) return bad(400, "unknown task");
    const board = teamBoardSlug(m.slug);
    const shown = await this.deps.kanban({ action: "show", board, task_id: taskId });
    const task = shown.task;
    if (!shown.success || !task) return bad(404, `no task ${taskId} on board ${board}`);
    if (task.status !== "blocked" || task.block_kind !== "needs_input") return bad(409, `task ${taskId} does not wait for the owner`);
    void this.deps
      .resolveOwnerReply({ taskId, board, body })
      .then((out) => console.info(`[teams] ${what} ${board}/${taskId}: ${out.action}${out.reason ? ` (${out.reason})` : ""}`))
      .catch((error: Error) => console.warn(`[teams] ${what} ${board}/${taskId} failed: ${error.message}`));
    return { status: 200, body: { ok: true, taskId, board } };
  }

  /**
   * "What I share" in the Multiplayer app (spec team-room, design decision 6): write the team
   * notes only when they did not change since the app read them.
   */
  async saveNotes(slug: string, input: { text?: unknown; baseHash?: unknown }): Promise<TeamResult<{ notes: string; notesHash: string }>> {
    const m = await this.membership(slug);
    if (!m) return bad(404, `unknown team ${slug}`);
    const folder = this.teamFolder(m.slug);
    if (!folder) return bad(404, "this box has no team folder");
    if (typeof input.text !== "string") return bad(400, "text is required");
    const file = path.join(folder, "notes.md");
    const current = await readFile(file, "utf8").catch(() => "");
    if (sha256(current) !== str(input.baseHash, 64)) {
      return { status: 409, body: { ok: false, error: "the team notes changed since you opened them", notes: current, notesHash: sha256(current) } } as unknown as TeamResult<{
        notes: string;
        notesHash: string;
      }>;
    }
    const text = input.text.endsWith("\n") ? input.text : `${input.text}\n`;
    await mkdir(folder, { recursive: true });
    await writeFile(file, text);
    return { status: 200, body: { ok: true, notes: text, notesHash: sha256(text) } };
  }

  /**
   * Give each team stand-up the current prompt. A box that made its team stand-ups with an
   * older Joshu keeps working after an update. Runs once when the Joshu API starts.
   */
  async syncStandupPrompts(): Promise<Array<{ slug: string; updated: boolean; error?: string }>> {
    const out: Array<{ slug: string; updated: boolean; error?: string }> = [];
    for (const m of (await this.deps.memberships.read()).teams) {
      if (!m.cronJobId) continue;
      const result = await this.deps
        .cron({ action: "update", job_id: m.cronJobId, prompt: teamStandupPrompt(m.slug, this.teamFolder(m.slug)) })
        .catch((error: Error) => ({ success: false, error: error.message }) as CronBridgeResult);
      out.push({ slug: m.slug, updated: result.success === true, ...(result.success ? {} : { error: result.error ?? "unknown error" }) });
    }
    return out;
  }

  /**
   * Wake check (change boss-mode-promise-fixes, spec team-standup), every few minutes from the
   * Joshu API. In the wake window: send the texts that wait for this day, then start the team
   * stand-up early when an unread entry of the team room needs this box. No model call.
   */
  async wakeCheck(): Promise<Array<{ slug: string; started: boolean; sent: number; reason?: string }>> {
    const clock = this.deps.ownerClock();
    const out: Array<{ slug: string; started: boolean; sent: number; reason?: string }> = [];
    for (const m of (await this.deps.memberships.read()).teams) {
      if (!m.cronJobId || m.rejectedAt) continue;
      const sent = await this.sendPendingTexts(m.slug, clock).catch((error: Error) => {
        console.warn(`[teams] waiting texts of ${m.slug}: ${error.message}`);
        return 0;
      });
      const result = await this.wakeTeam(m.slug, clock).catch((error: Error) => ({ started: false, reason: error.message }));
      out.push({ slug: m.slug, sent, ...result });
    }
    return out;
  }

  private async wakeTeam(slug: string, clock: OwnerClock): Promise<{ started: boolean; reason?: string }> {
    if (!inWakeWindow(clock)) return { started: false, reason: "outside the wake window" };
    const m = await this.membership(slug);
    if (!m?.cronJobId) return { started: false, reason: "no team stand-up" };
    const read = await this.read(m.slug, m.lastReadId ? { since: m.lastReadId } : {});
    if (!read.body.ok) return { started: false, reason: read.body.error };
    const triggers = findWakeTriggers(read.body.room, m.ownMessageIds ?? [], m.wakeSeq ?? 0);
    if (triggers.length === 0) return { started: false, reason: "nothing needs this box" };
    const wakeCount = m.wakeDay === clock.date ? (m.wakeCount ?? 0) : 0;
    if (wakeCount >= MAX_EARLY_STANDUPS_PER_DAY) return { started: false, reason: "daily limit of early team stand-ups" };
    const job = await this.deps.cron({ action: "get", job_id: m.cronJobId }).catch(() => ({ success: false }) as CronBridgeResult);
    const lastRunAt = (job.job as Record<string, unknown> | undefined)?.last_run_at;
    const lastRuns = [typeof lastRunAt === "string" ? Date.parse(lastRunAt) : NaN, m.lastWakeAt ? Date.parse(m.lastWakeAt) : NaN].filter(Number.isFinite);
    const sinceLast = lastRuns.length ? (this.deps.now().getTime() - Math.max(...lastRuns)) / 60_000 : Infinity;
    if (sinceLast < MIN_MINUTES_BETWEEN_STANDUPS) return { started: false, reason: "team stand-up ran less than 15 minutes ago" };
    const run = await this.deps.cron({ action: "run", job_id: m.cronJobId });
    if (!run.success) return { started: false, reason: `cron run failed: ${run.error ?? "unknown error"}` };
    await this.deps.memberships.update(m.slug, {
      wakeSeq: Math.max(...triggers.map((t) => t.seq)),
      wakeDay: clock.date,
      wakeCount: wakeCount + 1,
      lastWakeAt: this.deps.now().toISOString(),
    });
    console.info(`[teams] early team stand-up of ${m.slug}: ${triggers.map((t) => t.id).join(", ")}`);
    return { started: true };
  }

  /** Send the waiting texts of one team, oldest first, inside the limit of the day. */
  private async sendPendingTexts(slug: string, clock: OwnerClock): Promise<number> {
    if (!inWakeWindow(clock)) return 0;
    let sentNow = 0;
    for (;;) {
      const m = await this.membership(slug);
      const next = m?.pendingTexts?.[0];
      if (!m || !next) return sentNow;
      const sentToday = m.tellOwnerDay === clock.date ? (m.tellOwnerCount ?? 0) : 0;
      if (sentToday >= MAX_TELL_OWNER_PER_DAY) return sentNow;
      const board = teamBoardSlug(m.slug);
      const shown = await this.deps.kanban({ action: "show", board, task_id: next.taskId });
      const waits = shown.success && shown.task?.status === "blocked" && shown.task.block_kind === "needs_input";
      let delivered = false;
      if (waits) {
        const sent = await this.deps.sendText({ sms: next.sms, emailSubject: next.emailSubject, emailBody: next.emailBody });
        if (!sent.delivered) {
          console.warn(`[teams] waiting text ${next.taskId} of ${m.slug} not delivered: ${sent.error ?? "unknown error"}`);
          return sentNow;
        }
        delivered = true;
        this.deps.recordOwnerQuestion({
          taskId: next.taskId,
          board,
          title: next.title,
          sentAt: this.deps.now().toISOString(),
          channel: sent.channel ?? "unknown",
          body: next.sms,
        });
        sentNow += 1;
      }
      await this.deps.memberships.transaction((state) => {
        const found = state.teams.find((t) => t.slug === slug);
        if (!found) return { result: undefined, changed: false };
        found.pendingTexts = (found.pendingTexts ?? []).filter((p) => p.taskId !== next.taskId);
        if (delivered) {
          found.tellOwnerCount = (found.tellOwnerDay === clock.date ? (found.tellOwnerCount ?? 0) : 0) + 1;
          found.tellOwnerDay = clock.date;
        }
        return { result: undefined, changed: true };
      });
    }
  }

  /** Team boss side of the public preview route. */
  hostPreview(code: unknown): ReturnType<TeamRoomStore["previewInvite"]> {
    return this.deps.store.previewInvite(code);
  }

}
