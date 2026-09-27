import { formatSessionThreadForPrompt } from "./sessionThread.js";
import type { RealtimeGoalRecord, SessionThreadTurn } from "./types.js";
import { extractLinks } from "./voiceLinks.js";

const HERMES_THREAD_TURNS = 4;
const DETAIL_CHARS = 600;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS)}…` : flat;
}

/**
 * Full links from this goal's latest output plus whether they reached the
 * owner's phone. Listed separately because the excerpt truncates, and workers
 * put the handoff URL last — without it Hermes cannot re-send or email the link
 * and falls back on stale memory.
 */
function linkFacts(goal: RealtimeGoalRecord, detail: string): string {
  const links = extractLinks(detail);
  if (links.length === 0) return "";
  const listed = `\n  Links: ${links.join(" ")}`;
  if (goal.linksTextedAt) return `${listed}\n  Texted to the owner's phone at ${goal.linksTextedAt}.`;
  // Text channels deliver the result (link included) as the message itself;
  // only a phone call can leave the owner with a link they never received.
  return goal.origin.channel === "pstn_voice"
    ? `${listed}\n  NOT texted to the owner yet (not sent anywhere they can tap).`
    : listed;
}

/** One goal with what it is waiting on or what it found. */
function goalLine(goal: RealtimeGoalRecord): string {
  // Parked = the owner could not be reached; they have not heard this yet.
  const unheard = goal.delivery.state === "parked" ? ", update not yet heard by owner" : "";
  const head = `- ${goal.title} (${goal.status}${unheard})`;
  if (goal.status === "blocked" && goal.lastBlockReason) {
    return `${head}\n  Waiting on owner: ${excerpt(goal.lastBlockReason)}${linkFacts(goal, goal.lastBlockReason)}`;
  }
  if (goal.resultSummary) {
    return `${head}\n  Result: ${excerpt(goal.resultSummary)}${linkFacts(goal, goal.resultSummary)}`;
  }
  return head;
}

/** Compact broker snapshot for Hermes pass turns on queue-capable channels. */
export function buildHermesBrokerContextMessage(
  activeGoals: RealtimeGoalRecord[],
  threadTurns: SessionThreadTurn[],
  activeBranch?: RealtimeGoalRecord,
  recentlyFinished: RealtimeGoalRecord[] = [],
): string | undefined {
  if (
    activeGoals.length === 0 &&
    threadTurns.length === 0 &&
    !activeBranch &&
    recentlyFinished.length === 0
  ) {
    return undefined;
  }

  const lines = [
    "Background work context (authoritative — do not contradict cancelled/queued state,",
    "and prefer these results over older memory of the same task):",
  ];

  if (activeBranch) {
    lines.push(`Active branch: ${activeBranch.title} (${activeBranch.status})`);
  }

  if (activeGoals.length > 0) {
    lines.push("Active background goals:");
    for (const goal of activeGoals.slice(0, 6)) lines.push(goalLine(goal));
  } else {
    lines.push("Active background goals: (none)");
  }

  if (recentlyFinished.length > 0) {
    lines.push("Recently finished (already reported to the owner):");
    for (const goal of recentlyFinished.slice(0, 4)) lines.push(goalLine(goal));
  }

  const recentThread = formatSessionThreadForPrompt(threadTurns, HERMES_THREAD_TURNS);
  if (recentThread !== "(empty)") {
    lines.push("", "Recent owner↔box thread:", recentThread);
  }

  return lines.join("\n");
}
