/**
 * Early team stand-up (change boss-mode-promise-fixes, spec team-standup): code rules,
 * no model call, that say when an entry of the team room needs this box now.
 */
import type { TeamRoomEntry, TeamRoomRead } from "./types.js";

/** Minutes between two wake checks (`JOSHU_TEAM_WAKE_MINUTES`; 0 turns the wake loop off). */
export const DEFAULT_TEAM_WAKE_MINUTES = 15;
/** Most early team stand-ups for one team in one owner-local day. */
export const MAX_EARLY_STANDUPS_PER_DAY = 4;
/** No early team stand-up within this many minutes after the last team stand-up. */
export const MIN_MINUTES_BETWEEN_STANDUPS = 15;
/** Wake window: workdays, from this owner-local hour (inclusive) to WAKE_END_HOUR (exclusive). */
export const WAKE_START_HOUR = 8;
export const WAKE_END_HOUR = 19;
/** Ids of the last messages that this box posted, kept to find answers to them. */
export const MAX_OWN_MESSAGE_IDS = 200;

const WORKDAYS = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);

/** Owner-local clock: date `YYYY-MM-DD`, hour 0 to 23, and the English weekday name. */
export type OwnerClock = { date: string; hour: number; weekday: string };

export function teamWakeMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JOSHU_TEAM_WAKE_MINUTES?.trim();
  if (!raw) return DEFAULT_TEAM_WAKE_MINUTES;
  const minutes = Number.parseInt(raw, 10);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_TEAM_WAKE_MINUTES;
}

export function isWorkday(clock: OwnerClock): boolean {
  return WORKDAYS.has(clock.weekday);
}

/** True on workdays from 08:00 to 19:00 in the local time of the owner. */
export function inWakeWindow(clock: OwnerClock): boolean {
  return isWorkday(clock) && clock.hour >= WAKE_START_HOUR && clock.hour < WAKE_END_HOUR;
}

function mentions(text: string, companionName: string): boolean {
  const name = companionName.trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

/**
 * Entries that need this box now: written by another team member, and a message that
 * names the companion with "@", a message that answers a message of this box, or a team
 * card event about a team card that this box does or asked for.
 */
export function findWakeTriggers(room: TeamRoomRead, ownMessageIds: readonly string[], afterSeq = 0): TeamRoomEntry[] {
  const me = room.you;
  const companionName = room.members.find((m) => m.id === me)?.companionName ?? "";
  const own = new Set(ownMessageIds);
  const myCards = new Set(room.cards.filter((c) => c.doer === me || c.asker === me).map((c) => c.id));
  return room.entries.filter((entry) => {
    if (entry.seq <= afterSeq || entry.author === me) return false;
    if (entry.kind === "event") return myCards.has(entry.card);
    return mentions(entry.text, companionName) || (entry.inReplyTo !== undefined && own.has(entry.inReplyTo));
  });
}
