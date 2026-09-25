/** Hermes inject wording for OpenAI Realtime speech after brain completes. */

export type InjectPresentation = "screen" | "voice_only";

/** answer: a result to relay. question: Joshu needs the caller's decision to continue. */
export type InjectKind = "answer" | "question";

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
  if (kind === "question") {
    return `[Joshu needs the caller's decision — user has no screen]\n${trimmed}\n\n${VOICE_FIDELITY_RULES} Briefly give each option with its exact details, then ask the question plainly and stop to let them answer.`;
  }
  return `[Joshu completed — user has no screen]\n${trimmed}\n\n${VOICE_FIDELITY_RULES} If it asks the caller something, end by asking that question plainly.`;
}
