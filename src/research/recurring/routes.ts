/**
 * REST routes of recurring reports (change recurring-research-reports, design decisions D1, D12,
 * and D13). The Hermes plugin tools and the Research app call the same routes, so chat and the app
 * always change the same recurring report.
 *
 * - `GET /api/research/recurring`, `POST /api/research/recurring`, `PATCH /api/research/recurring/:id`,
 *   `POST /api/research/recurring/:id/pause`, `POST /api/research/recurring/:id/resume`,
 *   `DELETE /api/research/recurring/:id`, `GET /api/research/recurring/:id/updates`,
 *   `GET /api/research/recurring/:id/stories`, and `GET /api/research/channels`: the desktop session
 *   of the owner (checked with ArozOS) or direct localhost.
 * - `POST /api/research/recurring/:id/run`: direct localhost only. The script of the Hermes cron job
 *   calls it. It answers 202 and runs in the background.
 * - `POST /api/research/reports/:id/updates` (tool `research_update_make`) and
 *   `POST /api/research/updates/pdf` (tool `research_update_pdf`): direct localhost only (D8, D9).
 * - `GET /api/research/u/<update identifier>/<signature>/update.pdf`: the public report link of the
 *   PDF of a report update. It needs the signature, not a sign-in.
 */

import { withoutCitations } from "../themes/text.js";
import path from "node:path";
import type { Request, Response, Router } from "express";
import { isDirectLocalhostRequest, verifyArozosDesktopSession } from "../../httpLocalhost.js";
import { resolveOwnerTimezone } from "../../ownerLocalTime.js";
import { ownerTextChannelFor } from "../../ownerTextChannel.js";
import { ResearchStepError } from "../errors.js";
import { reportLinkSecret, resolveSignedUpdate, updateLink } from "../reportLinks.js";
import { makeRepeatUpdate } from "./repeat.js";
import type { RecurringRuntime } from "./runtime.js";
import { parseChannel } from "./service.js";
import { renderUpdatePdf, updateIdentity } from "./updatePdf.js";
import { readStoriesFile, readUpdates } from "./store.js";
import type { ReportChannel, StoryStatus } from "./types.js";

export type RecurringRouteDeps = {
  projectRoot: string;
  runtime: () => RecurringRuntime | null;
  /** Tests only: the checks of the routes. */
  allowApp?: (req: Request) => Promise<boolean>;
  allowLocal?: (req: Request) => boolean;
  /** Tests only: which channels the box can send on. */
  channels?: () => Promise<Record<ReportChannel, boolean>>;
  publicBase?: string;
  /** Tests only: the PDF writer of a report update. */
  writePdf?: (htmlPath: string, pdfPath: string) => Promise<void>;
};

export function registerRecurringRoutes(router: Router, deps: RecurringRouteDeps): void {
  const allowApp = deps.allowApp ?? verifyArozosDesktopSession;
  const allowLocal = deps.allowLocal ?? isDirectLocalhostRequest;
  const fail = (res: Response, error: unknown) => res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });

  /** A route for the app and the plugin tools. */
  const app =
    (handler: (req: Request, rt: RecurringRuntime) => Promise<{ status: number; body: unknown }>) =>
    async (req: Request, res: Response) => {
      if (!(await allowApp(req))) {
        res.status(403).json({ ok: false, error: "the research routes need the desktop session" });
        return;
      }
      const rt = deps.runtime();
      if (!rt) {
        res.status(503).json({ ok: false, error: "the box has no owner files folder" });
        return;
      }
      try {
        const out = await handler(req, rt);
        res.set("Cache-Control", "no-store").status(out.status).json(out.body);
      } catch (error) {
        fail(res, error);
      }
    };

  const id = (req: Request) => String(req.params.id ?? "");

  router.get("/api/research/recurring", app(async (_req, rt) => ({ status: 200, body: { ok: true, reports: rt.service.list() } })));

  router.post(
    "/api/research/recurring",
    app(async (req, rt) => rt.service.save({ ...(req.body ?? {}), id: undefined, origin: req.body?.origin === "app" ? "app" : "chat" })),
  );

  router.patch("/api/research/recurring/:id", app(async (req, rt) => rt.service.save({ ...(req.body ?? {}), id: id(req) })));

  router.post("/api/research/recurring/:id/pause", app(async (req, rt) => rt.service.setState(id(req), "pause")));
  router.post("/api/research/recurring/:id/resume", app(async (req, rt) => rt.service.setState(id(req), "resume")));
  router.delete("/api/research/recurring/:id", app(async (req, rt) => rt.service.setState(id(req), "delete")));

  router.get(
    "/api/research/recurring/:id/updates",
    app(async (req, rt) => {
      const setup = rt.service.store.get(id(req));
      if (!setup || setup.state === "deleted") return { status: 404, body: { ok: false, error: "unknown recurring report" } };
      const updates = readUpdates(rt.service.store.folder(setup)).map((u) => ({
        run: u.run,
        at: u.period.to,
        result: !u.stories.some((s) => s.status !== "quiet") ? "nothing new" : u.delivery?.result === "failed" ? "failed" : "delivered",
        stories: u.stories.filter((s) => s.status !== "quiet").length,
        channel: u.delivery?.channel,
        digest: u.digest?.text ?? "",
        // A report update with themes (change research-report-topics) opens with its summary and themes.
        ...(u.themes?.length
          ? {
              summary: withoutCitations(u.summary ?? ""),
              themes: u.themes.map((t) => ({ title: t.title, paragraphs: t.body.split(/\n\s*\n/).map(withoutCitations).filter(Boolean), links: t.links ?? [] })),
            }
          : {}),
        sources: u.sources.map((s) => ({ name: s.label, state: s.state })),
      }));
      return { status: 200, body: { ok: true, updates } };
    }),
  );

  router.get(
    "/api/research/recurring/:id/stories",
    app(async (req, rt) => {
      const setup = rt.service.store.get(id(req));
      if (!setup || setup.state === "deleted") return { status: 404, body: { ok: false, error: "unknown recurring report" } };
      const folder = rt.service.store.folder(setup);
      const last = readUpdates(folder)[0];
      const statusOf = new Map<string, StoryStatus>(last?.stories.map((s) => [s.id, s.status]) ?? []);
      const lanes = new Map(setup.lanes.map((l) => [l.id, l.topic]));
      const stories = readStoriesFile(path.join(folder, "stories.json"))
        .stories.sort((a, b) => b.lastRun.localeCompare(a.lastRun))
        .map((s) => ({
          id: s.id,
          title: s.title,
          summary: s.summary,
          lane: lanes.get(s.laneId) ?? "",
          // A stored story that the last run did not find is quiet.
          status: statusOf.get(s.id) ?? "quiet",
          items: s.items.length,
          sources: [...new Set(s.items.map((i) => i.sourceLabel))].slice(0, 6),
          lastRun: s.lastRun,
          link: s.items.at(-1)?.url,
        }));
      return { status: 200, body: { ok: true, stories } };
    }),
  );

  router.get(
    "/api/research/channels",
    app(async (_req, rt) => {
      if (deps.channels) return { status: 200, body: { ok: true, channels: await deps.channels() } };
      const senders = rt.runDeps().senders;
      const text = ownerTextChannelFor(deps.projectRoot);
      const [slack, telegram] = await Promise.all([senders.origin("slack"), senders.origin("telegram")]);
      const channels: Record<ReportChannel, boolean> = {
        email: senders.profileEmails().length > 0,
        sms: text === "sms",
        // Slack and Telegram only when the owner has talked to the companion there (design decision D7).
        slack: Boolean(slack),
        telegram: Boolean(telegram),
      };
      return { status: 200, body: { ok: true, channels } };
    }),
  );

  /** A route for the plugin tools only. */
  const local =
    (handler: (req: Request, rt: RecurringRuntime) => Promise<{ status: number; body: unknown }>) =>
    async (req: Request, res: Response) => {
      if (!allowLocal(req)) {
        res.status(403).json({ ok: false, error: "this research route is localhost-only" });
        return;
      }
      const rt = deps.runtime();
      if (!rt) {
        res.status(503).json({ ok: false, error: "the box has no owner files folder" });
        return;
      }
      try {
        const out = await handler(req, rt);
        res.status(out.status).json(out.body);
      } catch (err) {
        // The companion names the step that failed when it tells the owner.
        const step = err instanceof ResearchStepError ? err.step : "store";
        console.warn(`[research] report update failed at ${step}: ${(err as Error).message}`);
        res.json({ ok: false, step, error: (err as Error).message });
      }
    };
  const link = (updateId: string) => updateLink(updateId, reportLinkSecret(deps.projectRoot), deps.publicBase);

  router.post(
    "/api/research/reports/:id/updates",
    local(async (req, rt) => {
      const channel = parseChannel(req.body?.channel ?? "email") ?? "email";
      const result = await makeRepeatUpdate(rt.service.store.roots, id(req), channel, rt.runDeps());
      return { status: 200, body: { ok: true, update: result } };
    }),
  );

  router.post(
    "/api/research/updates/pdf",
    local(async (req, rt) => {
      const updateId = typeof req.body?.update === "string" ? req.body.update.trim() : "";
      const pdf = await renderUpdatePdf(rt.service.store.roots, updateId, { timezone: resolveOwnerTimezone(deps.projectRoot), identity: await updateIdentity(deps.projectRoot), ...(deps.writePdf ? { writePdf: deps.writePdf } : {}) });
      return { status: 200, body: { ok: true, update: updateId, pdfDesktopPath: pdf.pdfDesktopPath, pdfFilesPath: pdf.pdfFilesPath, reportLink: link(updateId) } };
    }),
  );

  router.get(/^\/api\/research\/u\/(.+)\/([A-Za-z0-9_-]{22})\/update\.pdf$/, (req: Request, res: Response) => {
    const rt = deps.runtime();
    const params = req.params as unknown as Record<string, string>;
    const pdf = rt ? resolveSignedUpdate(rt.service.store.roots, reportLinkSecret(deps.projectRoot), params[0] ?? "", params[1] ?? "") : null;
    if (!pdf) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="report-update.pdf"`);
    res.setHeader("Cache-Control", "private, max-age=0");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(pdf, (err) => {
      if (err && !res.headersSent) res.status(404).type("text/plain").send("not found");
    });
  });

  router.post("/api/research/recurring/:id/run", async (req: Request, res: Response) => {
    if (!allowLocal(req)) {
      res.status(403).json({ ok: false, error: "the run route is localhost-only" });
      return;
    }
    const rt = deps.runtime();
    if (!rt) {
      res.status(503).json({ ok: false, error: "the box has no owner files folder" });
      return;
    }
    try {
      const started = await rt.runner.trigger(id(req));
      if (started === "unknown") {
        res.status(404).json({ ok: false, error: `unknown recurring report ${id(req)}` });
        return;
      }
      res.status(202).json({ ok: true, run: started });
    } catch (error) {
      fail(res, error);
    }
  });
}
