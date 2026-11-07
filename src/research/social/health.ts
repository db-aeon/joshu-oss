/**
 * The health of the social sources for `GET /api/instance/health` (key `components.last30days`,
 * kept for the fleet scripts). It reports how the box reaches the content router (change
 * content-router). A box without the content router is still healthy: the social sources are
 * optional, and a run names each social source as "could not be reached".
 */

import { resolveRouterAuth } from "../../contentRouter/client.js";
import { getMeteredProviderDefinition, resolveMeteredProviderMode, type MeteredProviderMode } from "../../meteredProviders/config.js";
import { socialGoalKinds } from "./sources.js";

export type SocialSourcesHealth = {
  ok: true;
  router: { mode: MeteredProviderMode; configured: boolean; kind?: "agent token" | "router API key"; reason?: string };
  /** The social sources that this box can search. */
  sources: string[];
};

export function socialSourcesHealth(projectRoot = process.cwd()): SocialSourcesHealth {
  const def = getMeteredProviderDefinition("router");
  const mode = def ? resolveMeteredProviderMode(def) : "off";
  const resolved = resolveRouterAuth(projectRoot);
  return {
    ok: true,
    router: resolved.auth ? { mode, configured: true, kind: resolved.auth.kind } : { mode, configured: false, reason: resolved.reason },
    sources: resolved.auth ? socialGoalKinds({ projectRoot }).map((g) => g.id) : [],
  };
}
