import type { Request, Response, Router } from "express";
import {
  callCronBridge,
  type CronBridgePayload,
  type CronBridgeResult,
} from "./hermesCronBridge.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text || undefined;
}

function readSkills(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => readString(item)).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  const text = readString(value);
  if (!text) return undefined;
  const items = text.split(",").map((part) => part.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function sendBridgeResult(res: Response, result: CronBridgeResult): void {
  if (result.success) {
    res.json(result);
    return;
  }
  res.status(400).json(result);
}

export function registerHermesCronRoutes(router: Router): void {
  router.get("/api/cron/status", async (_req: Request, res: Response) => {
    try {
      const result = await callCronBridge({ action: "status" });
      if (!result.success) {
        res.status(500).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.get("/api/cron/jobs", async (req: Request, res: Response) => {
    try {
      const includeDisabled = req.query.includeDisabled !== "false";
      const result = await callCronBridge({ action: "list", include_disabled: includeDisabled });
      if (!result.success) {
        res.status(500).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.get("/api/cron/jobs/:jobId", async (req: Request, res: Response) => {
    const jobId = readString(req.params.jobId);
    if (!jobId) {
      res.status(400).json({ success: false, error: "jobId required" });
      return;
    }
    try {
      const result = await callCronBridge({ action: "get", job_id: jobId });
      if (!result.success) {
        res.status(404).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/api/cron/jobs", async (req: Request, res: Response) => {
    const schedule = readString(req.body?.schedule);
    if (!schedule) {
      res.status(400).json({ success: false, error: "schedule is required" });
      return;
    }
    try {
      const result = await callCronBridge({
        action: "create",
        schedule,
        name: readOptionalString(req.body?.name),
        prompt: readOptionalString(req.body?.prompt),
        deliver: readOptionalString(req.body?.deliver),
        skills: readSkills(req.body?.skills),
        script: readOptionalString(req.body?.script),
        no_agent: Boolean(req.body?.noAgent),
        workdir: readOptionalString(req.body?.workdir),
        profile: readOptionalString(req.body?.profile),
        repeat: typeof req.body?.repeat === "number" ? req.body.repeat : undefined,
      });
      sendBridgeResult(res, result);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.patch("/api/cron/jobs/:jobId", async (req: Request, res: Response) => {
    const jobId = readString(req.params.jobId);
    if (!jobId) {
      res.status(400).json({ success: false, error: "jobId required" });
      return;
    }
    const payload: CronBridgePayload = { action: "update", job_id: jobId };
    if (req.body?.schedule !== undefined) payload.schedule = readString(req.body.schedule);
    if (req.body?.name !== undefined) payload.name = readString(req.body.name);
    if (req.body?.prompt !== undefined) payload.prompt = readString(req.body.prompt);
    if (req.body?.deliver !== undefined) payload.deliver = readString(req.body.deliver);
    if (req.body?.skills !== undefined) payload.skills = readSkills(req.body.skills) ?? [];
    if (req.body?.script !== undefined) payload.script = readString(req.body.script);
    if (req.body?.noAgent !== undefined) payload.no_agent = Boolean(req.body.noAgent);
    if (req.body?.workdir !== undefined) payload.workdir = readString(req.body.workdir);
    if (req.body?.profile !== undefined) payload.profile = readString(req.body.profile);
    if (typeof req.body?.repeat === "number") payload.repeat = req.body.repeat;

    try {
      const result = await callCronBridge(payload);
      sendBridgeResult(res, result);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/api/cron/jobs/:jobId/pause", async (req: Request, res: Response) => {
    const jobId = readString(req.params.jobId);
    if (!jobId) {
      res.status(400).json({ success: false, error: "jobId required" });
      return;
    }
    try {
      const result = await callCronBridge({
        action: "pause",
        job_id: jobId,
        reason: readOptionalString(req.body?.reason),
      });
      sendBridgeResult(res, result);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/api/cron/jobs/:jobId/resume", async (req: Request, res: Response) => {
    const jobId = readString(req.params.jobId);
    if (!jobId) {
      res.status(400).json({ success: false, error: "jobId required" });
      return;
    }
    try {
      const result = await callCronBridge({ action: "resume", job_id: jobId });
      sendBridgeResult(res, result);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/api/cron/jobs/:jobId/run", async (req: Request, res: Response) => {
    const jobId = readString(req.params.jobId);
    if (!jobId) {
      res.status(400).json({ success: false, error: "jobId required" });
      return;
    }
    try {
      const result = await callCronBridge({ action: "run", job_id: jobId });
      sendBridgeResult(res, result);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.delete("/api/cron/jobs/:jobId", async (req: Request, res: Response) => {
    const jobId = readString(req.params.jobId);
    if (!jobId) {
      res.status(400).json({ success: false, error: "jobId required" });
      return;
    }
    try {
      const result = await callCronBridge({ action: "remove", job_id: jobId });
      sendBridgeResult(res, result);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });
}
