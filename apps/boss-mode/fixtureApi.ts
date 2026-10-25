/**
 * Fixture mode of the Multiplayer app for local work (change boss-mode-group-chat, design decision 10).
 *
 * With BOSS_MODE_FIXTURE=<path to a JSON file>, the Vite dev server answers the desktop routes of
 * the app from the file and keeps the writes in memory. A reply of the owner turns into a message
 * of the companion after a few seconds, and the addressed team members read it a few seconds
 * later, so the whole reply flow can be tried without a box. Never used in a build.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Plugin } from "vite";

type Json = Record<string, any>;
type Fixture = { teams: Json[]; views: Record<string, Json> };

const POST_AFTER_MS = 3000;
const SEEN_AFTER_MS = 6000;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Json;
  } catch {
    return {};
  }
}

/** Add one entry to the room of a fixture view, with the next id. */
function append(view: Json, entry: Json): Json {
  const entries = view.room.entries as Json[];
  const seq = Math.max(0, ...entries.map((e) => Number(e.seq) || 0)) + 1;
  const full = { ...entry, id: `m_${seq}`, seq, at: new Date().toISOString() };
  entries.push(full);
  return full;
}

/** The team members that a message of the box addresses: the author it answers and each @Name. */
function addressed(view: Json, message: Json): string[] {
  const room = view.room;
  const ids = new Set<string>();
  const answered = (room.entries as Json[]).find((e) => e.id === message.inReplyTo);
  if (answered && answered.author !== room.you) ids.add(answered.author);
  for (const m of room.members as Json[]) {
    if (m.id !== room.you && new RegExp(`@${m.companionName}\\b`, "i").test(message.text)) ids.add(m.id);
  }
  return ids.size ? [...ids] : (room.members as Json[]).filter((m) => m.id !== room.you).map((m) => m.id);
}

export function bossModeFixture(file: string): Plugin {
  const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
  let nextTask = 1;
  for (const view of Object.values(fixture.views)) view.notesHash = sha256(view.notes ?? "");

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname.replace(/^\/joshu\/api\/teams/, "");
    if (p === url.pathname) return false;
    if (req.method === "GET" && p === "/app") {
      const teams = fixture.teams.map((t) => ({
        ...t,
        openQuestions: (fixture.views[t.slug]?.questions ?? []).filter((q: Json) => q.question !== "reply").length,
      }));
      send(res, 200, { ok: true, teams });
      return true;
    }
    const match = /^\/([a-z0-9-]+)\/(.+)$/.exec(p);
    const view = match ? fixture.views[match[1]!] : undefined;
    if (!match || !view) {
      send(res, 404, { ok: false, error: "unknown team" });
      return true;
    }
    const rest = match[2]!;
    const body = req.method === "GET" ? {} : await readBody(req);
    const removeQuestion = (taskId: string) => {
      view.questions = (view.questions as Json[]).filter((q) => q.taskId !== taskId);
    };

    if (req.method === "GET" && rest === "view") {
      send(res, 200, { ok: true, ...view });
      return true;
    }
    if (req.method === "POST" && rest === "reply") {
      const text = String(body.text ?? "").trim();
      if (!text) return send(res, 400, { ok: false, error: "text is required" }), true;
      const taskId = `t_f1x${String(nextTask++).padStart(5, "0")}`;
      view.questions.push({ taskId, title: `Reply of the owner: ${text}`, status: "blocked", blockKind: "needs_input", blockReason: null, kind: "team_question", question: "reply", inReplyTo: body.inReplyTo, text });
      setTimeout(() => {
        removeQuestion(taskId);
        const answered = (view.room.entries as Json[]).find((e) => e.id === body.inReplyTo);
        const author = (view.room.members as Json[]).find((m) => m.id === answered?.author);
        const me = (view.room.members as Json[]).find((m) => m.id === view.room.you);
        const first = String(me?.ownerName ?? "").split(" ")[0];
        const posted = append(view, {
          kind: "message",
          author: view.room.you,
          text: `${author ? `@${author.companionName}, ` : ""}${first} says: ${text}`,
          inReplyTo: body.inReplyTo,
          viaOwner: true,
        });
        setTimeout(() => {
          for (const id of addressed(view, posted)) view.room.seen[id] = posted.id;
        }, SEEN_AFTER_MS - POST_AFTER_MS);
      }, POST_AFTER_MS);
      send(res, 200, { ok: true, taskId, board: `team-${match[1]}` });
      return true;
    }
    const answer = /^questions\/(t_[0-9a-z]+)\/answer$/.exec(rest);
    if (req.method === "POST" && answer) {
      if (!String(body.text ?? "").trim()) return send(res, 400, { ok: false, error: "text is required" }), true;
      removeQuestion(answer[1]!);
      send(res, 200, { ok: true, taskId: answer[1], board: `team-${match[1]}` });
      return true;
    }
    const approve = /^drafts\/(t_[0-9a-z]+)\/approve$/.exec(rest);
    if (req.method === "POST" && approve) {
      const q = (view.questions as Json[]).find((x) => x.taskId === approve[1]);
      removeQuestion(approve[1]!);
      if (q?.draft) setTimeout(() => append(view, { kind: "message", author: view.room.you, text: q.draft }), POST_AFTER_MS);
      send(res, 200, { ok: true, taskId: approve[1], board: `team-${match[1]}` });
      return true;
    }
    if (req.method === "PUT" && rest === "notes") {
      if (body.baseHash !== view.notesHash) {
        send(res, 409, { ok: false, error: "the team notes changed since you opened them", notes: view.notes, notesHash: view.notesHash });
        return true;
      }
      view.notes = String(body.text ?? "");
      view.notesHash = sha256(view.notes);
      send(res, 200, { ok: true, notes: view.notes, notesHash: view.notesHash });
      return true;
    }
    if (req.method === "POST" && rest === "fixture/notes-changed") {
      // Test hook: the companion writes the team notes while the owner edits them.
      view.notes = `${view.notes}\n- Changed by the companion at ${new Date().toISOString()}\n`;
      view.notesHash = sha256(view.notes);
      send(res, 200, { ok: true });
      return true;
    }
    send(res, 404, { ok: false, error: "not in the fixture" });
    return true;
  };

  return {
    name: "boss-mode-fixture",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        handle(req, res).then(
          (done) => (done ? undefined : next()),
          (error: Error) => send(res, 500, { ok: false, error: error.message }),
        );
      });
    },
  };
}
