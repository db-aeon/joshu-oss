/**
 * Team rooms that this box hosts as team boss (spec team-room).
 *
 * Each team room is a folder `<teams dir>/hosted/<team slug>/` with `room.json`
 * (team charter, team members, invite codes, team projects, team cards) and
 * `log.jsonl` (messages and team card events). The folder is outside the owner
 * files root: member tokens must stay secret, and the team stand-up of another
 * team must not read the log through files (design decision 5).
 * Writes for one team room are serialized in this process.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  TEAM_CARD_STATE_LABELS,
  type TeamAvatar,
  type TeamCard,
  type TeamCardCopy,
  type TeamCardState,
  type TeamMember,
  type TeamMemberView,
  type TeamResult,
  type TeamRoomEntry,
  type TeamRoomRead,
  type TeamRoomState,
} from "./types.js";

export const INVITE_DAYS = 7;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_DAILY_WRITES = 50;
export const RETENTION_DAYS = 90;
export const READ_DEFAULT_DAYS = 7;
export const MAX_CARD_TITLE_CHARS = 200;
export const MAX_MESSAGE_CARDS = 10;
export const MAX_AVATAR_BYTES = 64 * 1024;
export const MAX_NAME_CHARS = 80;
export const MAX_CHARTER_CHARS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PROJECT_CODE_RE = /^[A-Z][A-Z0-9]{1,5}$/;
const STATES = Object.keys(TEAM_CARD_STATE_LABELS) as TeamCardState[];

/** A log entry before the team boss gives it an id, a sequence number, and a time. */
type NewTeamRoomEntry =
  | { kind: "message"; author: string; text: string; inReplyTo?: string; cards?: TeamCardCopy[]; viaOwner?: true }
  | { kind: "event"; author: string; card: string; text: string };

export type TeamProfile = { ownerName?: unknown; companionName?: unknown; avatar?: unknown };

export type TeamCardOp =
  | { op: "create"; title?: unknown; project?: unknown; doer?: unknown; due?: unknown; waitingOn?: unknown; state?: unknown }
  | { op: "update"; card?: unknown; state?: unknown; due?: unknown; waitingOn?: unknown; doer?: unknown; project?: unknown }
  | { op: "project_add"; code?: unknown; name?: unknown; note?: unknown }
  | { op: "project_rename"; code?: unknown; name?: unknown; note?: unknown };

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function newSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function str(value: unknown, max = 10_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function isTeamSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function memberLabel(m: Pick<TeamMember, "ownerName" | "companionName">): string {
  return `${m.ownerName}'s Joshu (${m.companionName})`;
}

/** Avatar as sent at join: PNG or JPEG, base64, at most MAX_AVATAR_BYTES. */
export function parseAvatar(value: unknown): { ok: true; avatar?: TeamAvatar } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true };
  const v = value as { mime?: unknown; base64?: unknown };
  if (v.mime !== "image/png" && v.mime !== "image/jpeg") return { ok: false, error: "avatar must be image/png or image/jpeg" };
  const base64 = typeof v.base64 === "string" ? v.base64.replace(/\s+/g, "") : "";
  if (!base64 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) return { ok: false, error: "avatar base64 is not valid" };
  if (Buffer.from(base64, "base64").length > MAX_AVATAR_BYTES) {
    return { ok: false, error: `avatar is larger than ${MAX_AVATAR_BYTES} bytes` };
  }
  return { ok: true, avatar: { mime: v.mime, base64 } };
}

function parseProfile(profile: TeamProfile): { ok: true; ownerName: string; companionName: string; avatar?: TeamAvatar } | { ok: false; error: string } {
  const ownerName = str(profile.ownerName, MAX_NAME_CHARS);
  const companionName = str(profile.companionName, MAX_NAME_CHARS);
  if (!ownerName || !companionName) return { ok: false, error: "ownerName and companionName are required" };
  const avatar = parseAvatar(profile.avatar);
  if (!avatar.ok) return avatar;
  return { ok: true, ownerName, companionName, ...(avatar.avatar ? { avatar: avatar.avatar } : {}) };
}

const fail = (status: 400 | 403 | 404 | 409 | 413 | 429, error: string) =>
  ({ status, body: { ok: false as const, error } });
/** One rejection for each failed member check (spec: only team members can call a team room). */
export const NOT_FOUND = fail(404, "not found");

function isActive(m: TeamMember): boolean {
  return !m.removedAt && !m.leftAt;
}

export class TeamRoomStore {
  private readonly hostedDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    teamsDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.hostedDir = path.join(teamsDir, "hosted");
  }

  private roomFile(slug: string): string {
    return path.join(this.hostedDir, slug, "room.json");
  }

  private logFile(slug: string): string {
    return path.join(this.hostedDir, slug, "log.jsonl");
  }

  private withLock<T>(slug: string, run: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(slug) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(run);
    this.locks.set(slug, next);
    return next;
  }

  private async readRoom(slug: string): Promise<TeamRoomState | undefined> {
    if (!isTeamSlug(slug)) return undefined;
    try {
      return JSON.parse(await readFile(this.roomFile(slug), "utf8")) as TeamRoomState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`team room ${slug} read failed: ${(error as Error).message}`);
    }
  }

  private async writeRoom(room: TeamRoomState): Promise<void> {
    const file = this.roomFile(room.slug);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(room, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  private async readLog(slug: string): Promise<TeamRoomEntry[]> {
    try {
      const raw = await readFile(this.logFile(slug), "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as TeamRoomEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Append one entry; delete log entries and Done team cards older than RETENTION_DAYS. */
  private async append(room: TeamRoomState, entry: NewTeamRoomEntry): Promise<TeamRoomEntry> {
    const at = this.now();
    room.seq += 1;
    const full = { ...entry, seq: room.seq, id: `m_${room.seq}`, at: at.toISOString() } as TeamRoomEntry;
    const cutoff = at.getTime() - RETENTION_DAYS * DAY_MS;
    const log = await this.readLog(room.slug);
    if (log.length > 0 && Date.parse(log[0]!.at) < cutoff) {
      const kept = log.filter((e) => Date.parse(e.at) >= cutoff);
      kept.push(full);
      const file = this.logFile(room.slug);
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
      await rename(temp, file);
    } else {
      await mkdir(path.dirname(this.logFile(room.slug)), { recursive: true, mode: 0o700 });
      await appendFile(this.logFile(room.slug), `${JSON.stringify(full)}\n`, { mode: 0o600 });
    }
    room.cards = room.cards.filter((c) => !(c.state === "done" && c.doneAt && Date.parse(c.doneAt) < cutoff));
    return full;
  }

  private async writesToday(slug: string, memberId: string): Promise<number> {
    const day = this.now().toISOString().slice(0, 10);
    return (await this.readLog(slug)).filter((e) => e.author === memberId && e.at.startsWith(day)).length;
  }

  async listHosted(): Promise<string[]> {
    try {
      const names = await readdir(this.hostedDir);
      const slugs: string[] = [];
      for (const name of names) if (await this.readRoom(name)) slugs.push(name);
      return slugs.sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async createTeam(input: { slug?: unknown; charter?: unknown; boss: TeamProfile }): Promise<TeamResult<{ slug: string; memberId: string; token: string }>> {
    const slug = str(input.slug, 40).toLowerCase();
    const charter = str(input.charter, MAX_CHARTER_CHARS);
    if (!isTeamSlug(slug)) return fail(400, "team slug must be 1 to 40 characters: a-z, 0-9, and -");
    if (!charter) return fail(400, "team charter is required");
    const profile = parseProfile(input.boss);
    if (!profile.ok) return fail(400, profile.error);
    return this.withLock(slug, async () => {
      if (await this.readRoom(slug)) return fail(409, `team ${slug} exists`);
      const at = this.now().toISOString();
      const token = newSecret(32);
      const boss: TeamMember = {
        id: `tm_${randomBytes(4).toString("hex")}`,
        ownerName: profile.ownerName,
        companionName: profile.companionName,
        ...(profile.avatar ? { avatar: profile.avatar } : {}),
        tokenHash: hashSecret(token),
        isBoss: true,
        joinedAt: at,
      };
      await this.writeRoom({
        version: 1, slug, charter, createdAt: at, members: [boss], invites: [], projects: [], cards: [], seq: 0, cardNumbers: {},
      });
      return { status: 201, body: { ok: true, slug, memberId: boss.id, token } };
    });
  }

  async makeInvite(slug: string): Promise<TeamResult<{ code: string; expiresAt: string }>> {
    return this.withLock(slug, async () => {
      const room = await this.readRoom(slug);
      if (!room) return NOT_FOUND;
      const now = this.now();
      const code = newSecret(18);
      const expiresAt = new Date(now.getTime() + INVITE_DAYS * DAY_MS).toISOString();
      room.invites = room.invites.filter((i) => !i.usedAt && Date.parse(i.expiresAt) > now.getTime());
      room.invites.push({ codeHash: hashSecret(code), createdAt: now.toISOString(), expiresAt });
      await this.writeRoom(room);
      return { status: 201, body: { ok: true, code, expiresAt } };
    });
  }

  /** The team charter and the team boss of a valid invite code, without using the code (join preview). */
  async previewInvite(codeInput: unknown): Promise<TeamResult<{ slug: string; charter: string; boss: string }>> {
    const codeHash = hashSecret(str(codeInput, 200));
    for (const slug of await this.listHosted()) {
      const room = await this.readRoom(slug);
      const invite = room?.invites.find((i) => i.codeHash === codeHash);
      if (!room || !invite) continue;
      if (invite.usedAt || Date.parse(invite.expiresAt) <= this.now().getTime()) return NOT_FOUND;
      const boss = room.members.find((m) => m.isBoss);
      return { status: 200, body: { ok: true, slug, charter: room.charter, boss: boss ? memberLabel(boss) : "" } };
    }
    return NOT_FOUND;
  }

  /** Join with an invite code. The team boss finds the team from the code alone. */
  async join(codeInput: unknown, profileInput: TeamProfile): Promise<TeamResult<{ slug: string; memberId: string; token: string; charter: string; member: TeamMemberView }>> {
    const code = str(codeInput, 200);
    if (!code) return NOT_FOUND;
    const profile = parseProfile(profileInput);
    if (!profile.ok) return fail(profile.error.startsWith("avatar is larger") ? 413 : 400, profile.error);
    const codeHash = hashSecret(code);
    for (const slug of await this.listHosted()) {
      const out = await this.withLock(slug, async () => {
        const room = await this.readRoom(slug);
        const invite = room?.invites.find((i) => i.codeHash === codeHash);
        if (!room || !invite) return undefined;
        if (invite.usedAt || Date.parse(invite.expiresAt) <= this.now().getTime()) return NOT_FOUND;
        const token = newSecret(32);
        const member: TeamMember = {
          id: `tm_${randomBytes(4).toString("hex")}`,
          ownerName: profile.ownerName,
          companionName: profile.companionName,
          ...(profile.avatar ? { avatar: profile.avatar } : {}),
          tokenHash: hashSecret(token),
          isBoss: false,
          joinedAt: this.now().toISOString(),
        };
        room.members.push(member);
        invite.usedAt = member.joinedAt;
        invite.usedBy = member.id;
        await this.writeRoom(room);
        return {
          status: 201 as const,
          body: { ok: true as const, slug, memberId: member.id, token, charter: room.charter, member: this.view(member) },
        };
      });
      if (out) return out;
    }
    return NOT_FOUND;
  }

  /** The active team member of a member token, or undefined. */
  async authenticate(slug: string, token: string): Promise<TeamMember | undefined> {
    if (!token) return undefined;
    const room = await this.readRoom(slug);
    const hash = hashSecret(token);
    return room?.members.find((m) => m.tokenHash === hash && isActive(m));
  }

  /** The team member that the team boss itself is (local calls of the box). */
  async bossMember(slug: string): Promise<TeamMember | undefined> {
    return (await this.readRoom(slug))?.members.find((m) => m.isBoss && isActive(m));
  }

  private view(m: TeamMember): TeamMemberView & { active: boolean } {
    return {
      id: m.id,
      ownerName: m.ownerName,
      companionName: m.companionName,
      label: memberLabel(m),
      ...(m.avatar ? { avatar: m.avatar } : {}),
      isBoss: m.isBoss,
      active: isActive(m),
    };
  }

  private activeMember(room: TeamRoomState, memberId: string): TeamMember | undefined {
    return room.members.find((m) => m.id === memberId && isActive(m));
  }

  async post(
    slug: string,
    memberId: string,
    input: { text?: unknown; inReplyTo?: unknown; cards?: unknown; viaOwner?: unknown },
  ): Promise<TeamResult<{ entry: TeamRoomEntry }>> {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) return fail(400, "text is required");
    if (text.length > MAX_MESSAGE_CHARS) return fail(413, `a message has at most ${MAX_MESSAGE_CHARS} characters`);
    const inReplyTo = str(input.inReplyTo, 40);
    const cardIds = Array.isArray(input.cards) ? [...new Set(input.cards.map((c) => str(c, 20).toUpperCase()).filter(Boolean))] : [];
    if (cardIds.length > MAX_MESSAGE_CARDS) return fail(400, `a message names at most ${MAX_MESSAGE_CARDS} team cards`);
    return this.withLock(slug, async () => {
      const room = await this.readRoom(slug);
      if (!room || !this.activeMember(room, memberId)) return NOT_FOUND;
      // A copy of each named team card as it is now, so the message keeps that state (spec team-room).
      const cards: TeamCardCopy[] = [];
      for (const id of cardIds) {
        const card = room.cards.find((c) => c.id === id);
        if (!card) return fail(400, `unknown team card ${id}`);
        cards.push({ id: card.id, title: card.title, state: card.state, doer: card.doer, ...(card.waitingOn ? { waitingOn: card.waitingOn } : {}) });
      }
      if ((await this.writesToday(slug, memberId)) >= MAX_DAILY_WRITES) {
        return fail(429, `at most ${MAX_DAILY_WRITES} messages and team card changes each day`);
      }
      const entry = await this.append(room, {
        kind: "message",
        author: memberId,
        text,
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(cards.length ? { cards } : {}),
        ...(input.viaOwner === true ? { viaOwner: true as const } : {}),
      });
      await this.writeRoom(room);
      return { status: 201, body: { ok: true, entry } };
    });
  }

  async card(slug: string, memberId: string, input: TeamCardOp): Promise<TeamResult<{ card?: TeamCard; project?: { code: string; name: string } }>> {
    return this.withLock(slug, async () => {
      const room = await this.readRoom(slug);
      const caller = room ? this.activeMember(room, memberId) : undefined;
      if (!room || !caller) return NOT_FOUND;
      const nameOf = (id: string) => room.members.find((m) => m.id === id)?.companionName ?? id;

      if (input.op === "project_add" || input.op === "project_rename") {
        const code = str(input.code, 6).toUpperCase();
        const name = str(input.name, 80);
        const note = str(input.note, 200);
        const existing = room.projects.find((p) => p.code === code);
        if (input.op === "project_add") {
          if (!PROJECT_CODE_RE.test(code)) return fail(400, "project code must be 2 to 6 characters: A-Z and 0-9, first a letter");
          if (!name) return fail(400, "project name is required");
          if (existing) return fail(409, `project ${code} exists`);
          room.projects.push({ code, name, ...(note ? { note } : {}) });
        } else {
          if (!caller.isBoss) return fail(403, "only the team boss renames a team project");
          if (!existing) return fail(404, `unknown project ${code}`);
          if (name) existing.name = name;
          if (note) existing.note = note;
        }
        await this.writeRoom(room);
        return { status: 200, body: { ok: true, project: { code, name: name || existing?.name || "" } } };
      }

      if ((await this.writesToday(slug, memberId)) >= MAX_DAILY_WRITES) {
        return fail(429, `at most ${MAX_DAILY_WRITES} messages and team card changes each day`);
      }
      const at = this.now().toISOString();

      if (input.op === "create") {
        const title = str(input.title, MAX_CARD_TITLE_CHARS + 1);
        if (!title) return fail(400, "title is required");
        if (title.length > MAX_CARD_TITLE_CHARS) return fail(413, `a card title has at most ${MAX_CARD_TITLE_CHARS} characters`);
        const project = str(input.project, 6).toUpperCase();
        if (!room.projects.some((p) => p.code === project)) return fail(400, `unknown project ${project}; add it first`);
        const doer = str(input.doer, 40) || caller.id;
        if (!this.activeMember(room, doer)) return fail(400, `unknown team member ${doer}`);
        const state = str(input.state, 10) as TeamCardState;
        if (state && !STATES.includes(state)) return fail(400, `state must be one of ${STATES.join(", ")}`);
        if (state && doer !== caller.id) return fail(403, "only the team member who does the work sets the state");
        const n = (room.cardNumbers[project] ?? 0) + 1;
        room.cardNumbers[project] = n;
        const card: TeamCard = {
          id: `${project}-${n}`,
          title,
          project,
          state: state || "todo",
          doer,
          asker: caller.id,
          ...(str(input.due, 80) ? { due: str(input.due, 80) } : {}),
          ...(str(input.waitingOn, 80) ? { waitingOn: str(input.waitingOn, 80) } : {}),
          createdAt: at,
          updatedAt: at,
        };
        room.cards.push(card);
        await this.append(room, {
          kind: "event",
          author: caller.id,
          card: card.id,
          text: `${caller.companionName} created ${card.id} "${title}" for ${nameOf(doer)}`,
        });
        await this.writeRoom(room);
        return { status: 201, body: { ok: true, card } };
      }

      const card = room.cards.find((c) => c.id === str(input.card, 20).toUpperCase());
      if (!card) return fail(404, `unknown card ${str(input.card, 20)}`);
      const has = (v: unknown) => v !== undefined && v !== null;
      const doerChange = has(input.state) || has(input.due) || has(input.waitingOn);
      const bossChange = has(input.doer) || has(input.project);
      if (!doerChange && !bossChange) return fail(400, "nothing to change");
      // Only the team member who does the work moves the card; the team boss decides who does what.
      if (doerChange && card.doer !== caller.id) return fail(403, "only the team member who does the work changes the state, the due text, and the waiting-on text");
      if (bossChange && !caller.isBoss) return fail(403, "only the team boss changes the team member or the project of a card");

      const notes: string[] = [];
      if (has(input.state)) {
        const state = str(input.state, 10) as TeamCardState;
        if (!STATES.includes(state)) return fail(400, `state must be one of ${STATES.join(", ")}`);
        if (state !== card.state) {
          card.state = state;
          if (state === "done") card.doneAt = at;
          else delete card.doneAt;
          notes.push(`moved ${card.id} to ${TEAM_CARD_STATE_LABELS[state]}`);
        }
      }
      if (has(input.due)) {
        const due = str(input.due, 80);
        if (due) card.due = due;
        else delete card.due;
        notes.push(`set the due text of ${card.id}`);
      }
      if (has(input.waitingOn)) {
        const waitingOn = str(input.waitingOn, 80);
        if (waitingOn) card.waitingOn = waitingOn;
        else delete card.waitingOn;
        notes.push(waitingOn ? `set ${card.id} waiting on ${waitingOn}` : `cleared the waiting-on text of ${card.id}`);
      }
      if (has(input.doer)) {
        const doer = str(input.doer, 40);
        if (!this.activeMember(room, doer)) return fail(400, `unknown team member ${doer}`);
        if (doer !== card.doer) {
          card.doer = doer;
          notes.push(`gave ${card.id} to ${nameOf(doer)}`);
        }
      }
      if (has(input.project)) {
        const project = str(input.project, 6).toUpperCase();
        const target = room.projects.find((p) => p.code === project);
        if (!target) return fail(400, `unknown project ${project}`);
        if (project !== card.project) {
          card.project = project;
          notes.push(`moved ${card.id} to project ${target.name}`);
        }
      }
      if (notes.length === 0) return { status: 200, body: { ok: true, card } };
      card.updatedAt = at;
      await this.append(room, { kind: "event", author: caller.id, card: card.id, text: `${caller.companionName} ${notes.join("; ")}` });
      await this.writeRoom(room);
      return { status: 200, body: { ok: true, card } };
    });
  }

  /**
   * Messages and team card events after `since` (a message id), oldest first, with the
   * current team cards, team projects, and team members. Without `since`: the last
   * READ_DEFAULT_DAYS days.
   */
  async read(
    slug: string,
    memberId: string,
    since?: unknown,
    opts: { seen?: boolean; days?: number } = {},
  ): Promise<TeamResult<{ room: TeamRoomRead }>> {
    const first = await this.readRoom(slug);
    if (!first || !this.activeMember(first, memberId)) return NOT_FOUND;
    const now = this.now().getTime();
    const cutoff = now - RETENTION_DAYS * DAY_MS;
    const sinceSeq = Number(String(since ?? "").replace(/^m_/, ""));
    const days = opts.days && opts.days > 0 ? Math.min(opts.days, RETENTION_DAYS) : READ_DEFAULT_DAYS;
    const fromTime = now - days * DAY_MS;
    const entries = (await this.readLog(slug)).filter((e) => {
      const t = Date.parse(e.at);
      if (t < cutoff) return false;
      return Number.isFinite(sinceSeq) && sinceSeq > 0 ? e.seq > sinceSeq : t >= fromTime;
    });
    const newest = entries.at(-1)?.seq ?? 0;
    // The read of the team stand-up is the read position for "Seen by" (change boss-mode-group-chat).
    const room =
      opts.seen && newest > 0
        ? await this.withLock(slug, async () => {
            const latest = (await this.readRoom(slug)) ?? first;
            const me = latest.members.find((m) => m.id === memberId);
            if (me && (me.seenSeq ?? 0) < newest) {
              me.seenSeq = newest;
              await this.writeRoom(latest);
            }
            return latest;
          })
        : first;
    const cards = room.cards.filter((c) => !(c.state === "done" && c.doneAt && Date.parse(c.doneAt) < cutoff));
    const seen = Object.fromEntries(room.members.filter((m) => m.seenSeq).map((m) => [m.id, `m_${m.seenSeq}`]));
    return {
      status: 200,
      body: {
        ok: true,
        room: {
          slug,
          charter: room.charter,
          you: memberId,
          entries,
          cards,
          projects: room.projects,
          members: room.members.map((m) => this.view(m)),
          seen,
        },
      },
    };
  }

  async setCharter(slug: string, charterInput: unknown): Promise<TeamResult> {
    const charter = str(charterInput, MAX_CHARTER_CHARS);
    if (!charter) return fail(400, "team charter is required");
    return this.withLock(slug, async () => {
      const room = await this.readRoom(slug);
      if (!room) return NOT_FOUND;
      room.charter = charter;
      await this.writeRoom(room);
      return { status: 200, body: { ok: true } };
    });
  }

  async removeMember(slug: string, memberId: string): Promise<TeamResult> {
    return this.withLock(slug, async () => {
      const room = await this.readRoom(slug);
      const member = room?.members.find((m) => m.id === memberId && isActive(m));
      if (!room || !member) return NOT_FOUND;
      if (member.isBoss) return fail(400, "the team boss cannot remove itself");
      member.removedAt = this.now().toISOString();
      await this.writeRoom(room);
      return { status: 200, body: { ok: true } };
    });
  }

  async leave(slug: string, memberId: string): Promise<TeamResult> {
    return this.withLock(slug, async () => {
      const room = await this.readRoom(slug);
      const member = room ? this.activeMember(room, memberId) : undefined;
      if (!room || !member) return NOT_FOUND;
      if (member.isBoss) return fail(400, "the team boss cannot leave its own team");
      member.leftAt = this.now().toISOString();
      await this.writeRoom(room);
      return { status: 200, body: { ok: true } };
    });
  }

  async memberView(slug: string, memberId: string): Promise<TeamMemberView | undefined> {
    const m = (await this.readRoom(slug))?.members.find((x) => x.id === memberId);
    return m ? this.view(m) : undefined;
  }
}
