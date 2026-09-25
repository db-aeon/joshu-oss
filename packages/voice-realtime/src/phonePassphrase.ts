/**
 * Phone think-passphrase matching (STT-tolerant).
 * Env value may include wrapping quotes; callers should pass trimmed password.
 */

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** Lowercase, strip punctuation; apostrophes removed so "Falken's" → "falkens". */
export function normalizePassphraseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(text: string): string {
  return normalizePassphraseText(text).replace(/\s+/g, "");
}

/**
 * Rough English phonetic skeleton so PSTN STT homophones match.
 * "quartz" and "courts" both collapse to "krts" (Gideon 2026-09-01).
 */
function phoneticKey(word: string): string {
  let s = word.toLowerCase();
  s = s.replace(/ph/g, "f");
  s = s.replace(/^gn/, "n").replace(/^kn/, "n").replace(/^wr/, "r");
  s = s.replace(/qu/g, "k");
  s = s.replace(/x/g, "ks");
  s = s.replace(/z/g, "s");
  s = s.replace(/c(?=[eiy])/g, "s");
  s = s.replace(/c/g, "k");
  s = s.replace(/[aeiouhwy]/g, "");
  s = s.replace(/(.)\1+/g, "$1");
  return s;
}

function tokenSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 2 || b.length < 2) return a === b;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const maxDist = maxLen <= 4 ? 1 : maxLen <= 7 ? 2 : 3;
  if (dist <= maxDist) return true;
  if (1 - dist / maxLen >= 0.72) return true;
  // Orthography can be far apart while the phone line sounds the same.
  if (a.length >= 4 && b.length >= 4) {
    const pa = phoneticKey(a);
    const pb = phoneticKey(b);
    if (pa && pb && pa === pb) return true;
  }
  return false;
}

/**
 * True when transcript likely contains the passphrase (phone STT variance).
 * Handles e.g. env "Falken's Maze" vs heard "Falcon's Maze".
 */
export function matchesThinkPassphrase(transcript: string, password: string): boolean {
  const t = normalizePassphraseText(transcript);
  const p = normalizePassphraseText(password);
  if (!t || !p) return false;

  if (t.includes(p)) return true;

  const tc = compact(t);
  const pc = compact(p);
  if (!tc || !pc) return false;
  if (tc.includes(pc) || pc.includes(tc)) return true;

  const dist = levenshtein(tc, pc);
  const maxLen = Math.max(tc.length, pc.length);
  if (maxLen <= 4) return dist === 0;
  if (1 - dist / maxLen >= 0.78) return true;

  const passTokens = p.split(" ").filter((tok) => tok.length >= 2);
  if (!passTokens.length) return false;

  const spokenTokens = t.split(" ").filter((tok) => tok.length >= 2);
  if (!spokenTokens.length) return false;

  let hits = 0;
  for (const need of passTokens) {
    if (spokenTokens.some((heard) => tokenSimilar(heard, need))) hits += 1;
  }
  return hits / passTokens.length >= 0.7;
}

/** Personal/desktop work language — not a passphrase-only unlock turn. */
const PHONE_TASK_REQUEST_RE =
  /\b(file|files|desktop|folder|journal|note|notes|email|mail|calendar|agenda|fetch|find|look up|lookup|read|open|write|send|remind|schedule|what's on|whats on)\b/i;

export function looksLikePhoneTaskRequest(text: string): boolean {
  return PHONE_TASK_REQUEST_RE.test(text);
}

/**
 * True when STT is the passphrase (or a near-miss of it) and nothing else.
 * Used so leftover unlock audio is not treated as a Hermes/Gemini request.
 */
export function isPassphraseOnlyTurn(transcript: string, password: string): boolean {
  if (!matchesThinkPassphrase(transcript, password)) return false;
  return !looksLikePhoneTaskRequest(transcript);
}

/** Words that carry no request on their own around a spoken passphrase. */
const PASSPHRASE_FILLER = new Set([
  "a", "again", "ah", "an", "and", "code", "er", "hello", "hey", "hi", "is", "it", "its",
  "my", "oh", "ok", "okay", "passphrase", "password", "phrase", "so", "sorry", "that",
  "the", "this", "uh", "um", "word", "yeah", "yep", "yes",
]);

/** True when one spoken word is (a piece of) the passphrase. */
function isPassphraseWord(word: string, passTokens: string[], passCompact: string): boolean {
  if (passTokens.some((token) => tokenSimilar(word, token))) return true;
  // "redswoosh" heard as one word for a two-word passphrase.
  return word.length >= 5 && (passCompact.includes(word) || word.includes(passCompact));
}

function splitPassphraseWords(transcript: string, password: string): {
  matched: number;
  residue: string[];
} {
  const passTokens = normalizePassphraseText(password).split(" ").filter((tok) => tok.length >= 2);
  const passCompact = compact(password);
  let matched = 0;
  const residue: string[] = [];
  for (const word of normalizePassphraseText(transcript).split(" ").filter(Boolean)) {
    if (passCompact && isPassphraseWord(word, passTokens, passCompact)) matched += 1;
    else if (!PASSPHRASE_FILLER.has(word)) residue.push(word);
  }
  return { matched, residue };
}

/**
 * True when a transcript is leftover unlock audio: (part of) the passphrase plus
 * at most one other meaningful word. Such turns must never become a request —
 * "red swoosh … note" was queued as a "Save note" task (patrick 2026-09-24).
 *
 * Partial matches (one word of a multi-word passphrase) only count inside the
 * post-unlock grace window, since passphrase words can be ordinary words.
 */
export function isPassphraseResidue(
  transcript: string,
  password: string,
  options: { graceWindow: boolean },
): boolean {
  if (!password.trim() || !transcript.trim()) return false;
  const { matched, residue } = splitPassphraseWords(transcript, password);
  if (matched === 0) return false;
  if (!options.graceWindow && !matchesThinkPassphrase(transcript, password)) return false;
  return residue.length < 2;
}

/**
 * Remove the passphrase (including STT near-misses) from text bound for Hermes,
 * the goal broker, or the call transcript.
 */
export function redactPassphrase(text: string, password: string): string {
  const trimmed = password.trim();
  if (!trimmed) return text;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = text.replace(new RegExp(escaped, "gi"), " ");
  if (matchesThinkPassphrase(text, trimmed)) {
    const passTokens = normalizePassphraseText(trimmed).split(" ").filter((tok) => tok.length >= 2);
    const passCompact = compact(trimmed);
    out = out
      .split(/\s+/)
      .filter((raw) => {
        const word = normalizePassphraseText(raw);
        return !word || !isPassphraseWord(word, passTokens, passCompact);
      })
      .join(" ");
  }
  // Punctuation that followed the removed phrase ("Red swoosh. Save…").
  return out.replace(/\s+/g, " ").trim().replace(/^[.,;:!?-]+\s*/, "");
}

/**
 * Carrier / handset voicemail greeting heard on an outbound callback. Used only
 * while a goal callback is still locked, so a live owner saying these words
 * after unlocking is unaffected.
 */
const VOICEMAIL_GREETING_RE =
  /\b(leave (me )?(a|your) (message|voicemail|name)|after the (tone|beep)|at the (tone|beep)|record your message|voice ?mail|mailbox|(is|am|are) (not available|unavailable)|can'?t (come to|get to|take) the phone|the (person|party|number) you (are|have) (calling|called|dialed|reached))\b/i;

export function looksLikeVoicemailGreeting(transcript: string): boolean {
  return VOICEMAIL_GREETING_RE.test(transcript);
}
