import type { Request, Response, Router } from "express";
import type { HermesApiRunner } from "../hermesApi.js";
import { syncHermesLlmEnv } from "../hermesApi.js";
import {
  BOX_SECRETS_UI_KEYS,
  readBoxSecretsOverrides,
  writeBoxSecretsOverrides,
  type BoxSecretsUiKey,
} from "./localEnv.js";
import { isProvisionLockedSecret, readBoxSecretsStatus } from "./resolve.js";

function readUpdateBody(body: unknown): Partial<Record<BoxSecretsUiKey, string>> | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const out: Partial<Record<BoxSecretsUiKey, string>> = {};
  for (const key of BOX_SECRETS_UI_KEYS) {
    const raw = o[key];
    if (typeof raw === "string" && raw.trim()) out[key] = raw.trim();
  }
  if (!out.OPENROUTER_API_KEY && !out.GEMINI_API_KEY) return null;
  if (out.OPENROUTER_API_KEY && !out.HINDSIGHT_API_LLM_API_KEY) {
    out.HINDSIGHT_API_LLM_API_KEY = out.OPENROUTER_API_KEY;
  }
  return out;
}

export function registerBoxSecretsRoutes(
  router: Router,
  opts: { projectRoot: string; runner?: HermesApiRunner },
): void {
  const { projectRoot, runner } = opts;

  router.get("/api/box-secrets/status", (_req: Request, res: Response) => {
    try {
      res.json(readBoxSecretsStatus(projectRoot));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/api/box-secrets", async (req: Request, res: Response) => {
    const updates = readUpdateBody(req.body);
    if (!updates) {
      res.status(400).json({ error: "OPENROUTER_API_KEY or GEMINI_API_KEY required" });
      return;
    }
    for (const key of BOX_SECRETS_UI_KEYS) {
      if (updates[key] && isProvisionLockedSecret(key)) {
        res.status(403).json({
          error: `${key} is managed by provisioning and cannot be changed in Welcome`,
        });
        return;
      }
    }
    try {
      writeBoxSecretsOverrides(updates, projectRoot);
      await syncHermesLlmEnv(projectRoot);
      let gateway = runner ? await runner.getGatewayStatus().catch(() => null) : null;
      if (runner) {
        gateway = await runner.restartGateway(projectRoot);
      }
      res.json({
        ok: true,
        status: readBoxSecretsStatus(projectRoot),
        gateway,
        message: updates.GEMINI_API_KEY
          ? "AI keys saved. Voice uses Gemini Live when the voice container is running."
          : "AI keys saved. Hermes gateway restarted.",
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/box-secrets/local", (_req: Request, res: Response) => {
    try {
      const local = readBoxSecretsOverrides(projectRoot);
      res.json({
        openRouterConfigured: Boolean(local.OPENROUTER_API_KEY),
        geminiConfigured: Boolean(local.GEMINI_API_KEY),
        // Never return secret values — UI uses password fields only.
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
