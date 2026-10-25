/**
 * Team cards inside the speech bubbles of the Multiplayer app (spec team-room, change
 * boss-mode-group-chat, design decision 1).
 *
 * A message keeps a copy of each team card that it names, as the card was at the time of the
 * post. A message from before the copies names the card ids only in its text; for such a
 * message the app rebuilds the state of each card from the team card events before the message.
 * The team boss writes those event texts itself (`roomStore.card`); `npm run test:teams` pins them.
 */

export type CardState = "todo" | "doing" | "waiting" | "done";
export type Card = { id: string; title: string; project: string; state: CardState; doer: string; asker: string; due?: string; waitingOn?: string };
export type CardCopy = { id: string; title: string; state: CardState; doer: string; waitingOn?: string };
export type Message = {
  kind: "message";
  id: string;
  seq: number;
  author: string;
  at: string;
  text: string;
  inReplyTo?: string;
  cards?: CardCopy[];
  viaOwner?: true;
};
export type Entry = Message | { kind: "event"; id: string; seq: number; author: string; at: string; card: string; text: string };

const STATE_BY_LABEL: Record<string, CardState> = { "To do": "todo", Doing: "doing", "Waiting on a person": "waiting", Done: "done" };
const CARD_ID_RE = /\b[A-Z][A-Z0-9]{1,5}-\d{1,6}\b/g;

/** Local date of the browser (YYYY-MM-DD): the app shows one day at a time. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Change = { seq: number; state?: CardState; waitingOn?: string | null };

/** The state and waiting-on changes of one team card, from the texts of its card events. */
function changesOf(cardId: string, entries: Entry[]): Change[] {
  const id = cardId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const moved = new RegExp(`moved ${id} to (To do|Doing|Waiting on a person|Done)(?:;|$)`);
  const waiting = new RegExp(`set ${id} waiting on (.+?)(?:;|$)`);
  const cleared = new RegExp(`cleared the waiting-on text of ${id}(?:;|$)`);
  const out: Change[] = [];
  for (const e of entries) {
    if (e.kind !== "event" || e.card !== cardId) continue;
    const change: Change = { seq: e.seq };
    const m = moved.exec(e.text);
    if (m) change.state = STATE_BY_LABEL[m[1]!];
    const w = waiting.exec(e.text);
    if (w) change.waitingOn = w[1]!.trim();
    else if (cleared.test(e.text)) change.waitingOn = null;
    if (change.state || change.waitingOn !== undefined) out.push(change);
  }
  return out;
}

/** A team card as it was at entry `seq`, rebuilt from its card events. */
export function cardAt(card: Card, seq: number, entries: Entry[]): CardCopy {
  const changes = changesOf(card.id, entries);
  const before = changes.filter((c) => c.seq < seq);
  const after = changes.filter((c) => c.seq > seq);
  // Without a change after the message, the card is still as it was then.
  let state: CardState = after.some((c) => c.state) ? "todo" : card.state;
  let waitingOn: string | undefined = after.some((c) => c.waitingOn !== undefined) ? undefined : card.waitingOn;
  for (const c of before) {
    if (c.state) state = c.state;
    if (c.waitingOn !== undefined) waitingOn = c.waitingOn ?? undefined;
  }
  return { id: card.id, title: card.title, state, doer: card.doer, ...(waitingOn ? { waitingOn } : {}) };
}

/** The team cards of a message as they were when the companion wrote it. */
export function cardsAtMessage(message: Message, entries: Entry[], cards: Map<string, Card>): CardCopy[] {
  if (message.cards?.length) return message.cards;
  const ids = [...new Set(message.text.match(CARD_ID_RE) ?? [])].filter((id) => cards.has(id));
  return ids.map((id) => cardAt(cards.get(id)!, message.seq, entries));
}
