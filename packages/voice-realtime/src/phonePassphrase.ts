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

function tokenSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 2 || b.length < 2) return a === b;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const maxDist = maxLen <= 4 ? 1 : maxLen <= 7 ? 2 : 3;
  if (dist <= maxDist) return true;
  return 1 - dist / maxLen >= 0.72;
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
