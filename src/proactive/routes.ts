import type { Request, Response, Router } from "express";

import { isDirectLocalhostRequest } from "../httpLocalhost.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { readAgentProfile } from "../nylas/profile.js";
import { recordProactiveFeedback, parseFeedbackKeyword, parseTaskActionKeyword } from "./feedback.js";
import { handleProactiveTaskAction } from "./replyRouter.js";
import { resolveProactiveOwnerReply } from "./resolveOwnerReply.js";
import {
  canSendNudge,
  ownerLocalDateString,
  readProactiveState,
  rolloverProactiveState,
  writeProactiveState,
} from "./state.js";
import { sweepProactiveCandidates, pickTopProactiveCandidate } from "./sweep.js";
import { runProactiveTick, applySentNudge } from "./tick.js";
import { deliverProactiveNudge } from "./delivery.js";
import { prepareHygienePlan, readHygienePlan } from "./hygienePrepare.js";
import { recordHygieneRun } from "./hygieneRecord.js";
import { isOwnerAvailableForProactive } from "./meetingWindow.js";

function readBool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * Proactive REST is box-internal only (cron / SSH). Public Caddy → /joshu/* must not
 * forge ticks, nudges, or owner-reply injection. Uses direct-localhost (rejects
 * X-Forwarded-* from Caddy — plain req.ip===127.0.0.1 is insufficient on VPS).
 */
function requireLocalhost(req: Request, res: Response): boolean {
  if (isDirectLocalhostRequest(req)) return true;
  res.status(403).json({ ok: false, error: "proactive API is localhost-only" });
  return false;
}

/** Proactive Joshu REST — deterministic, no LLM on tick/sweep. Localhost-only. */
export function registerProactiveRoutes(router: Router, opts: { projectRoot: string }): void {
  router.get("/api/proactive/status", (req: Request, res: Response) => {
    if (!requireLocalhost(req, res)) return;
    const profile = readAgentProfile(opts.projectRoot);
    const tz = profile?.timezone?.trim();
    const state = readProactiveState(opts.projectRoot, tz);
    res.json({
      ok: true,
      state,
      timezone: tz ?? null,
      localDate: tz ? ownerLocalDateString(tz) : null,
    });
  });

  router.post("/api/proactive/sweep", async (req: Request, res: Response) => {
    if (!requireLocalhost(req, res)) return;
    const paths = resolveJoshuFilesPaths(opts.projectRoot);
    if (!paths?.filesRoot) {
      res.status(503).json({ ok: false, error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const profile = readAgentProfile(opts.projectRoot);
    const tz = profile?.timezone?.trim();
    const today = tz ? ownerLocalDateString(tz) : new Date().toISOString().slice(0, 10);
    const state = readProactiveState(opts.projectRoot, tz);
    try {
      const candidates = await sweepProactiveCandidates({
        filesRoot: paths.filesRoot,
        projectRoot: opts.projectRoot,
        state,
        today,
      });
      res.json({ ok: true, count: candidates.length, candidates });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/proactive/tick", async (req: Request, res: Response) => {
    if (!requireLocalhost(req, res)) return;
    const dryRun = readBool(req.body?.dryRun);
    try {
      const result = await runProactiveTick({ projectRoot: opts.projectRoot, dryRun });
      res.json(result);
    } catch (err) {
      res.status(500).json({
        ok: false,
        action: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post("/api/proactive/nudge", async (req: Request, res: Response) => {
    if (!requireLocalhost(req, res)) return;
    const paths = resolveJoshuFilesPaths(opts.projectRoot);
    if (!paths?.filesRoot) {
      res.status(503).json({ ok: false, error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const profile = readAgentProfile(opts.projectRoot);
    const tz = profile?.timezone?.trim();
    const today = tz ? ownerLocalDateString(tz) : new Date().toISOString().slice(0, 10);
    let state = rolloverProactiveState(readProactiveState(opts.projectRoot, tz), today);
    const cap = canSendNudge(state);
    if (!cap.ok) {
      res.status(429).json({ ok: false, error: cap.reason });
      return;
    }
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId.trim() : "";
    let candidate = taskId
      ? (await sweepProactiveCandidates({
          filesRoot: paths.filesRoot,
          projectRoot: opts.projectRoot,
          state,
          today,
        })).find((c) => c.taskId === taskId)
      : await pickTopProactiveCandidate({
          filesRoot: paths.filesRoot,
          projectRoot: opts.projectRoot,
          state,
          today,
        });
    if (!candidate) {
      res.status(404).json({ ok: false, error: "no_candidate" });
      return;
    }
    const meeting = await isOwnerAvailableForProactive(opts.projectRoot);
    if (!meeting.ok) {
      res.status(409).json({ ok: false, error: meeting.reason ?? "owner_in_meeting", busyUntil: meeting.busyUntil });
      return;
    }
    const delivery = await deliverProactiveNudge({ candidate, projectRoot: opts.projectRoot });
    if (!delivery.delivered) {
      res.status(502).json({ ok: false, error: delivery.error ?? "delivery_failed" });
      return;
    }
    state = applySentNudge(
      state,
      {
        taskId: candidate.taskId,
        board: candidate.board,
        title: candidate.title,
        blockReason: candidate.blockReason,
        sentAt: new Date().toISOString(),
        channel: delivery.channel ?? "unknown",
      },
      today,
    );
    writeProactiveState(state, opts.projectRoot);
    res.json({ ok: true, candidate, channel: delivery.channel });
  });

  router.post("/api/proactive/feedback", async (req: Request, res: Response) => {
    if (!requireLocalhost(req, res)) return;
    const body =
      typeof req.body?.body === "string"
        ? req.body.body
        : typeof req.body?.text === "string"
          ? req.body.text
          : "";
    if (!body.trim()) {
      res.status(400).json({ ok: false, error: "body required" });
      return;
    }
    const profile = readAgentProfile(opts.projectRoot);
    const result = await recordProactiveFeedback(body, opts.projectRoot, profile?.timezone?.trim());
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  router.get("/api/proactive/hygiene/status", (req: Request, res: Response) => {
    if (!requireLocalhost(req, res)) return;
    const profile = readAgentProfile(opts.projectRoot);
    const tz = profile?.timezone?.trim();
    const state = readProactiveState(opts.projectRoot, tz);
    res.json({
      ok: true,
      hygieneLastRunAt: state.hygieneLastRunAt ?? null,
      hygieneClosedTaskIds: state.hygieneClosedTaskIds ?? [],
      lastHygieneSummary: state.lastHygieneSummary ?? null,
      hygieneAmbiguousQueue: state.hygieneAmbiguousQueue ?? [],
    });
  });

  router.post("/api/proactive/hygiene/prepare", async (req: Request, res: Response) => {
    if (!requireLocalhost(req, res)) return;
    try {
      const plan = await prepareHygienePlan(opts.projectRoot);
      res.json({ ok: true, plan });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get("/api/proactive/hygiene/plan", (req: Request, res: Response) => {
    if (!requireLocalhost(req, res)) return;
    const plan = readHygienePlan(opts.projectRoot);
    if (!plan) {
      res.status(404).json({ ok: false, error: "no_hygiene_plan" });
      return;
    }
    res.json({ ok: true, plan });
  });

  router.post("/api/proactive/hygiene/record", (req: Request, res: Response) => {
    if (!requireLocalhost(req, res)) return;
    const body = req.body ?? {};
    const closedTaskIds = Array.isArray(body.closedTaskIds)
      ? body.closedTaskIds.filter((id: unknown): id is string => typeof id === "string")
      : [];
    const ambiguous = Array.isArray(body.ambiguous)
      ? body.ambiguous.filter(
          (item: unknown): item is Record<string, unknown> =>
            item !== null && typeof item === "object",
        )
      : [];
    const state = recordHygieneRun(opts.projectRoot, {
      closedTaskIds,
      ambiguous: ambiguous.map((item: Record<string, unknown>) => ({
        taskId: String(item.taskId ?? item.task_id ?? "").trim(),
        board: String(item.board ?? "").trim(),
        title: typeof item.title === "string" ? item.title : undefined,
        blockReason:
          typeof item.blockReason === "string"
            ? item.blockReason
            : typeof item.block_reason === "string"
              ? item.block_reason
              : null,
      })),
      skipped: typeof body.skipped === "number" ? body.skipped : undefined,
      active: typeof body.active === "number" ? body.active : undefined,
      summary: typeof body.summary === "string" ? body.summary : undefined,
    });
    res.json({ ok: true, state });
  });

  router.post("/api/proactive/owner-reply", async (req: Request, res: Response) => {
    if (!requireLocalhost(req, res)) return;
    const paths = resolveJoshuFilesPaths(opts.projectRoot);
    if (!paths?.filesRoot) {
      res.status(503).json({ ok: false, error: "JOSHU_FILES_ROOT unavailable" });
      return;
    }
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    if (!body.trim()) {
      res.status(400).json({ ok: false, error: "body required" });
      return;
    }
    if (parseFeedbackKeyword(body)) {
      const profile = readAgentProfile(opts.projectRoot);
      const fb = await recordProactiveFeedback(body, opts.projectRoot, profile?.timezone?.trim());
      res.json({ ...fb, action: "feedback_keyword" });
      return;
    }
    const taskAction = parseTaskActionKeyword(body);
    if (taskAction) {
      const result = await handleProactiveTaskAction({
        action: taskAction,
        body,
        filesRoot: paths.filesRoot,
        projectRoot: opts.projectRoot,
        taskId: typeof req.body?.taskId === "string" ? req.body.taskId : undefined,
        board: typeof req.body?.board === "string" ? req.body.board : undefined,
      });
      res.json(result);
      return;
    }
    try {
      const result = await resolveProactiveOwnerReply({
        body,
        filesRoot: paths.filesRoot,
        projectRoot: opts.projectRoot,
        sessionKey: `proactive:resolve:${typeof req.body?.taskId === "string" ? req.body.taskId : "api"}`,
        taskId: typeof req.body?.taskId === "string" ? req.body.taskId : undefined,
        board: typeof req.body?.board === "string" ? req.body.board : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({
        ok: false,
        action: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
