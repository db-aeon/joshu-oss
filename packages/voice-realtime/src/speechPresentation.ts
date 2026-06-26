/** Hermes inject wording for OpenAI Realtime speech after brain completes. */

export type InjectPresentation = "screen" | "voice_only";

export function injectHermesResultUserText(hermesText: string, presentation: InjectPresentation): string {
  const trimmed = hermesText.trim();
  if (presentation === "screen") {
    return `[Joshu completed — full answer is on the user's screen]\n${trimmed}\n\nSpeak a brief co-present summary (1–3 sentences). Mention that details are on screen when helpful.`;
  }
  return `[Joshu completed — user has no screen]\n${trimmed}\n\nSpeak a clear, complete summary the user can act on without reading anything.`;
}
