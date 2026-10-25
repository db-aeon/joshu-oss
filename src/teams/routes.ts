/**
 * Multiplayer routes (spec team-room).
 *
 * - Public, for other boxes: `/api/teams/preview`, `/api/teams/join` (invite code),
 *   and `/api/teams/:slug/...` with `Authorization: Bearer <member token>`. Each
 *   failed member check gets the same 404.
 * - Public, for people: `GET /teams/join/:code`, a page with no team data.
 * - Localhost-only, for the companion of this box: `/api/team-local/...`.
 */
import type { Request, Response, Router } from "express";

import { isDirectLocalhostRequest, verifyArozosDesktopSession } from "../httpLocalhost.js";
import { NOT_FOUND, type TeamCardOp, type TeamRoomStore } from "./roomStore.js";
import type { TeamService } from "./service.js";
import type { TeamResult } from "./types.js";

function bearer(req: Request): string {
  const header = String(req.headers.authorization ?? "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function send(res: Response, out: TeamResult): void {
  res.status(out.status).json(out.body);
}

const fail = (res: Response, error: unknown) =>
  res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });

export const INVITE_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Joshu team invite</title>
<style>body{margin:0;font-family:"Work Sans",system-ui,sans-serif;background:#f5f0eb;color:#0d0d0d;display:grid;place-items:center;min-height:100vh}
main{max-width:30rem;margin:24px;padding:32px;background:#fff;border:1px solid #0d0d0d}h1{font-size:22px;margin:0 0 12px}p{line-height:1.5;margin:8px 0}</style>
</head><body><main><h1>This is a Joshu team invite.</h1>
<p>To join, forward this link to your own Joshu, for example by text or email, or paste it into jChat.</p>
<p>Your Joshu shows you what the team is about before it joins.</p></main></body></html>`;

export function registerTeamRoutes(router: Router, deps: { service: () => TeamService; store: () => TeamRoomStore }): void {
  // —— Public: other boxes ——
  router.post("/api/teams/preview", async (req: Request, res: Response) => {
    try {
      send(res, await deps.service().hostPreview(req.body?.code));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/api/teams/join", async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      send(res, await deps.service().hostJoin(body.code, { ownerName: body.ownerName, companionName: body.companionName, avatar: body.avatar }));
    } catch (error) {
      fail(res, error);
    }
  });

  /** The active team member of the member token, or a 404 that tells nothing more. */
  const member = async (req: Request, res: Response): Promise<{ slug: string; id: string } | undefined> => {
    const slug = String(req.params.slug ?? "");
    const found = await deps.store().authenticate(slug, bearer(req));
    if (!found) {
      send(res, NOT_FOUND);
      return undefined;
    }
    return { slug, id: found.id };
  };

  router.get("/api/teams/:slug/room", async (req: Request, res: Response) => {
    try {
      const m = await member(req, res);
      if (m) {
        const days = Number(req.query.days);
        send(res, await deps.store().read(m.slug, m.id, req.query.since, { seen: req.query.seen === "1", ...(days > 0 ? { days } : {}) }));
      }
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/api/teams/:slug/charter", async (req: Request, res: Response) => {
    try {
      const m = await member(req, res);
      if (!m) return;
      const read = await deps.store().read(m.slug, m.id, "m_999999999");
      send(res, read.body.ok ? { status: 200, body: { ok: true, charter: read.body.room.charter } } : read);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/api/teams/:slug/messages", async (req: Request, res: Response) => {
    try {
      const m = await member(req, res);
      if (m) send(res, await deps.store().post(m.slug, m.id, req.body ?? {}));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/api/teams/:slug/cards", async (req: Request, res: Response) => {
    try {
      const m = await member(req, res);
      if (m) send(res, await deps.store().card(m.slug, m.id, (req.body ?? {}) as TeamCardOp));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/api/teams/:slug/leave", async (req: Request, res: Response) => {
    try {
      const m = await member(req, res);
      if (m) send(res, await deps.store().leave(m.slug, m.id));
    } catch (error) {
      fail(res, error);
    }
  });

  // —— Public: people who open an invite link ——
  router.get("/teams/join/:code", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store").type("html").send(INVITE_PAGE_HTML);
  });

  // —— Desktop (Multiplayer app): the ArozOS session of the owner, checked with ArozOS ——
  const desktop = (handler: (req: Request) => Promise<TeamResult>) => async (req: Request, res: Response) => {
    if (!(await verifyArozosDesktopSession(req))) {
      res.status(403).json({ ok: false, error: "Multiplayer app routes need the desktop session" });
      return;
    }
    try {
      const out = await handler(req);
      res.set("Cache-Control", "no-store").status(out.status).json(out.body);
    } catch (error) {
      fail(res, error);
    }
  };
  router.get("/api/teams/app", desktop(() => deps.service().appList()));
  router.get("/api/teams/:slug/view", desktop((req) => deps.service().view(String(req.params.slug ?? ""))));
  router.post(
    "/api/teams/:slug/drafts/:taskId/approve",
    desktop((req) => deps.service().approveDraft(String(req.params.slug ?? ""), String(req.params.taskId ?? ""))),
  );
  router.post(
    "/api/teams/:slug/questions/:taskId/answer",
    desktop((req) => deps.service().answer(String(req.params.slug ?? ""), String(req.params.taskId ?? ""), req.body ?? {})),
  );
  router.post("/api/teams/:slug/reply", desktop((req) => deps.service().reply(String(req.params.slug ?? ""), req.body ?? {})));
  router.put("/api/teams/:slug/notes", desktop((req) => deps.service().saveNotes(String(req.params.slug ?? ""), req.body ?? {})));

  // —— Localhost-only: the companion of this box ——
  const local = (handler: (req: Request) => Promise<TeamResult | { status: 200; body: Record<string, unknown> }>) =>
    async (req: Request, res: Response) => {
      if (!isDirectLocalhostRequest(req)) {
        res.status(403).json({ ok: false, error: "team-local API is localhost-only" });
        return;
      }
      try {
        const out = await handler(req);
        res.status(out.status).json(out.body);
      } catch (error) {
        fail(res, error);
      }
    };
  const slug = (req: Request) => String(req.params.slug ?? "");

  router.get("/api/team-local", local(async () => ({ status: 200, body: { ok: true, teams: await deps.service().list() } })));
  router.post("/api/team-local/create", local((req) => deps.service().create(req.body ?? {})));
  router.post("/api/team-local/preview", local((req) => deps.service().preview(req.body?.inviteLink)));
  router.post("/api/team-local/join", local((req) => deps.service().join(req.body ?? {})));
  router.post("/api/team-local/:slug/invite", local((req) => deps.service().invite(slug(req))));
  router.post("/api/team-local/:slug/remove-member", local((req) => deps.service().removeMember(slug(req), req.body?.memberId)));
  router.post("/api/team-local/:slug/charter", local((req) => deps.service().setCharter(slug(req), req.body?.charter)));
  router.post("/api/team-local/:slug/leave", local((req) => deps.service().leave(slug(req))));
  router.get(
    "/api/team-local/:slug/read",
    local((req) => deps.service().read(slug(req), { since: req.query.since, advance: req.query.advance === "1" || req.query.advance === "true" })),
  );
  router.get("/api/team-local/:slug/blockers", local((req) => deps.service().blockers(slug(req))));
  router.post("/api/team-local/:slug/post", local((req) => deps.service().post(slug(req), req.body ?? {})));
  router.post("/api/team-local/:slug/card", local((req) => deps.service().card(slug(req), (req.body ?? {}) as TeamCardOp)));
  router.post("/api/team-local/:slug/tell-owner", local((req) => deps.service().tellOwner(slug(req), req.body ?? {})));
  router.post("/api/team-local/:slug/commit", local((req) => deps.service().commit(slug(req), req.body ?? {})));
}
