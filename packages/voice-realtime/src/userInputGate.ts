/** Classify PSTN user transcripts before triggering a Realtime response. */

export type UserTranscriptKind = "empty" | "unclear" | "clear";

const FILLER_ONLY = /^(uh+|um+|hmm+|ah+|oh+|mhm+|mm+|yeah+|okay+|ok+\.?)$/i;
const NOISE_MARKERS = /^\[.*\]$/i;
const SHORT_OK = new Set(["hey", "hi", "yo", "yes", "no", "why", "how", "stop", "wait"]);

/** Gemini Live auto-detects language; locked-call STT often returns German/Portuguese junk. */
function hasNonAsciiLetters(text: string): boolean {
  for (const ch of text) {
    if (/\p{L}/u.test(ch) && ch.charCodeAt(0) > 127) return true;
  }
  return false;
}

export function classifyUserTranscript(raw: string): UserTranscriptKind {
  const t = raw.trim();
  if (!t) return "empty";

  if (NOISE_MARKERS.test(t) || /^(inaudible|silence|unintelligible)\.?$/i.test(t)) {
    return "unclear";
  }
  if (FILLER_ONLY.test(t)) return "unclear";
  // Do not burn passphrase attempts on wrong-language STT ("Hörst du das?", "Não.").
  if (hasNonAsciiLetters(t)) return "unclear";

  const letters = t.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length < 2) return "unclear";

  // STT punctuates short words ("No.") — compare the bare word.
  if (letters.length <= 3 && !SHORT_OK.has(letters.toLowerCase())) return "unclear";

  return "clear";
}
