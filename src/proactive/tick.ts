import { readAgentProfile } from "../nylas/profile.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { deliverProactiveNudge } from "./delivery.js";
import { pickTopStaleReviewCandidate } from "./hygieneRecord.js";
import { isOwnerAvailableForProactive } from "./meetingWindow.js";
import { pickTopProactiveCandidate } from "./sweep.js";
import {
  canSendNudge,
  ownerLocalDateString,
  readProactiveState,
  rolloverProactiveState,
  writeProactiveState,
} from "./state.js";
import type { ProactiveCandidate, ProactiveLastNudge, ProactiveState, ProactiveTickResult } from "./types.js";
import { isWithinProactiveWindow } from "./workingHours.js";

export type RunProactiveTickOpts = {
  projectRoot?: string;
  /** When true, skip send even if candidate exists (dry run). */
  dryRun?: boolean;
};

function staleReviewToCandidate(item: {
  taskId: string;
  board: string;
  title: string;
  blockReason: string | null;
}): ProactiveCandidate {
  return {
    taskId: item.taskId,
    board: item.board,
    title: item.title,
    status: "blocked",
    blockReason: item.blockReason,
    rankScore: 500,
    rankSignals: {},
  };
}

/** Deterministic hourly entry — no LLM on sweep; compose may use Hermes. */
export async function runProactiveTick(opts: RunProactiveTickOpts = {}): Promise<ProactiveTickResult> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const paths = resolveJoshuFilesPaths(projectRoot);
  if (!paths?.filesRoot) {
    return { ok: false, action: "skipped", reason: "files_root_unavailable" };
  }

  const profile = readAgentProfile(projectRoot);
  const tz = profile?.timezone?.trim();
  if (!tz) {
    return { ok: false, action: "skipped", reason: "missing_timezone" };
  }

  const today = ownerLocalDateString(tz);
  let state = rolloverProactiveState(readProactiveState(projectRoot, tz), today);

  const window = isWithinProactiveWindow(profile, state.preferences);
  if (!window.ok) {
    writeProactiveState(state, projectRoot);
    return { ok: true, action: "skipped", reason: window.reason ?? "outside_window" };
  }

  const cap = canSendNudge(state);
  if (!cap.ok) {
    writeProactiveState(state, projectRoot);
    return { ok: true, action: "skipped", reason: cap.reason ?? "daily_cap" };
  }

  let candidate = await pickTopProactiveCandidate({
    filesRoot: paths.filesRoot,
    projectRoot,
    state,
    today,
  });
  let nudgeKind: "nudge" | "stale_review" = "nudge";

  if (!candidate) {
    const stale = pickTopStaleReviewCandidate(state);
    if (stale) {
      candidate = staleReviewToCandidate(stale);
      nudgeKind = "stale_review";
    }
  }

  if (!candidate) {
    writeProactiveState(state, projectRoot);
    return { ok: true, action: "skipped", reason: "no_candidates" };
  }

  const meeting = await isOwnerAvailableForProactive(projectRoot);
  if (!meeting.ok) {
    writeProactiveState(state, projectRoot);
    return {
      ok: true,
      action: "skipped",
      reason: meeting.reason ?? "owner_in_meeting",
      candidate,
    };
  }

  if (opts.dryRun) {
    return { ok: true, action: "skipped", reason: "dry_run", candidate };
  }

  const delivery = await deliverProactiveNudge({ candidate, projectRoot, nudgeKind });
  if (!delivery.delivered) {
    return {
      ok: false,
      action: "error",
      reason: delivery.error ?? "delivery_failed",
      candidate,
    };
  }

  const lastNudge: ProactiveLastNudge = {
    taskId: candidate.taskId,
    board: candidate.board,
    title: candidate.title,
    blockReason: candidate.blockReason,
    sentAt: new Date().toISOString(),
    channel: delivery.channel ?? "unknown",
    body: delivery.body,
  };

  state = applySentNudge(state, lastNudge, today);
  writeProactiveState(state, projectRoot);

  console.info(
    `[proactive] ${nudgeKind} sent task=${candidate.taskId} board=${candidate.board} channel=${delivery.channel}`,
  );

  return { ok: true, action: "sent", candidate, channel: delivery.channel, nudge: lastNudge };
}

export function applySentNudge(
  state: ProactiveState,
  nudge: ProactiveLastNudge,
  today?: string,
): ProactiveState {
  const nudgedTaskIds = state.nudgedTaskIds.includes(nudge.taskId)
    ? state.nudgedTaskIds
    : [...state.nudgedTaskIds, nudge.taskId];
  const lastOnboardingNudgeDate =
    nudge.board === "ea-onboarding" && today ? today : state.lastOnboardingNudgeDate ?? null;
  return {
    ...state,
    sentCount: state.sentCount + 1,
    lastNudge: nudge,
    feedbackPending: true,
    nudgedTaskIds,
    lastOnboardingNudgeDate,
  };
}
