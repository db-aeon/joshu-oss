/**
 * Caller turns that end or pause the conversation rather than ask for work.
 *
 * Without this, "No, thank you" after "Anything else?" reached the brain as a
 * request, got appended to a background goal, and the reply ended with another
 * "Anything else?" — a loop that only ended when the caller hung up (canary box
 * 2026-09-24).
 */

/** closing: explicit wrap-up. decline: "no" (only meaningful after "anything else?"). waiting: holding for a live answer. */
export type WrapUpKind = "closing" | "decline" | "waiting";

const FILLER = /^(?:(?:um+|uh+|oh|ah|well|so|hmm+)\s+)+/;
/** Politeness that carries no request by itself. */
const POLITENESS =
  /\b(?:thank you(?: so much| very much)?|thanks(?: a lot)?|appreciate it|much appreciated)\b/g;
const CLOSING = new Set([
  "that's it",
  "that is it",
  "that's all",
  "that is all",
  "that'll be all",
  "that will be all",
  "nothing else",
  "i'm good",
  "i am good",
  "i'm all set",
  "all set",
  "all good",
  "we're good",
  "we are good",
  "i think that's it",
  "i think that's all",
  "bye",
  "bye bye",
  "goodbye",
  "talk soon",
  "talk to you later",
]);
const DECLINE = new Set(["no", "nope", "nah", "no no"]);
const WAITING = new Set(["i'm waiting", "i am waiting", "still waiting", "i'll wait", "i can wait", "just waiting"]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(FILLER, "");
}

/**
 * Classify a caller turn made only of wrap-up words. Anything with other
 * content ("no, make it Friday") returns null and is handled normally.
 */
export function classifyWrapUp(text: string): WrapUpKind | null {
  const normalized = normalize(text);
  if (!normalized) return null;
  const withoutThanks = normalized.replace(POLITENESS, " ").replace(/\s+/g, " ").trim();
  // Split "no that's it" / "no i'm waiting" into a leading decline plus the rest.
  const lead = withoutThanks.match(/^(no|nope|nah)\b\s*(.*)$/);
  const rest = lead ? lead[2]!.trim() : withoutThanks;
  if (rest && CLOSING.has(rest)) return "closing";
  if (rest && WAITING.has(rest)) return "waiting";
  if (lead && !rest) return "decline";
  if (!lead && DECLINE.has(withoutThanks)) return "decline";
  // Thanks alone: a wrap-up after "Anything else?", but after "Want me to send
  // it?" it usually means yes — so it gets decline semantics, not closing.
  if (!withoutThanks && normalized !== withoutThanks) return "decline";
  return null;
}

/** The assistant's last line invited the caller to add more ("Anything else?"). */
export function askedAnythingElse(lastAssistantText: string | undefined): boolean {
  if (!lastAssistantText) return false;
  const tail = lastAssistantText.trim().slice(-160).toLowerCase();
  return /\b(anything else|something else|else (?:i|we) can|else you(?:'d| would) like|help with anything|all set)\b[^.?!]*\?\s*$/.test(
    tail,
  );
}

/**
 * Whether a wrap-up turn should end/pause the conversation given what the
 * assistant said last. A bare "no" only means "nothing else" after an
 * anything-else prompt; "that's it" is not a goodbye when it answers a
 * specific question ("Is that the one?").
 */
export function wrapUpApplies(
  kind: WrapUpKind,
  lastAssistantText: string | undefined,
  jobPending: boolean,
): boolean {
  if (kind === "waiting") return jobPending;
  if (askedAnythingElse(lastAssistantText)) return true;
  if (kind === "decline") return false;
  return !/\?\s*$/.test(lastAssistantText?.trim() ?? "");
}

/** Short spoken line for a wrap-up; `jobPending` = a live answer is still coming. */
export function wrapUpLine(kind: WrapUpKind, jobPending: boolean): string {
  if (jobPending) {
    return kind === "waiting"
      ? "Still on it."
      : "No problem — I'll text you the answer as soon as it's ready.";
  }
  return "Sounds good. Talk soon.";
}
