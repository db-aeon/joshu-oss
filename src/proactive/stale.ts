/** Deterministic date staleness for proactive nudges (no LLM). */

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Parse hard dates from Kanban title/body (interviews, deadlines). Returns epoch ms. */
export function extractHardDates(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();

  const add = (ms: number) => {
    if (!Number.isFinite(ms) || seen.has(ms)) return;
    seen.add(ms);
    out.push(ms);
  };

  for (const match of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    const ms = Date.parse(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
    add(ms);
  }

  for (const match of text.matchAll(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(20\d{2}))?\b/gi,
  )) {
    const month = MONTHS[match[1]!.slice(0, 3).toLowerCase()];
    if (month === undefined) continue;
    const day = Number.parseInt(match[2]!, 10);
    const year = match[3] ? Number.parseInt(match[3], 10) : new Date().getFullYear();
    if (day < 1 || day > 31) continue;
    add(Date.UTC(year, month, day, 12, 0, 0));
  }

  for (const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const a = Number.parseInt(match[1]!, 10);
    const b = Number.parseInt(match[2]!, 10);
    let year = match[3] ? Number.parseInt(match[3], 10) : new Date().getFullYear();
    if (year < 100) year += 2000;
    // US-style M/D
    const month = a <= 12 ? a - 1 : b - 1;
    const day = a <= 12 ? b : a;
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    add(Date.UTC(year, month, day, 12, 0, 0));
  }

  return out;
}

/**
 * True when every extracted event date is older than graceDays (exclude from nudge pool).
 * No dates found → not stale (unknown timing).
 */
export function isDateStaleForNudge(text: string, nowMs = Date.now(), graceDays = 14): boolean {
  const dates = extractHardDates(text);
  if (dates.length === 0) return false;
  const graceMs = graceDays * 86_400_000;
  return dates.every((d) => nowMs - d > graceMs);
}

/** Latest event date in text, or null. */
export function latestHardDateMs(text: string): number | null {
  const dates = extractHardDates(text);
  if (dates.length === 0) return null;
  return Math.max(...dates);
}
