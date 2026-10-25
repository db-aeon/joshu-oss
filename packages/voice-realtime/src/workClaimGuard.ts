/**
 * "I'm still looking into this for you" was said on a call (2026-10-14) while
 * no tool call ran. The owner had cut off "Let me check your" with an "um", so
 * the think call never went out, and the voice agent believed its own words.
 *
 * Native async tool path only. The guard keeps the latest work claim of an
 * interaction and decides when the interaction ends (`interactionStatus:
 * IDLE`), because a NON_BLOCKING tool call can arrive after the speech. A work
 * claim with no tool call and no running tool call gets a note that tells the
 * voice agent the facts. The voice agent decides what to do with the note.
 */
import type { VoiceS2sClient } from "./voiceS2sTypes.js";
import { voiceLog, voiceWarn } from "./voiceLog.js";

const WORK_CLAIM_PATTERNS: RegExp[] = [
  // "Let me check your calendar", "let me see if I can find it"
  /\blet me\s+(?:just\s+|quickly\s+)?(?:check|look|see if|find|search|pull|dig|take a look)\b/i,
  // "I'm still looking into this", "I am working on it"
  /\bi(?:'m| am)\s+(?:still\s+|now\s+|just\s+)?(?:checking|looking (?:into|for|up|at|through)|searching|working on|pulling|digging|trying to find)\b/i,
  // "I'll check", "I will look into it"
  /\bi(?:'ll| will)\s+(?:just\s+|quickly\s+)?(?:check|look (?:into|for|up|at|through)|search|find|pull)\b/i,
  // "Still working on it."
  /\bstill\s+(?:looking into|working on|checking)\b/i,
  // "Give me a moment", "one second"
  /\b(?:give me a|just a|one)\s+(?:moment|second|sec)\b/i,
];

/** True when the voice agent says it is checking or working on something now. */
export function detectWorkClaim(text: string): boolean {
  return WORK_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

const MAX_QUOTE_CHARS = 160;

/** Non-turn context for a work claim that no tool call backs. */
export function workClaimNote(claim: string): string {
  const quote = claim.replace(/"/g, "'").slice(0, MAX_QUOTE_CHARS);
  return (
    `[Joshu: you said "${quote}", but you called no tool, and no tool call is running on this call. ` +
    "Saying it starts nothing. If the owner asked for something that you have not looked up, call think or start_task now. " +
    "If you meant work that was queued earlier, tell the owner that it is queued and how they will hear back. " +
    "Do not read this note aloud.]"
  );
}

export type WorkClaimNudge = {
  claim: string;
  note: string;
  /** Ask the voice agent for a turn after the note (a finished reply, at most once per owner utterance). */
  requestTurn: boolean;
};

export class WorkClaimGuard {
  private claim: { text: string; interrupted: boolean } | undefined;
  private turnRequestedSinceOwnerSpoke = false;

  /** A reply of the voice agent that it chose to say (not a tool result or a turn Joshu wrote). */
  noteReply(text: string, interrupted: boolean): void {
    const trimmed = text.trim();
    if (trimmed && detectWorkClaim(trimmed)) this.claim = { text: trimmed, interrupted };
  }

  noteOwnerSpoke(): void {
    this.turnRequestedSinceOwnerSpoke = false;
  }

  /** The interaction ended. Returns the nudge to send when no tool call backs its work claim. */
  onInteractionEnd(info: {
    functionCalls: readonly string[];
    toolRunning: boolean;
    callEnding?: boolean;
  }): WorkClaimNudge | undefined {
    const claim = this.claim;
    this.claim = undefined;
    if (!claim || info.functionCalls.length > 0 || info.toolRunning) return undefined;
    const requestTurn = !claim.interrupted && !info.callEnding && !this.turnRequestedSinceOwnerSpoke;
    if (requestTurn) this.turnRequestedSinceOwnerSpoke = true;
    return { claim: claim.text, note: workClaimNote(claim.text), requestTurn };
  }
}

/** Log the nudge, add the note, and ask for a turn when the guard says so. */
export function sendWorkClaimNudge(
  s2s: VoiceS2sClient | null | undefined,
  sessionId: string,
  nudge: WorkClaimNudge | undefined,
): void {
  if (!nudge || !s2s) return;
  voiceWarn(sessionId, "eval", "ANTIPATTERN work-claim-without-tool", {
    claim: nudge.claim.slice(0, 200),
    requestTurn: nudge.requestTurn,
  });
  s2s.appendContext(nudge.note);
  if (!nudge.requestTurn) return;
  voiceLog(sessionId, "eval", "work claim: asking the voice agent for a turn");
  s2s.requestOrganicResponse();
}
