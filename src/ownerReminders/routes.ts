import type { Request, Response, Router } from "express";

import { isDirectLocalhostRequest } from "../httpLocalhost.js";
import type { OwnerReminderService } from "./service.js";

/**
 * Owner reminder REST (spec owner-reminders). Localhost-only: the connectors MCP
 * and the owner reminder scripts call it from the box; Caddy must not reach it.
 */
export function registerOwnerReminderRoutes(router: Router, service: () => OwnerReminderService): void {
  const guard = (req: Request, res: Response): boolean => {
    if (isDirectLocalhostRequest(req)) return true;
    res.status(403).json({ ok: false, error: "owner reminder API is localhost-only" });
    return false;
  };
  const fail = (res: Response, error: unknown) =>
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });

  router.get("/api/owner-reminders", async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const reminders = await service().list();
      const includeRetired = req.query.includeRetired === "1" || req.query.includeRetired === "true";
      res.json({ ok: true, reminders: includeRetired ? reminders : reminders.filter((r) => r.status === "active") });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/api/owner-reminders", async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const out = await service().create(req.body ?? {});
      res.status(out.status).json(out.body);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/api/owner-reminders/:id/stop", async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const reason = req.body?.reason === "owner_done" ? "owner_done" : "stopped";
      const out = await service().stop(String(req.params.id ?? ""), reason);
      res.status(out.status).json(out.body);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/api/owner-reminders/:id/fire", async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const out = await service().fire(String(req.params.id ?? ""));
      res.status(out.status).json(out.body);
    } catch (error) {
      fail(res, error);
    }
  });
}
