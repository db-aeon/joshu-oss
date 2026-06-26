import type { Request, Response, Router } from "express";
import {
  createSnapshot,
  factoryApplySoft,
  factoryWipePersonal,
  getBoxStatus,
  listSnapshots,
  restoreSnapshot,
  resolveBoxPaths,
  runHardResetPostSteps,
  runHardResetPreflight,
  stopGbrainStack,
  writeDefaultIdentity,
} from "@joshu/box-state";

function isBoxMutatingAllowed(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  const host = (req.hostname ?? "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost";
}

export function registerBoxStateRoutes(
  router: Router,
  deps?: { onHardResetComplete?: () => void | Promise<void> },
): void {
  router.get("/api/box/status", (_req: Request, res: Response) => {
    try {
      const paths = resolveBoxPaths(process.cwd());
      res.json(getBoxStatus(paths));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/api/box/snapshots", async (_req: Request, res: Response) => {
    try {
      const paths = resolveBoxPaths(process.cwd());
      const snapshots = await listSnapshots(paths);
      res.json({ snapshots });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/box/snap", async (req: Request, res: Response) => {
    if (!isBoxMutatingAllowed(req)) {
      res.status(403).json({ error: "box snap is localhost-only" });
      return;
    }
    try {
      const paths = resolveBoxPaths(process.cwd());
      const label = typeof req.body?.label === "string" ? req.body.label : undefined;
      const includeGbrain = Boolean(req.body?.includeGbrain);
      const shared = Boolean(req.body?.shared);
      const result = await createSnapshot(paths, { label, includeGbrain, shared });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/box/restore", async (req: Request, res: Response) => {
    if (!isBoxMutatingAllowed(req)) {
      res.status(403).json({ error: "box restore is localhost-only" });
      return;
    }
    const snapshotId = typeof req.body?.snapshotId === "string" ? req.body.snapshotId : "";
    if (!snapshotId) {
      res.status(400).json({ error: "snapshotId required" });
      return;
    }
    try {
      const paths = resolveBoxPaths(process.cwd());
      const sourceBoxId =
        typeof req.body?.sourceBoxId === "string" ? req.body.sourceBoxId : undefined;
      await restoreSnapshot(paths, snapshotId, { sourceBoxId });
      factoryApplySoft(paths);
      res.json({ ok: true, snapshotId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/box/factory-apply", (_req: Request, res: Response) => {
    try {
      const paths = resolveBoxPaths(process.cwd());
      const result = factoryApplySoft(paths);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/box/factory-reset", async (req: Request, res: Response) => {
    if (!isBoxMutatingAllowed(req)) {
      res.status(403).json({ error: "box factory-reset is localhost-only" });
      return;
    }
    const mode = req.body?.mode === "hard" ? "hard" : "soft";
    if (mode === "hard" && req.body?.confirm !== true) {
      res.status(400).json({ error: "hard factory-reset requires confirm: true" });
      return;
    }
    try {
      const paths = resolveBoxPaths(process.cwd());
      let removed: string[] = [];
      let preflight: Awaited<ReturnType<typeof runHardResetPreflight>> | undefined;
      let postReset: Awaited<ReturnType<typeof runHardResetPostSteps>> | undefined;
      if (mode === "hard") {
        preflight = await runHardResetPreflight(paths);
        if (!preflight.ok && !preflight.skipped) {
          throw new Error(
            `Composio disconnect failed: ${preflight.error ?? preflight.errors?.join("; ") ?? "unknown"}`,
          );
        }
        const stopped = await stopGbrainStack(process.cwd(), paths.gbrainHome);
        if (!stopped.ok) {
          throw new Error(stopped.error ?? "failed to stop gbrain before factory wipe");
        }
        removed = factoryWipePersonal(paths, paths.factoryManifest);
        writeDefaultIdentity(paths, paths.factoryManifest);
        postReset = await runHardResetPostSteps(paths);
        if (!postReset.desktop.ok) {
          throw new Error(postReset.desktop.error ?? "failed to restore factory desktop shortcuts");
        }
      }
      const applied = factoryApplySoft(paths);
      if (mode === "hard" && deps?.onHardResetComplete) {
        void Promise.resolve(deps.onHardResetComplete()).catch((err: unknown) => {
          console.warn(
            `[box-state] Hermes resync after hard reset failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      res.json({ ok: true, mode, removed, preflight, postReset, ...applied });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
