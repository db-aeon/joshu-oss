import type { Request, Response, Router } from "express";
import { getDay0Status, runDay0ColdStart } from "./coldStart.js";
import { runDay0Sweep } from "./sweep.js";
import { isDay0LlmConfigured, resolveDay0Model } from "./llm.js";
import { isGmailConnected } from "../connectors/syncHelpers.js";

export function registerDay0Routes(router: Router, opts: { projectRoot: string }): void {
  router.get("/api/day0/status", async (_req: Request, res: Response) => {
    try {
      const day0 = getDay0Status(opts.projectRoot);
      const gmailConnected = await isGmailConnected(opts.projectRoot);
      res.json({
        day0,
        gmailConnected,
        llmConfigured: isDay0LlmConfigured(),
        model: resolveDay0Model(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/day0/cold-start", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await runDay0ColdStart(opts.projectRoot, {
        force: body.force === true,
        connectedAccountId:
          typeof body.connectedAccountId === "string" ? body.connectedAccountId : undefined,
        ownerName: typeof body.ownerName === "string" ? body.ownerName : undefined,
        assistantName: typeof body.assistantName === "string" ? body.assistantName : undefined,
      });
      if (!result.ok) {
        res.status(result.error?.includes("required") ? 400 : 502).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/day0/sweep", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await runDay0Sweep(opts.projectRoot, {
        since: typeof body.since === "string" ? body.since : undefined,
        connectedAccountId:
          typeof body.connectedAccountId === "string" ? body.connectedAccountId : undefined,
      });
      if (!result.ok) {
        res.status(502).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
