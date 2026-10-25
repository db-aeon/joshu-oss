/**
 * How the Multiplayer app reads a team room message: the stand-up sections, and the lines
 * about one team card. Pure functions, so `npm run test:boss-mode-message-lines` can test them.
 */

/** Labels of a stand-up post (skill team-standup), plus two that companions also write. */
const LABEL_RE = /^(Done|Today|Blocked|Question|Heads-up)\s*(?::\s*(.*))?$/i;
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
export const CARD_ID_RE = /\b[A-Z][A-Z0-9]{1,5}-\d{1,6}\b/g;

/** True when the text names the card by its exact id (NOV-1 is not NOV-10). */
export function mentionsCard(text: string, cardId: string): boolean {
  return (text.match(CARD_ID_RE) ?? ([] as string[])).includes(cardId);
}

/**
 * One section of a stand-up post: its label, the text on the label line ("Blocked: <lead>"),
 * and the lines below it, without bullet marks.
 */
export type StandupSection = { label: string; lead?: string; lines: string[] };

function labelOf(word: string): string {
  const lower = word.toLowerCase();
  return lower === "heads-up" ? "Heads-up" : lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Read a message as a stand-up post. Companions write a label with text ("Blocked: X"),
 * or a label as a heading over bullets ("Blocked" then "- X"). Returns null when the
 * message does not start with a label, so the app shows it as plain text.
 */
export function parseStandup(text: string): StandupSection[] | null {
  // "**Blocked**" (Markdown bold) reads as "Blocked".
  const lines = text.split("\n").map((l) => l.trim().replace(/^\*\*([^*]+)\*\*/, "$1")).filter(Boolean);
  if (lines.length === 0 || !LABEL_RE.test(lines[0]!)) return null;
  const sections: StandupSection[] = [];
  for (const line of lines) {
    const label = BULLET_RE.test(line) ? null : LABEL_RE.exec(line);
    if (label) {
      const rest = (label[2] ?? "").trim().replace(/^[-–—:]\s*/, "");
      sections.push({ label: labelOf(label[1]!), ...(rest ? { lead: rest } : {}), lines: [] });
    } else {
      sections.at(-1)!.lines.push(line.replace(BULLET_RE, ""));
    }
  }
  return sections;
}

/** The part of a message that is about one team card. */
export type CardExcerpt =
  | { kind: "standup"; sections: StandupSection[]; partial: boolean }
  | { kind: "text"; text: string; partial: boolean };

/**
 * Only the lines of a message that name the card. A stand-up post keeps the label and the
 * lead of each section that names the card, because the lead often says what the lines below
 * mean ("Blocked: waiting on Becca for both"). `partial` is true when lines were left out.
 */
export function excerptAbout(text: string, cardId: string): CardExcerpt {
  const names = (line: string) => mentionsCard(line, cardId);
  const sections = parseStandup(text);
  if (sections) {
    const size = (s: StandupSection) => s.lines.length + (s.lead ? 1 : 0);
    const kept = sections
      .filter((s) => (s.lead && names(s.lead)) || s.lines.some(names))
      .map((s) => ({ ...s, lines: s.lines.filter(names) }));
    const total = sections.reduce((n, s) => n + size(s), 0);
    const shown = kept.reduce((n, s) => n + size(s), 0);
    if (shown > 0) return { kind: "standup", sections: kept, partial: shown < total };
    return { kind: "standup", sections, partial: false };
  }
  const lines = text.split("\n").filter((l) => l.trim());
  const kept = lines.filter(names);
  if (kept.length > 0 && kept.length < lines.length) return { kind: "text", text: kept.join("\n"), partial: true };
  return { kind: "text", text, partial: false };
}
