import { CwmValidationError, type CwmActor } from "@joshu/whiteboard-cwm";
import type { NextFunction, Request, Response, Router } from "express";
import { CwmBackendError, CwmInputError } from "./excalidraw/errors.js";
import { CwmBoardService } from "./excalidraw/service.js";
import { CwmBoardStore } from "./excalidraw/store.js";
import { isDesktopBrowserOrLocalRequest } from "./httpLocalhost.js";
import { resolveJoshuFilesPaths } from "./joshuFilesPaths.js";

export const CWM_API_BASE = "/api/excalidraw/cwm";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLocalhostRequest(req: Request): boolean {
  return isDesktopBrowserOrLocalRequest(req);
}

/** Match the files API: echo only localhost origins used by ArozOS subservices. */
export function setCwmApiCors(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const { hostname } = new URL(origin);
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
  } catch {
    // Invalid or remote origins receive no CORS grant.
  }
}

function requestBody(req: Request): Record<string, unknown> {
  if (!isRecord(req.body)) throw new CwmInputError("JSON object body required");
  return req.body;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new CwmInputError(`${name} is required`);
  return value;
}

function optionalActor(value: unknown): CwmActor | undefined {
  return value === undefined ? undefined : (value as CwmActor);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CwmInputError("optional text fields must be strings");
  return value;
}

function numberQuery(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !raw.trim()) throw new CwmInputError(`${name} is invalid`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new CwmInputError(`${name} is invalid`);
  return parsed;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof CwmBackendError) {
    res.status(error.status).json({
      ok: false,
      error: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    return;
  }
  if (error instanceof CwmValidationError) {
    res.status(400).json({
      ok: false,
      error: error.message,
      code: "INVALID_CWM_DATA",
      issues: error.issues,
    });
    return;
  }
  console.warn("[excalidraw-cwm] request failed:", error);
  res.status(500).json({ ok: false, error: "CWM backend request failed", code: "CWM_INTERNAL" });
}

type AsyncRoute = (req: Request, res: Response) => Promise<void>;

function route(handler: AsyncRoute): (req: Request, res: Response) => void {
  return (req, res) => {
    void handler(req, res).catch((error) => sendError(res, error));
  };
}

export function registerExcalidrawCwmRoutes(router: Router): void {
  const services = new Map<string, CwmBoardService>();
  const service = (): CwmBoardService => {
    const paths = resolveJoshuFilesPaths(process.cwd());
    if (!paths) {
      throw new CwmBackendError(
        503,
        "JOSHU_FILES_UNAVAILABLE",
        "joshu files paths unavailable",
      );
    }
    let current = services.get(paths.filesRoot);
    if (!current) {
      current = new CwmBoardService(new CwmBoardStore(paths.filesRoot));
      services.set(paths.filesRoot, current);
    }
    return current;
  };

  // This router is registered after express.json(). All CWM methods share one localhost gate.
  router.use(CWM_API_BASE, (req: Request, res: Response, next: NextFunction) => {
    setCwmApiCors(req, res);
    if (!isLocalhostRequest(req)) {
      res.status(403).json({
        ok: false,
        error: "Curatorial Whiteboard API is localhost-only",
        code: "LOCALHOST_ONLY",
      });
      return;
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  router.get(
    `${CWM_API_BASE}/board`,
    route(async (req, res) => {
      const boardPath = requiredString(req.query.path, "query path");
      const loaded = await service().getHead(boardPath);
      res.json({ ok: true, path: loaded.paths.relativePath, workspace: loaded.workspace });
    }),
  );

  router.get(
    `${CWM_API_BASE}/events`,
    route(async (req, res) => {
      const boardPath = requiredString(req.query.path, "query path");
      const tail = await service().getEventTail(boardPath, {
        afterSequence: numberQuery(req.query.afterSequence, "afterSequence"),
        limit: numberQuery(req.query.limit, "limit"),
      });
      res.json({
        ok: true,
        path: tail.paths.relativePath,
        headSequence: tail.headSequence,
        events: tail.events,
      });
    }),
  );

  router.post(
    `${CWM_API_BASE}/create`,
    route(async (req, res) => {
      const body = requestBody(req);
      const created = await service().createBoard({
        path: requiredString(body.path, "path"),
      });
      res.status(201).json({
        ok: true,
        path: created.paths.relativePath,
        workspace: created.workspace,
      });
    }),
  );

  router.post(
    `${CWM_API_BASE}/proposal`,
    route(async (req, res) => {
      const body = requestBody(req);
      const result = await service().propose({
        path: requiredString(body.path, "path"),
        headSequence: body.headSequence as number,
        actor: optionalActor(body.actor),
        operations: body.operations as readonly unknown[],
        rationale: optionalString(body.rationale),
      });
      res.json({ ok: true, ...result });
    }),
  );

  for (const [action, handler] of [
    ["confirm", (boardService: CwmBoardService, input: Parameters<CwmBoardService["confirm"]>[0]) => boardService.confirm(input)],
    ["reject", (boardService: CwmBoardService, input: Parameters<CwmBoardService["reject"]>[0]) => boardService.reject(input)],
  ] as const) {
    router.post(
      `${CWM_API_BASE}/${action}`,
      route(async (req, res) => {
        const body = requestBody(req);
        const result = await handler(service(), {
          path: requiredString(body.path, "path"),
          headSequence: body.headSequence as number,
          actor: optionalActor(body.actor),
          proposalId: requiredString(body.proposalId, "proposalId"),
          reason: optionalString(body.reason),
        });
        res.json({ ok: true, ...result });
      }),
    );
  }

  router.post(
    `${CWM_API_BASE}/compensate`,
    route(async (req, res) => {
      const body = requestBody(req);
      const result = await service().compensate({
        path: requiredString(body.path, "path"),
        headSequence: body.headSequence as number,
        actor: optionalActor(body.actor),
        eventId: requiredString(body.eventId, "eventId"),
        reason: optionalString(body.reason),
      });
      res.json({ ok: true, ...result });
    }),
  );

  router.post(
    `${CWM_API_BASE}/checkpoint`,
    route(async (req, res) => {
      const body = requestBody(req);
      const result = await service().checkpoint({
        path: requiredString(body.path, "path"),
        headSequence: body.headSequence as number,
        actor: optionalActor(body.actor),
        scene: body.scene,
        reason: optionalString(body.reason),
      });
      res.json({ ok: true, ...result });
    }),
  );

  router.post(
    `${CWM_API_BASE}/consolidate`,
    route(async (req, res) => {
      const body = requestBody(req);
      const result = await service().consolidate({
        path: requiredString(body.path, "path"),
        headSequence: body.headSequence as number,
        actor: optionalActor(body.actor),
        markdown: body.markdown as string,
        fileName: optionalString(body.fileName),
      });
      res.json({ ok: true, ...result });
    }),
  );
}
