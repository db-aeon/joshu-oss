/**
 * Discover Joshu app manifests from arozos/subservice/<app>/joshu.app.json
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { JoshuAppManifest } from "@joshu/app-sdk";

export type { JoshuAppManifest };

export type AppActionHandler = (args: Record<string, unknown>) => Promise<unknown>;

const manifestCache = new Map<string, JoshuAppManifest>();
const actionHandlers = new Map<string, Map<string, AppActionHandler>>();

export function registerAppAction(appId: string, action: string, handler: AppActionHandler): void {
  if (!actionHandlers.has(appId)) actionHandlers.set(appId, new Map());
  actionHandlers.get(appId)!.set(action, handler);
}

export function getAppActionHandler(appId: string, action: string): AppActionHandler | undefined {
  return actionHandlers.get(appId)?.get(action);
}

export async function loadAppManifests(projectRoot: string): Promise<Map<string, JoshuAppManifest>> {
  manifestCache.clear();
  const subRoot = path.join(projectRoot, "arozos", "subservice");
  let entries: string[];
  try {
    entries = await readdir(subRoot);
  } catch {
    return manifestCache;
  }
  for (const dir of entries) {
    const manifestPath = path.join(subRoot, dir, "joshu.app.json");
    try {
      const raw = await readFile(manifestPath, "utf8");
      const doc = JSON.parse(raw) as JoshuAppManifest;
      if (doc.id) manifestCache.set(doc.id, doc);
    } catch {
      /* skip dirs without manifest */
    }
  }
  return manifestCache;
}

export function getAppManifest(appId: string): JoshuAppManifest | undefined {
  return manifestCache.get(appId);
}

export function listAppManifests(): JoshuAppManifest[] {
  return [...manifestCache.values()];
}

export function collectAppSkillNames(): string[] {
  const names = new Set<string>();
  for (const m of manifestCache.values()) {
    if (m.agent?.skill) names.add(m.agent.skill);
  }
  return [...names];
}
