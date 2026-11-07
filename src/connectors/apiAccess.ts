/**
 * Access gate of the connectors, Nylas, and onboarding routes (spec connectors-api-access).
 * Caddy sends each /joshu/* request from the internet to the Joshu API, so these routes
 * need the desktop session of the owner or a direct localhost request. The connectors MCP,
 * the Composio MCP guard, app invoke, and Hermes call over localhost; the browser apps
 * send the desktop session.
 */
import type { NextFunction, Request, Response, Router } from "express";
import { verifyArozosDesktopSession } from "../httpLocalhost.js";
import type { NylasAgentRecord } from "../nylas/store.js";

export const CONNECTORS_API_GATED_PREFIXES = ["/api/connectors", "/api/nylas", "/api/onboarding"];

/** The control plane pushes the companion grant here over HTTPS; see companionGrantPushAllowed. */
export const COMPANION_GRANT_IMPORT_PATH = "/api/nylas/agent/import";

export type ConnectorsApiAccessDeps = {
  allowRequest?: (req: Request) => Promise<boolean>;
};

function isCompanionGrantImport(req: Request): boolean {
  // baseUrl holds the public base (/joshu) and the matched prefix.
  return req.method === "POST" && (req.baseUrl + req.path).replace(/\/+$/, "").endsWith(COMPANION_GRANT_IMPORT_PATH);
}

/** Mount before the first route under a gated prefix. */
export function registerConnectorsApiAccess(router: Router, deps: ConnectorsApiAccessDeps = {}): void {
  const allowed = deps.allowRequest ?? verifyArozosDesktopSession;
  router.use(CONNECTORS_API_GATED_PREFIXES, async (req: Request, res: Response, next: NextFunction) => {
    if (isCompanionGrantImport(req)) return next();
    if (await allowed(req)) return next();
    res.status(401).json({ error: "desktop_session_required" });
  });
}

/**
 * A pushed companion grant is saved only when the box has none, or when it is the same grant.
 * Another grant would point the box at a different mailbox.
 */
export function companionGrantPushAllowed(
  saved: Pick<NylasAgentRecord, "grantId" | "email"> | null,
  pushed: { grantId: string; email: string },
): boolean {
  if (!saved?.grantId) return true;
  return (
    saved.grantId === pushed.grantId &&
    saved.email.trim().toLowerCase() === pushed.email.trim().toLowerCase()
  );
}
