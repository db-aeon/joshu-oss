import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_JOSHU_IDENTITY,
  resolveJoshuIdentity,
  writeJoshuIdentity,
} from "../joshuIdentity.js";
import { normalizeIanaTimezone } from "../ianaTimezone.js";
import { joshuConfigDir } from "./paths.js";

export interface NylasAgentProfile {
  ownerName?: string;
  assistantName?: string;
  assistantEmail?: string;
  primaryWorkEmail?: string;
  personalEmail?: string;
  timezone?: string;
  targetMarket?: string;
  targetGeography?: string;
  /** EA dial: handle purchases below this without surfacing. */
  spendingThreshold?: string;
  /** EA dial: channel for true interrupts. */
  urgentChannel?: string;
  workingHoursStart?: string;
  workingHoursEnd?: string;
}

function profileFile(projectRoot: string): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, "nylas", "profile.json");
}

function readProfileFile(projectRoot: string): NylasAgentProfile | null {
  const file = profileFile(projectRoot);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as NylasAgentProfile;
  } catch {
    return null;
  }
}

/** EA profile merged with platform identity (name / owner). */
export function readAgentProfile(projectRoot = process.cwd()): NylasAgentProfile | null {
  const identity = resolveJoshuIdentity(projectRoot);
  const fromFile = readProfileFile(projectRoot);
  if (!fromFile && !identity) return null;
  return {
    ...fromFile,
    ownerName: fromFile?.ownerName ?? identity.owner.displayName,
    assistantName: fromFile?.assistantName ?? identity.name,
  };
}

export function updateAgentProfile(fields: NylasAgentProfile, projectRoot = process.cwd()): boolean {
  const file = profileFile(projectRoot);
  if (!file) return false;
  const existing = readProfileFile(projectRoot) ?? {};
  const merged: NylasAgentProfile = { ...existing };
  for (const [key, value] of Object.entries(fields) as [keyof NylasAgentProfile, string | undefined][]) {
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      merged[key] = key === "timezone" ? normalizeIanaTimezone(trimmed) : trimmed;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });

  const identityPatch: Parameters<typeof writeJoshuIdentity>[0] = { source: "local" };
  if (merged.assistantName) identityPatch.name = merged.assistantName;
  if (merged.ownerName) identityPatch.owner = { displayName: merged.ownerName };
  writeJoshuIdentity(identityPatch, projectRoot);

  return true;
}

export const DEFAULT_ASSISTANT_NAME = DEFAULT_JOSHU_IDENTITY.name;
export const DEFAULT_OWNER_NAME = DEFAULT_JOSHU_IDENTITY.owner.displayName;
