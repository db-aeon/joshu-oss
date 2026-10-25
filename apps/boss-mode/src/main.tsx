/**
 * Multiplayer desktop app (spec team-room; change boss-mode-group-chat).
 *
 * A team is a group chat of the last day that the team talked: one speech bubble for each
 * message, with the team cards that the message names as cards inside the bubble. The app reads
 * `GET /joshu/api/teams/app` and `GET /joshu/api/teams/:slug/view`. Its writes are the words of
 * the owner: "OK, send it", an answer to the companion, a reply to a team message, and the team
 * notes. Each one goes to the companion, which talks to the team.
 */
import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import { openDesktopFile, openDesktopModule } from "@joshu/app-agent/desktopActions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { cardsAtMessage, dayKey, type Card, type CardCopy, type Entry, type Message } from "./chat";
import { excerptAbout, mentionsCard, type StandupSection } from "./messageLines";

const API = "/joshu/api/teams";
/** After a write of the owner, read the view this often until the companion has answered. */
const FAST_POLL_MS = 4000;
const FAST_POLL_FOR_MS = 3 * 60_000;
const SLOW_POLL_MS = 60_000;

type Avatar = { mime: string; base64: string };
type Member = { id: string; ownerName: string; companionName: string; label: string; avatar?: Avatar; isBoss: boolean; active: boolean };
type Project = { code: string; name: string; note?: string };
type Room = { slug: string; charter: string; you: string; entries: Entry[]; cards: Card[]; projects: Project[]; members: Member[]; seen?: Record<string, string> };
type TeamSummary = { slug: string; isBoss: boolean; schedule: string; openQuestions: number; unreachableSince?: string; rejectedAt?: string };
type BoardTask = {
  taskId: string;
  title: string;
  status: string;
  blockKind: string | null;
  kind?: string;
  card?: string;
  question?: string;
  draft?: string;
  text?: string;
  inReplyTo?: string;
};
type TeamView = {
  team: TeamSummary & { flaggedMessageIds?: string[]; memberId: string };
  room?: Room;
  roomError?: string;
  tasks: BoardTask[];
  questions: BoardTask[];
  notes: string;
  notesHash: string;
  standup?: { lastRunAt?: string; nextRunAt?: string };
};

const STATE_LABELS: Record<string, string> = { todo: "To do", doing: "Doing", waiting: "Waiting", done: "Done", you: "Needs you" };
/** Bubble colors of the other team members, in team order (design decision 7). The box is always sky. */
const MEMBER_TINTS = ["peach", "sage", "yellow", "rose"];
const CARD_ID_RE = /\b[A-Z][A-Z0-9]{1,5}-\d{1,6}\b/g;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  const body = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function send(method: "POST" | "PUT", url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Open jChat; the suggested message goes to the clipboard (jChat has no prefill). */
async function askInJChat(suggestion: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(suggestion);
  } catch {
    /* clipboard may be blocked in the iframe */
  }
  if (!openDesktopModule("jChat")) window.open("/hermes-chat/index.html", "_blank", "noopener,noreferrer");
}

/** One bubble color for each team member, in team order; the box is always sky. */
function memberTints(room: Room): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  for (const m of room.members) out.set(m.id, m.id === room.you ? "sky" : MEMBER_TINTS[i++ % MEMBER_TINTS.length]!);
  return out;
}

/** The Kanban dashboard (Hermes Admin): hermes-admin.<box domain> on a box, the Joshu proxy locally. */
function openKanbanDashboard(): void {
  const host = window.location.hostname;
  const local = host === "localhost" || host === "127.0.0.1";
  window.open(local ? "/joshu/hermes-admin/" : `https://hermes-admin.${host}/`, "_blank", "noopener,noreferrer");
}

const BOSS_DECISION_RE = /^BOSS DECISION\s*:?\s*/i;

const firstName = (name?: string) => (name ?? "").trim().split(/\s+/)[0] ?? "";

function dayTitle(key: string): string {
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function AvatarImg({ member, tint, size = 32 }: { member?: Member; tint: string; size?: number }) {
  if (member?.avatar) {
    return <img className="av" style={{ width: size, height: size }} alt="" src={`data:${member.avatar.mime};base64,${member.avatar.base64}`} />;
  }
  return (
    <span className={`av ph tint-${tint}`} style={{ width: size, height: size, fontSize: size / 2.4 }} aria-hidden="true">
      {(member?.companionName ?? "?").slice(0, 1)}
    </span>
  );
}

/** Text of a message with each @Name marked. */
function MessageText({ text }: { text: string }) {
  const parts = text.split(/(@[A-Za-z][\w'-]*)/g);
  return <>{parts.map((p, i) => (p.startsWith("@") ? <span key={i} className="mention">{p}</span> : <span key={i}>{p}</span>))}</>;
}

function CardTile({
  card,
  now,
  members,
  label,
  footer,
  children,
  onOpen,
}: {
  card: CardCopy;
  now?: Card;
  members: Map<string, Member>;
  tints?: Map<string, string>;
  label?: "you";
  footer?: string;
  children?: React.ReactNode;
  onOpen?: (id: string) => void;
}) {
  // One line for each card (design decision 7): id, title, state, and who does the work.
  const doer = members.get(card.doer);
  const state = label === "you" ? "Needs you" : card.state === "waiting" && card.waitingOn ? `Waiting on ${card.waitingOn}` : STATE_LABELS[card.state] ?? card.state;
  return (
    <div
      className={`cline${onOpen ? " clickable" : ""}`}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      title={onOpen ? `Open ${card.id}` : undefined}
      onClick={onOpen ? (e) => ((e.target as HTMLElement).closest("button") ? undefined : onOpen(card.id)) : undefined}
      onKeyDown={onOpen ? (e) => (e.key === "Enter" ? onOpen(card.id) : undefined) : undefined}
    >
      <span className="cl-id">{card.id}</span>
      <span className="cl-title">{card.title}</span>
      <span className={`cl-state${label ? " you" : ""}`}>{state}</span>
      <span className="cl-who">{footer ?? doer?.companionName ?? ""}</span>
      {!label && now && now.state !== card.state && <span className="cl-now">now {STATE_LABELS[now.state] ?? now.state}</span>}
      {children}
    </div>
  );
}

/** A text field under a bubble for a reply or an answer, with the check for empty text. */
function Composer({
  placeholder,
  hint,
  onSend,
  onCancel,
}: {
  placeholder: string;
  hint: string;
  onSend: (text: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim()) {
      setError(hint);
      return;
    }
    setBusy(true);
    const failed = await onSend(text.trim());
    setBusy(false);
    if (failed) setError(failed);
  };
  return (
    <div className="composer">
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="acts">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Sending…" : "Send"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type ChatProps = {
  view: TeamView;
  day: string;
  isLastDay: boolean;
  onWrote: () => void;
  onCard: (id: string) => void;
};

function Chat({ view, day, isLastDay, onWrote, onCard }: ChatProps) {
  const room = view.room!;
  const slug = view.team.slug;
  const members = useMemo(() => new Map(room.members.map((m) => [m.id, m])), [room.members]);
  const tints = useMemo(() => memberTints(room), [room]);
  const boss = room.members.find((m) => m.isBoss);
  const current = useMemo(() => new Map(room.cards.map((c) => [c.id, c])), [room.cards]);
  const me = members.get(room.you);
  const companion = me?.companionName ?? "Your Joshu";
  const flagged = new Set(view.team.flaggedMessageIds ?? []);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A new bubble slides in; the bubbles of the first load do not (design decision 7).
  const known = useRef<Set<string> | null>(null);
  const messages = room.entries.filter((e): e is Message => e.kind === "message" && dayKey(e.at) === day);
  const fresh = new Set(known.current ? messages.filter((m) => !known.current!.has(m.id)).map((m) => m.id) : []);
  useEffect(() => {
    known.current = new Set([...(known.current ?? []), ...messages.map((m) => m.id)]);
  });

  const pendingReplies = isLastDay ? view.questions.filter((q) => q.question === "reply") : [];
  const waiting = isLastDay ? view.questions.filter((q) => q.question !== "reply") : [];

  const reply = async (inReplyTo: string, text: string) => {
    const out = await send("POST", `${API}/${encodeURIComponent(slug)}/reply`, { text, inReplyTo });
    if (out.status !== 200) return String(out.body.error ?? `Could not send (${out.status}).`);
    setOpen(null);
    onWrote();
    return null;
  };
  const answer = async (taskId: string, text: string) => {
    const out = await send("POST", `${API}/${encodeURIComponent(slug)}/questions/${taskId}/answer`, { text });
    if (out.status !== 200) return String(out.body.error ?? `Could not send (${out.status}).`);
    setOpen(null);
    setNotice(`${companion} has your answer.`);
    onWrote();
    return null;
  };
  const approve = async (taskId: string) => {
    const out = await send("POST", `${API}/${encodeURIComponent(slug)}/drafts/${taskId}/approve`);
    setNotice(out.status === 200 ? `${companion} is sending it now.` : `Could not send: ${String(out.body.error ?? out.status)}`);
    onWrote();
  };

  /** "Seen by" for a message of the box: each addressed team member whose read position is at or after it. */
  const seenBy = (m: Message): string[] => {
    const others = room.members.filter((x) => x.id !== room.you && x.active);
    const answered = room.entries.find((e) => e.id === m.inReplyTo);
    let addressed = others.filter((x) => x.id === answered?.author || new RegExp(`@${x.companionName}\\b`, "i").test(m.text));
    if (addressed.length === 0) addressed = others;
    return addressed.filter((x) => Number((room.seen?.[x.id] ?? "m_0").slice(2)) >= m.seq).map((x) => x.companionName);
  };

  // The private message: each team card that waits on the owner once, and each question without a card.
  const needs: Array<{ task: BoardTask; card?: Card }> = [];
  const shownCards = new Set<string>();
  for (const q of waiting.filter((t) => !t.draft)) {
    const ids = q.card ? [q.card] : [...new Set((q.text ?? q.title).match(CARD_ID_RE) ?? [])].filter((id) => current.has(id));
    const unseen = ids.filter((id) => !shownCards.has(id));
    unseen.forEach((id) => shownCards.add(id));
    if (unseen.length) unseen.forEach((id) => needs.push({ task: q, card: current.get(id) }));
    else if (ids.length === 0) needs.push({ task: q });
  }
  const drafts = waiting.filter((t) => t.draft);
  const single = needs.length + drafts.length === 1;

  return (
    <div className="chat">
      {messages.length === 0 && <p className="empty-day">Nothing in this team yet. The next stand-up posts here.</p>}
      {messages.map((m) => {
        const author = members.get(m.author);
        const mine = m.author === room.you;
        const tint = tints.get(m.author) ?? "peach";
        const hidden = flagged.has(m.id) && !revealed.has(m.id);
        const cards = cardsAtMessage(m, room.entries, current);
        const seen = mine && m.viaOwner ? seenBy(m) : [];
        return (
          <article key={m.id} className={`msg${mine ? " mine" : ""}${fresh.has(m.id) ? " fresh" : ""}`}>
            <AvatarImg member={author} tint={tint} />
            <div className="col">
              <div className="who">
                <b>{author?.companionName ?? "Unknown"}</b>
                {m.author === boss?.id && BOSS_DECISION_RE.test(m.text) && <span className="tag boss">Boss decision</span>}
                <span>{mine ? "for you" : author ? `${firstName(author.ownerName)}'s Joshu` : ""}</span>
                <span className="t">{timeLabel(m.at)}</span>
              </div>
              <div className={`bubble tint-${tint}${flagged.has(m.id) ? " flagged" : ""}`}>
                {hidden ? (
                  <p>
                    {companion} ignored this message and told you about it.{" "}
                    <button type="button" className="link" onClick={() => setRevealed(new Set([...revealed, m.id]))}>
                      Show the message
                    </button>
                  </p>
                ) : (
                  <>
                    <p>
                      <MessageText text={m.text.replace(BOSS_DECISION_RE, "")} />
                    </p>
                    {cards.length > 0 && (
                      <div className="cards">
                        {cards.map((c) => (
                          <CardTile key={c.id} card={c} now={current.get(c.id)} members={members} tints={tints} onOpen={onCard} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
              {mine && m.viaOwner && <div className="status">{seen.length ? `Seen by ${seen.join(", ")}` : "Posted"}</div>}
              {!mine && !hidden && isLastDay && open !== `r:${m.id}` && (
                <button type="button" className="link reply-link" onClick={() => setOpen(`r:${m.id}`)}>
                  Reply
                </button>
              )}
              {open === `r:${m.id}` && (
                <Composer
                  placeholder={`Tell ${companion} what to say to ${author?.companionName ?? "them"}`}
                  hint={`Write what ${companion} should say first.`}
                  onSend={(text) => reply(m.id, text)}
                  onCancel={() => setOpen(null)}
                />
              )}
            </div>
          </article>
        );
      })}

      {pendingReplies.map((q) => (
        <article key={q.taskId} className="msg mine pending">
          <AvatarImg member={me} tint="sky" />
          <div className="col">
            <div className="who">
              <b>{companion}</b>
              <span>for you</span>
            </div>
            <div className="bubble tint-sky waiting-bubble">
              <p className="dim">{companion} is passing this on:</p>
              <p>“{q.text}”</p>
            </div>
            <div className="status">Sending</div>
          </div>
        </article>
      ))}

      {(needs.length > 0 || drafts.length > 0) && (
        <article className="msg mine private">
          <AvatarImg member={me} tint="sky" />
          <div className="col">
            <div className="who">
              <b>{companion}</b>
              <span className="only">only you see this</span>
            </div>
            <div className="bubble private-bubble">
              {needs.length > 0 && (
                <>
                  <p>
                    {firstName(me?.ownerName) || "Hi"}, {needs.length === 1 ? "this waits" : "these wait"} on you.
                  </p>
                  <div className="cards">
                    {needs.map(({ task, card }) =>
                      card ? (
                        <CardTile
                          key={`${task.taskId}-${card.id}`}
                          card={card}
                          members={members}
                          tints={tints}
                          label="you"
                          footer={`${members.get(card.asker)?.companionName ?? "The team"} asks`}
                          onOpen={onCard}
                        >
                          {!single && open !== `a:${task.taskId}:${card.id}` && (
                            <button type="button" className="link" onClick={() => setOpen(`a:${task.taskId}:${card.id}`)}>
                              Answer
                            </button>
                          )}
                        </CardTile>
                      ) : (
                        <div key={task.taskId} className="ask-line">
                          <p>{task.text ?? task.title}</p>
                          {!single && open !== `a:${task.taskId}:` && (
                            <button type="button" className="link" onClick={() => setOpen(`a:${task.taskId}:`)}>
                              Answer
                            </button>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                </>
              )}
              {drafts.map((d) => (
                <div key={d.taskId} className="draft">
                  <p>I'd like to tell the team:</p>
                  <blockquote>
                    <MessageText text={d.draft!} />
                  </blockquote>
                  <div className="acts">
                    <button type="button" className="btn btn-primary" onClick={() => void approve(d.taskId)}>
                      OK, send it
                    </button>
                    {open !== `a:${d.taskId}:` && (
                      <button type="button" className="btn btn-quiet" onClick={() => setOpen(`a:${d.taskId}:`)}>
                        Change it
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {single && needs.length === 1 && open !== `a:${needs[0]!.task.taskId}:${needs[0]!.card?.id ?? ""}` && (
              <button type="button" className="link reply-link" onClick={() => setOpen(`a:${needs[0]!.task.taskId}:${needs[0]!.card?.id ?? ""}`)}>
                Answer {companion}
              </button>
            )}
            {open?.startsWith("a:") && (
              <Composer
                placeholder={`Tell ${companion}`}
                hint={`Write your answer to ${companion} first.`}
                onSend={(text) => answer(open.split(":")[1]!, text)}
                onCancel={() => setOpen(null)}
              />
            )}
          </div>
        </article>
      )}
      {notice && <p className="notice" role="status">{notice}</p>}
    </div>
  );
}

function Earlier({ days, onPick }: { days: string[]; onPick: (day: string) => void }) {
  return (
    <div className="earlier">
      {days.length === 0 ? (
        <p className="empty-day">No earlier days. Team messages are kept for 90 days.</p>
      ) : (
        <ul>
          {days.map((d) => (
            <li key={d}>
              <button type="button" className="day-link" onClick={() => onPick(d)}>
                {dayTitle(d)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Notes({ view, companion, onSaved }: { view: TeamView; companion: string; onSaved: () => void }) {
  const [text, setText] = useState(view.notes);
  const [base, setBase] = useState(view.notesHash);
  const [theirs, setTheirs] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const out = await send("PUT", `${API}/${encodeURIComponent(view.team.slug)}/notes`, { text, baseHash: base });
    setBusy(false);
    if (out.status === 200) {
      setBase(String(out.body.notesHash));
      setTheirs(null);
      setStatus("Saved.");
      onSaved();
    } else if (out.status === 409) {
      setBase(String(out.body.notesHash));
      setTheirs(String(out.body.notes ?? ""));
      setStatus(null);
    } else {
      setStatus(`Could not save: ${String(out.body.error ?? out.status)}`);
    }
  };
  return (
    <div className="notes">
      <p className="dim">What {companion} may share with the {view.team.slug} team. {companion} follows these notes in every message.</p>
      {theirs !== null && (
        <div className="banner" role="status">
          <p>
            <b>{companion} changed your team notes while you were writing.</b> Here are the new notes. Your text is kept below. Change it if you need to, and save again.
          </p>
          <pre>{theirs}</pre>
        </div>
      )}
      <textarea
        className="notes-text"
        value={text}
        spellCheck
        onChange={(e) => {
          setText(e.target.value);
          setStatus(null);
        }}
      />
      <div className="acts">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
        {status && <span className="dim" role="status">{status}</span>}
      </div>
    </div>
  );
}

const BOARD_STATES: Array<[Card["state"], string]> = [
  ["todo", "To do"],
  ["doing", "Doing"],
  ["waiting", "Waiting on a person"],
  ["done", "Done"],
];

/** Text of the card details with each card id as a link to that card. */
function CardLinks({ text, cards, onCard }: { text: string; cards: Map<string, Card>; onCard: (id: string) => void }) {
  const parts = text.split(/(\b[A-Z][A-Z0-9]{1,5}-\d{1,6}\b)/g);
  return (
    <>
      {parts.map((p, i) =>
        cards.has(p) ? (
          <button key={i} type="button" className="chip" title={cards.get(p)!.title} onClick={() => onCard(p)}>
            {p}
          </button>
        ) : (
          <MessageText key={i} text={p} />
        ),
      )}
    </>
  );
}

function StandupRows({ sections, cards, onCard }: { sections: StandupSection[]; cards: Map<string, Card>; onCard: (id: string) => void }) {
  return (
    <div className="su">
      {sections.map((section, i) => (
        <div className="row" key={i}>
          <span className="px">{section.label}</span>
          <div className="items">
            {[section.lead, ...section.lines].filter(Boolean).map((line, j) => (
              <div className="item" key={j}>
                <CardLinks text={line!} cards={cards} onCard={onCard} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A message in the activity of a card: only its lines about the card, and the whole message on request. */
function CardMessage({ text, id, cards, onCard }: { text: string; id: string; cards: Map<string, Card>; onCard: (id: string) => void }) {
  const [whole, setWhole] = useState(false);
  const excerpt = excerptAbout(text, id);
  return (
    <>
      {whole ? (
        <p className="body">
          <CardLinks text={text} cards={cards} onCard={onCard} />
        </p>
      ) : excerpt.kind === "standup" ? (
        <StandupRows sections={excerpt.sections} cards={cards} onCard={onCard} />
      ) : (
        <p className="body">
          <CardLinks text={excerpt.text} cards={cards} onCard={onCard} />
        </p>
      )}
      {excerpt.partial && (
        <button type="button" className="link" onClick={() => setWhole(!whole)}>
          {whole ? `Show only the lines about ${id}` : "Show the whole message"}
        </button>
      )}
    </>
  );
}

function Board({ room, selected, onCard }: { room: Room; selected?: string; onCard: (id: string) => void }) {
  const members = new Map(room.members.map((m) => [m.id, m]));
  const tints = memberTints(room);
  if (room.projects.length === 0) return <p className="empty-day">No team projects yet. The companions add projects as they create cards.</p>;
  return (
    <div className="board">
      <div className="grid">
        <div className="ch px">Project</div>
        {BOARD_STATES.map(([, label]) => (
          <div className="ch px" key={label}>
            {label}
          </div>
        ))}
        {room.projects.map((p, i) => {
          const last = i === room.projects.length - 1 ? " last" : "";
          const cards = room.cards.filter((c) => c.project === p.code);
          return [
            <div className={`lane${last}`} key={`l-${p.code}`}>
              <b>{p.name}</b>
              <span>
                {p.note ? `${p.note}, ` : ""}
                {cards.length} cards
              </span>
            </div>,
            ...BOARD_STATES.map(([state]) => (
              <div className={`cell${last}`} key={`${p.code}-${state}`}>
                {cards
                  .filter((c) => c.state === state)
                  .map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      className={`bcard${state === "done" ? " done" : ""}`}
                      aria-pressed={selected === c.id}
                      onClick={() => onCard(c.id)}
                    >
                      <span className="top">{c.id}</span>
                      <span className="ttl">{c.title}</span>
                      {c.waitingOn && <span className="wait">Waiting on {c.waitingOn}</span>}
                      <span className="by">
                        <AvatarImg member={members.get(c.doer)} tint={tints.get(c.doer) ?? "sky"} size={18} /> {members.get(c.doer)?.companionName ?? "?"}
                        {c.due ? `, ${c.due}` : ""}
                      </span>
                    </button>
                  ))}
              </div>
            )),
          ];
        })}
      </div>
      <p className="note">One row for each team project, one column for each state. Each Joshu moves only its own cards.</p>
    </div>
  );
}

function CardDetail({ room, id, onCard, onClose }: { room: Room; id: string; onCard: (id: string) => void; onClose: () => void }) {
  const card = room.cards.find((c) => c.id === id);
  const members = new Map(room.members.map((m) => [m.id, m]));
  const tints = memberTints(room);
  const cards = new Map(room.cards.map((c) => [c.id, c]));
  if (!card) return null;
  const project = room.projects.find((p) => p.code === card.project);
  const doer = members.get(card.doer);
  const asker = members.get(card.asker);
  const activity = room.entries.filter((e) =>
    e.kind === "event" ? e.card === id : e.cards?.some((c) => c.id === id) || mentionsCard(e.text, id),
  );
  const mine = card.doer === room.you;
  const me = members.get(room.you);
  return (
    <aside className="detail" aria-label={`Card ${id}`}>
      <div className="dh">
        <span className="px">{id}</span>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="db">
        <div className="px dim">{project?.name ?? card.project}</div>
        <h2>{card.title}</h2>
        <div className="facts">
          <span className="px">State</span>
          <span className={`pill ${card.state}`}>{BOARD_STATES.find(([s]) => s === card.state)?.[1]}</span>
          <span className="px">Joshu</span>
          <span className="person">
            <AvatarImg member={doer} tint={tints.get(card.doer) ?? "sky"} size={24} /> {doer?.companionName}{" "}
            <small className="dim">{doer ? `${firstName(doer.ownerName)}'s Joshu` : ""}</small>
          </span>
          <span className="px">Asked by</span>
          <span className="person">
            <AvatarImg member={asker} tint={tints.get(card.asker) ?? "sky"} size={18} /> {asker?.companionName}
          </span>
          {card.due && (
            <>
              <span className="px">When</span>
              <span>{card.due}</span>
            </>
          )}
          {card.waitingOn && (
            <>
              <span className="px">Waiting on</span>
              <span className="pill waiting">{card.waitingOn}</span>
            </>
          )}
        </div>
        <div className="px">Activity</div>
        <div className="timeline">
          {activity.map((e) => {
            const a = members.get(e.author);
            return e.kind === "event" ? (
              <div className="tl ev" key={e.id}>
                <span className="mark">·</span>
                <div>
                  {e.text} <span className="t">{timeLabel(e.at)}</span>
                </div>
              </div>
            ) : (
              <div className="tl" key={e.id}>
                <AvatarImg member={a} tint={tints.get(e.author) ?? "sky"} size={24} />
                <div>
                  <b>{a?.companionName}</b>{" "}
                  <span className="t">
                    {dayTitle(dayKey(e.at))} {timeLabel(e.at)}
                  </span>
                  <CardMessage key={`${id}-${e.id}`} text={e.text} id={id} cards={cards} onCard={onCard} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="acts">
          <button type="button" className="btn btn-primary" onClick={() => void askInJChat(`About card ${id} (${card.title}) in team ${room.slug}: `)}>
            Ask {me?.companionName ?? "your Joshu"} about this
          </button>
          {mine && (
            <button type="button" className="btn btn-quiet" onClick={openKanbanDashboard}>
              Open on the Kanban board
            </button>
          )}
        </div>
        <p className="note">
          {mine
            ? `${doer?.companionName ?? "Your Joshu"} works on this card for you.`
            : `${doer?.companionName ?? "This Joshu"} works on this card for ${doer ? firstName(doer.ownerName) : "its owner"}. You see only what it shares with the team.`}
        </p>
      </div>
    </aside>
  );
}

/** The charter and the next stand-up of a team, in a window behind the info button of the header. */
function TeamInfo({ slug, charter, standup, onClose }: { slug: string; charter?: string; standup: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="team-info-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="team-info-title" className="team-name">
            # {slug}
          </h2>
          <button ref={closeRef} type="button" className="x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="px">What the team is for</p>
        <p>{charter || "This team has no charter yet. The boss can write one by telling their companion."}</p>
        <p className="px">Stand-up</p>
        <p>{standup}</p>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <div className="px dim">Multiplayer</div>
      <h2>Let your Joshu work with your team's Joshus.</h2>
      <p>
        In a team, the companions of the people you work or live with talk each morning. They ask each other for what they need and promise what they can do. You hear only what needs you.
      </p>
      <div className="acts">
        <button type="button" className="btn btn-primary" onClick={() => void askInJChat("Start a team ")}>Start a team in jChat</button>
        <button type="button" className="btn btn-quiet" onClick={() => void askInJChat("Join this team: ")}>Join with an invite link</button>
      </div>
    </div>
  );
}

function App() {
  const [teams, setTeams] = useState<TeamSummary[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [view, setView] = useState<TeamView | null>(null);
  const [tab, setTab] = useState<"chat" | "board" | "earlier" | "notes">("chat");
  const [card, setCard] = useState<string | undefined>();
  const [info, setInfo] = useState(false);
  const [day, setDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fastUntil, setFastUntil] = useState(0);

  const loadTeams = useCallback(async () => {
    try {
      const out = await getJson<{ teams: TeamSummary[] }>(`${API}/app`);
      setTeams(out.teams);
      setSlug((cur) => cur ?? out.teams[0]?.slug ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const loadView = useCallback(async (s: string) => {
    try {
      setView(await getJson<TeamView>(`${API}/${encodeURIComponent(s)}/view`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);
  useEffect(() => {
    if (!slug) return;
    void loadView(slug);
    const fast = fastUntil > Date.now();
    const timer = setInterval(() => {
      void loadView(slug);
      if (fast && Date.now() > fastUntil) setFastUntil(0);
    }, fast ? FAST_POLL_MS : SLOW_POLL_MS);
    return () => clearInterval(timer);
  }, [slug, loadView, fastUntil]);

  const room = view?.room;
  const days = useMemo(() => {
    const keys = new Set((room?.entries ?? []).filter((e) => e.kind === "message").map((e) => dayKey(e.at)));
    return [...keys].sort().reverse();
  }, [room?.entries]);
  const lastDay = days[0] ?? dayKey(new Date().toISOString());
  const shownDay = day ?? lastDay;
  const me = room?.members.find((m) => m.id === room.you);
  const companion = me?.companionName ?? "Your Joshu";
  const wrote = () => {
    setFastUntil(Date.now() + FAST_POLL_FOR_MS);
    if (slug) void loadView(slug);
    void loadTeams();
  };
  const pick = (s: string) => {
    setSlug(s);
    setTab("chat");
    setDay(null);
    setCard(undefined);
  };
  const members = room?.members.filter((m) => m.active) ?? [];
  const tints = room ? memberTints(room) : new Map<string, string>();
  const nextStandup = view?.standup?.nextRunAt
    ? new Date(view.standup.nextRunAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div className={`app${room && card ? " with-detail" : ""}`}>
      <aside className="side" aria-label="Teams">
        <div className="me">
          <AvatarImg member={me} tint="sky" size={44} />
          <div>
            <b>{me?.companionName ?? "Your Joshu"}</b>
            <span>{me ? `${firstName(me.ownerName)}'s Joshu` : "Multiplayer"}</span>
          </div>
        </div>
        <h3 className="px">Teams</h3>
        {teams?.map((t) => (
          <button type="button" key={t.slug} className="chan" aria-current={t.slug === slug} onClick={() => pick(t.slug)}>
            <span>
              <span className="hash">#</span>
              {t.slug}
            </span>
            {t.openQuestions > 0 && <span className="badge">{t.openQuestions}</span>}
          </button>
        ))}
        {room && (
          <>
            <h3 className="px">In #{room.slug}</h3>
            {members.map((m) => (
              <div className="member" key={m.id}>
                <AvatarImg member={m} tint={tints.get(m.id) ?? "sky"} size={28} />
                <div>
                  {m.companionName}
                  <small>
                    {firstName(m.ownerName)}'s Joshu{m.isBoss ? ", boss" : ""}
                    {m.id === room.you ? ", you" : ""}
                  </small>
                </div>
              </div>
            ))}
          </>
        )}
        <div className="foot">
          <button type="button" className="btn btn-quiet" onClick={() => void askInJChat("Start a team ")}>
            Start a team
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => void askInJChat("Join this team: ")}>
            Join with an invite link
          </button>
        </div>
      </aside>
      <section className="main" aria-label={slug ?? "Multiplayer"}>
        {teams && teams.length === 0 && <Empty />}
        {error && !view && <p className="banner" role="alert">{error}</p>}
        {view && (
          <>
            <header className="head">
              <div className="title">
                <div className="title-row">
                  <h1 className="team-name"># {view.team.slug}</h1>
                  <button type="button" className="info-btn" aria-label={`About the ${view.team.slug} team`} title="About this team" onClick={() => setInfo(true)}>
                    i
                  </button>
                </div>
              </div>
              <nav className="tabs" aria-label="Views">
                <button type="button" className="tab" aria-pressed={tab === "chat"} onClick={() => (setTab("chat"), setDay(null))}>
                  {tab === "chat" && shownDay !== lastDay ? "Last day" : "Chat"}
                </button>
                <button type="button" className="tab" aria-pressed={tab === "board"} onClick={() => setTab("board")}>
                  Board <span className="n">{room?.cards.length ?? 0}</span>
                </button>
                <button type="button" className="tab" aria-pressed={tab === "earlier"} onClick={() => setTab("earlier")}>
                  Earlier
                </button>
                <button type="button" className="tab" aria-pressed={tab === "notes"} onClick={() => setTab("notes")}>
                  What I share
                </button>
              </nav>
            </header>
            {view.roomError && (
              <div className="banner" role="status">
                <b>
                  {companion} can't reach the {view.team.slug} team
                  {view.team.unreachableSince
                    ? ` since ${new Date(view.team.unreachableSince).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}`
                    : ""}
                  .
                </b>{" "}
                {view.team.rejectedAt ? "The team boss no longer accepts this box. Maybe it was removed. " : ""}Nothing is lost. The conversation shows
                again when the boss's box is back.
              </div>
            )}
            {tab === "chat" && room && (
              <>
                <h2 className="day-title">{dayTitle(shownDay)}</h2>
                <Chat view={view} day={shownDay} isLastDay={shownDay === lastDay} onWrote={wrote} onCard={setCard} />
              </>
            )}
            {(tab === "chat" || tab === "board") && !room && (
              <div className="offline">
                <h2 className="px">Cards {companion} works on</h2>
                <ul>
                  {view.tasks
                    .filter((t) => t.kind === "team_commitment")
                    .map((t) => (
                      <li key={t.taskId}>{t.title}</li>
                    ))}
                </ul>
              </div>
            )}
            {tab === "board" && room && <Board room={room} selected={card} onCard={setCard} />}
            {tab === "earlier" && (
              <Earlier
                days={days.filter((d) => d !== lastDay)}
                onPick={(d) => {
                  setDay(d);
                  setTab("chat");
                }}
              />
            )}
            {tab === "notes" && <Notes key={view.team.slug} view={view} companion={companion} onSaved={() => slug && void loadView(slug)} />}
          </>
        )}
      </section>
      {room && card && <CardDetail room={room} id={card} onCard={setCard} onClose={() => setCard(undefined)} />}
      {view && info && (
        <TeamInfo
          slug={view.team.slug}
          charter={room?.charter}
          standup={view.roomError ? "The team is not reachable." : nextStandup ? `Next stand-up: ${nextStandup}.` : `Stand-up: ${view.team.schedule}.`}
          onClose={() => setInfo(false)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
