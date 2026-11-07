/**
 * REST routes of the research module (change research-reports, design decisions D7 and D10).
 *
 * - `POST /api/research/reports` makes a Research report and waits for it (the Hermes plugin
 *   `joshu-research` calls it). With a `channel`, the Research app starts it in the background
 *   with the chosen `sources`, and Joshu sends it on that channel when it is done (change
 *   recurring-research-reports, design decision D12).
 * - `GET /api/research/reports?q=` finds earlier Research reports.
 * Both need the desktop session of the owner (checked with ArozOS) or direct localhost.
 * - `GET /api/research/r/:id/:sig/report.pdf` is the public report link. It needs the signature,
 *   not a sign-in.
 */

import type { Request, Response, Router } from "express";
import fs from "node:fs";
import { verifyArozosDesktopSession } from "../httpLocalhost.js";
import { ResearchStepError } from "./errors.js";
import { makeResearchReport, type MakeDeps } from "./make.js";
import { parseWebProvider, WEB_PROVIDERS } from "./pipeline/you.js";
import { boxSenders, deliver, type DeliveryResult, type DeliverySenders } from "./recurring/delivery.js";
import { parseChannel, parseSources, SOURCES_ERROR } from "./recurring/service.js";
import type { ReportChannel } from "./recurring/types.js";
import { reportLink, reportLinkSecret, resolveSignedReport } from "./reportLinks.js";
import { findReports, resolveReportRoots, type StoredReport } from "./store.js";

export type ResearchRouteDeps = {
  projectRoot: string;
  /** Tests only. */
  make?: (topic: string, opts?: Pick<MakeDeps, "sources" | "request" | "webProvider">) => Promise<StoredReport>;
  roots?: ReturnType<typeof resolveReportRoots>;
  publicBase?: string;
  allowRequest?: (req: Request) => boolean | Promise<boolean>;
  senders?: DeliverySenders;
};

/**
 * Send a Research report from the Research app on `channel`: the PDF attached in email, the report
 * link on the other channels (design decisions D7 and D12).
 */
export async function sendReport(report: StoredReport, channel: ReportChannel, link: string, senders: DeliverySenders): Promise<DeliveryResult> {
  const subject = `Research report: ${report.topic}`;
  const text = `${report.summary}\n\nThe full report: ${link}`;
  if (channel !== "email") return deliver(channel, { subject, text, dedupeKey: `report:${report.id}` }, senders);
  const content = fs.readFileSync(report.pdfPath);
  return deliver(
    "email",
    {
      subject,
      text: `${report.emailBody}\n\nThe full report is attached as a PDF.`,
      attachments: [{ filename: `${report.id}.pdf`, contentType: "application/pdf", content, size: content.length }],
      dedupeKey: `report:${report.id}`,
    },
    senders,
  );
}

function reportJson(report: StoredReport, link: string) {
  return {
    id: report.id,
    topic: report.topic,
    requestedAt: report.requestedAt,
    summary: report.summary,
    emailBody: report.emailBody,
    sources: report.sources.map((s) => ({ name: s.label, state: s.state })),
    pdfDesktopPath: report.pdfDesktopPath,
    pdfFilesPath: report.pdfFilesPath,
    reportLink: link,
  };
}

export function registerResearchRoutes(router: Router, deps: ResearchRouteDeps): void {
  const allowed = deps.allowRequest ?? verifyArozosDesktopSession;
  const roots = () => deps.roots ?? resolveReportRoots(deps.projectRoot);
  const link = (id: string) => reportLink(id, reportLinkSecret(deps.projectRoot), deps.publicBase);

  router.post("/api/research/reports", async (req: Request, res: Response) => {
    if (!(await allowed(req))) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
    if (!topic) {
      res.status(400).json({ ok: false, error: "topic is required" });
      return;
    }
    const make = deps.make ?? ((t: string, opts?: Pick<MakeDeps, "sources" | "request" | "webProvider">) => makeResearchReport(deps.projectRoot, t, opts));
    // The web search provider of this report (change research-web-provider): Exa unless the request names You.com.
    const webProvider = parseWebProvider(req.body?.web_provider);
    if (!webProvider) {
      res.status(400).json({ ok: false, error: `web_provider must be one of: ${WEB_PROVIDERS.join(", ")}` });
      return;
    }
    // What the owner said about the topic and the sections that the owner wants (D14 and D15), and
    // the hints that the companion took from its skills (change content-router, D8).
    const request = {
      ...(typeof req.body?.notes === "string" ? { notes: req.body.notes } : {}),
      ...(Array.isArray(req.body?.sections) ? { sections: req.body.sections.filter((x: unknown): x is string => typeof x === "string") } : {}),
      ...(Array.isArray(req.body?.hints) ? { hints: req.body.hints.filter((x: unknown): x is string => typeof x === "string") } : {}),
    };
    if (req.body?.channel !== undefined) {
      const channel = parseChannel(req.body.channel);
      const sources = parseSources(req.body.sources);
      if (!channel || !sources) {
        res.status(400).json({ ok: false, error: channel ? SOURCES_ERROR : "a known channel and sources (auto or a list) are required" });
        return;
      }
      // The Research app does not wait: the report takes minutes, and Joshu sends it when it is done.
      void make(topic, sources === "auto" ? { request, webProvider } : { sources, request, webProvider })
        .then((report) => sendReport(report, channel, link(report.id), deps.senders ?? boxSenders(deps.projectRoot)))
        .then((sent) => {
          if (!sent.delivered) console.warn(`[research] report from the app not sent: ${sent.error}`);
        })
        .catch(async (err) => {
          const step = err instanceof ResearchStepError ? err.step : "store";
          console.warn(`[research] report from the app failed at ${step}: ${(err as Error).message}`);
          await deliver(channel, { subject: `Research report: ${topic}`, text: `Your Research report on "${topic}" failed, so I sent nothing. You can start it again in the Research app.`, dedupeKey: `report-failed:${topic}` }, deps.senders ?? boxSenders(deps.projectRoot));
        });
      res.status(202).json({ ok: true, started: true });
      return;
    }
    try {
      const report = await make(topic, { request, webProvider });
      res.json({ ok: true, report: reportJson(report, link(report.id)) });
    } catch (err) {
      const step = err instanceof ResearchStepError ? err.step : "store";
      console.warn(`[research] report failed at ${step}: ${(err as Error).message}`);
      res.json({ ok: false, step, error: (err as Error).message });
    }
  });

  router.get("/api/research/reports", async (req: Request, res: Response) => {
    if (!(await allowed(req))) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const r = roots();
    if (!r) {
      res.json({ ok: true, reports: [] });
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q : "";
    // The Research app lists every report (`all=1`); a search returns the 20 newest matches.
    const found = findReports(r, q);
    res.json({ ok: true, reports: (req.query.all === "1" ? found : found.slice(0, 20)).map((report) => reportJson(report, link(report.id))) });
  });

  router.get("/api/research/r/:id/:sig/report.pdf", (req: Request, res: Response) => {
    const r = roots();
    const id = String(req.params.id ?? "");
    const sig = String(req.params.sig ?? "");
    const report = r ? resolveSignedReport(r, reportLinkSecret(deps.projectRoot), id, sig) : null;
    if (!report) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${report.id}.pdf"`);
    res.setHeader("Cache-Control", "private, max-age=0");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(report.pdfPath, (err) => {
      if (err && !res.headersSent) res.status(404).type("text/plain").send("not found");
    });
  });
}
