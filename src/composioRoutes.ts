/**
 * @deprecated Composio routes moved to /api/connectors/composio — kept for jChat backward compat.
 */
import type { Router } from "express";
import type { HermesApiRunner } from "./hermesApi.js";
import { registerLegacyHermesComposioRoutes } from "./connectors/composioRoutes.js";

export function registerComposioRoutes(
  router: Router,
  opts: { projectRoot: string; runner: HermesApiRunner },
): void {
  registerLegacyHermesComposioRoutes(router, opts);
}
