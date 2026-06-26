/** Classify PSTN user transcripts before triggering a Realtime response. */

export type UserTranscriptKind = "empty" | "unclear" | "clear";

const FILLER_ONLY = /^(uh+|um+|hmm+|ah+|oh+|mhm+|mm+|yeah+|okay+|ok+\.?)$/i;
const NOISE_MARKERS = /^\[.*\]$/i;
const SHORT_OK = new Set(["hey", "hi", "yo", "yes", "no", "why", "how", "stop", "wait"]);

export function classifyUserTranscript(raw: string): UserTranscriptKind {
  const t = raw.trim();
  if (!t) return "empty";

  if (NOISE_MARKERS.test(t) || /^(inaudible|silence|unintelligible)\.?$/i.test(t)) {
    return "unclear";
  }
  if (FILLER_ONLY.test(t)) return "unclear";

  const letters = t.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length < 2) return "unclear";

  if (t.length <= 3 && !SHORT_OK.has(t.toLowerCase())) return "unclear";

  return "clear";
}
