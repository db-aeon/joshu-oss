/**
 * Convention-based invoke handlers from joshu.app.json agent.actions[] → apiPrefix REST.
 * Explicit registerAppAction() handlers always win (jmail syncMirror, etc.).
 */

import type { JoshuAppManifest } from "@joshu/app-sdk";

import {
  getAppActionHandler,
  hasAppActionHandler,
  loadAppManifests,
  registerAppAction,
} from "./appRegistry.js";

/** Convention actions that read with GET; every other action POSTs its args as JSON. */
const GET_ACTIONS = new Set(["status", "config"]);

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function apiPathFromManifest(manifest: JoshuAppManifest, action: string): string {
  const prefix = readString(manifest.apiPrefix) || `/joshu/api/${manifest.id}`;
  const base = prefix.replace(/\/+$/, "");
  return `${base}/${action}`;
}

async function joshuFetch(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      body && typeof body.error === "string"
        ? body.error
        : `Request failed: ${res.status}`,
    );
  }
  return { status: res.status, body };
}

function createProxyHandler(
  manifest: JoshuAppManifest,
  action: string,
  boxOrigin: string,
): (args: Record<string, unknown>) => Promise<unknown> {
  const url = `${boxOrigin}${apiPathFromManifest(manifest, action)}`;
  const isGet = GET_ACTIONS.has(action);

  return async (args) => {
    if (isGet) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (value != null && value !== "") query.set(key, String(value));
      }
      const qs = query.toString();
      const { body } = await joshuFetch(qs ? `${url}?${qs}` : url, { cache: "no-store" });
      return body;
    }

    const { body } = await joshuFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    return body;
  };
}

/** Register default invoke proxies for manifests that declare agent.actions without explicit handlers. */
export async function registerManifestInvokeHandlers(
  projectRoot: string,
  boxOrigin = "http://127.0.0.1:8788",
): Promise<number> {
  await loadAppManifests(projectRoot);
  let registered = 0;

  for (const manifest of [...(await loadAppManifests(projectRoot)).values()]) {
    const actions = manifest.agent?.actions ?? [];
    if (!actions.length) continue;
    if (!readString(manifest.apiPrefix) && !manifest.id) continue;

    for (const actionDef of actions) {
      const action = readString(actionDef.name);
      if (!action) continue;
      if (hasAppActionHandler(manifest.id, action)) continue;

      registerAppAction(manifest.id, action, createProxyHandler(manifest, action, boxOrigin));
      registered += 1;
    }
  }

  return registered;
}

/** Test helper — resolve handler after manifest registration. */
export function resolveInvokeHandlerForTest(appId: string, action: string) {
  return getAppActionHandler(appId, action);
}
