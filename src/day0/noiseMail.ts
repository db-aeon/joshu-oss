import type { Day0ThreadRow } from "./types.js";

/** Gmail system labels that are usually low-signal for onboarding inference. */
const NOISE_GMAIL_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
]);

const NOISE_FROM_RE =
  /(?:^|[.@])(?:noreply|no-reply|donotreply|do-not-reply|mailer-daemon|bounce|newsletter|marketing|promo|notifications?|updates?|news|digest|announce)(?:@|[.@])/i;

const NOISE_SUBJECT_RE =
  /\b(newsletter|unsubscribe|% off|\d+% off|daily digest|weekly digest|weekly roundup|view in browser|limited time|act now|free shipping|your weekly|your daily|promotional)\b/i;

const NOISE_BODY_RE =
  /\b(unsubscribe|manage (?:your )?preferences|email preferences|view this (?:email|message) in (?:your )?browser|you(?:'re| are) receiving this (?:email|message) because|opt out|mailing list)\b/i;

/**
 * Heuristic: marketing, newsletters, automated bulk — not useful for EA onboarding inference.
 * Intentionally conservative on single weak signals (avoid dropping real human mail).
 */
export function isLikelyNoiseThread(thread: Day0ThreadRow): boolean {
  if (thread.labels?.some((l) => NOISE_GMAIL_LABELS.has(l))) return true;

  const from = thread.from ?? "";
  const subject = thread.subject ?? "";
  const body = thread.bodySnippet ?? "";

  if (NOISE_FROM_RE.test(from)) return true;
  if (NOISE_SUBJECT_RE.test(subject)) return true;
  if (NOISE_BODY_RE.test(body)) return true;

  // One-way bulk: long promo subject + noreply-ish display name
  if (/^(?:hi|hello|hey)[,!]?\s/i.test(subject) && NOISE_BODY_RE.test(body)) return true;

  return false;
}

/** Threads worth sending to the LLM (human / operational signal). */
export function selectSignalThreads(threads: Day0ThreadRow[]): Day0ThreadRow[] {
  return threads.filter((t) => !isLikelyNoiseThread(t));
}

export function countNoiseThreads(threads: Day0ThreadRow[]): number {
  return threads.filter((t) => isLikelyNoiseThread(t)).length;
}
