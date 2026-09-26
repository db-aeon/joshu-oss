/** Hermes inject wording for OpenAI Realtime speech after brain completes. */

export type InjectPresentation = "screen" | "voice_only";

/**
 * answer: a result to relay. question: Joshu needs the caller's decision to continue.
 * callback_*: same, on an outbound call Joshu placed — the model must lead with why it
 * called (it "forgot why it called" when handed a bare result, canary box 2026-09-25).
 */
export type InjectKind = "answer" | "question" | "callback_answer" | "callback_question";

const CALLBACK_HEADER =
  "[Joshu placed this call to the owner to report on background work they asked for earlier — they did not call you]";

/**
 * Phone relays must stay faithful: a loose "summary" dropped the takeoff times
 * the caller asked for and invented a fare that was not in the result
 * (canary box 2026-09-24).
 */
const VOICE_FIDELITY_RULES = [
  "Speak as yourself, in first person.",
  "Lead with the direct answer to what the caller asked.",
  "Keep every time, date, price, name, and number exactly as written — never invent, round, or drop one.",
  "Skip internal system details (error codes, browser or tool status).",
].join(" ");

export function injectHermesResultUserText(
  hermesText: string,
  presentation: InjectPresentation,
  kind: InjectKind = "answer",
): string {
  const trimmed = hermesText.trim();
  if (presentation === "screen") {
    return `[Joshu completed — full answer is on the user's screen]\n${trimmed}\n\nSpeak a brief co-present summary (1–3 sentences). Mention that details are on screen when helpful.`;
  }
  if (kind === "callback_answer") {
    return `${CALLBACK_HEADER}\n${trimmed}\n\nOpen with one short line saying why you're calling (e.g. "I'm calling about the flights you asked me to check"), then relay the result. ${VOICE_FIDELITY_RULES} Finish by asking if there's anything else they'd like you to handle.`;
  }
  if (kind === "callback_question") {
    return `${CALLBACK_HEADER}\n${trimmed}\n\nOpen with one short line saying why you're calling, then explain what the task needs from them. ${VOICE_FIDELITY_RULES} Briefly give each option with its exact details, then ask the question plainly and stop to let them answer.`;
  }
  if (kind === "question") {
    return `[Joshu needs the caller's decision — user has no screen]\n${trimmed}\n\n${VOICE_FIDELITY_RULES} Briefly give each option with its exact details, then ask the question plainly and stop to let them answer.`;
  }
  return `[Joshu completed — user has no screen]\n${trimmed}\n\n${VOICE_FIDELITY_RULES} If it asks the caller something, end by asking that question plainly.`;
}
